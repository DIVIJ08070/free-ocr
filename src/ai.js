// AI fallback for business-card extraction — provider-agnostic.
// Auto-detects whichever API key is present and uses that provider's vision
// model to read the card into our exact JSON fields. Only ever called when the
// local OCR result is weak (see server.js), so cost stays minimal.
//
// Supported (first key found wins):
//   GROQ_API_KEY      → Groq (free tier), OpenAI-compatible      (api.groq.com/openai/v1)
//   XAI_API_KEY       → Grok (xAI), OpenAI-compatible endpoint   (api.x.ai/v1)
//   OPENAI_API_KEY    → OpenAI (GPT-4o vision)
//   ANTHROPIC_API_KEY → Claude (Opus 4.8)
// Model is overridable via GROQ_MODEL / XAI_MODEL / OPENAI_MODEL / ANTHROPIC_MODEL.

import sharp from "sharp";

const FIELDS = [
  "first_name", "last_name", "company", "designation", "email",
  "phone", "whatsapp", "website", "linkedin", "instagram", "youtube", "facebook", "address",
];

const SYSTEM =
  "You extract structured contact details from a photo of a business card. " +
  "Return values exactly as printed; use an empty string for any field not present — never guess or hallucinate. " +
  "Extract the CARDHOLDER's own details — ignore names in testimonials, reviews, or photos. " +
  "If the card is bilingual or in another script, still pull the Latin-script contact info. " +
  "Keep phone numbers with their country code and digits intact. " +
  "Do NOT put slogans, taglines, opening hours, or service lists in the core fields — those go in 'extras'. " +
  "designation = job title (include degrees like MD/MBA if shown). phone = the main phone; whatsapp only if the card marks one. " +
  "website = the company web address (not an email). " +
  'Respond ONLY with a JSON object with these keys: ' +
  FIELDS.join(", ") +
  ', confidence (one of "high","medium","low"), and extras. ' +
  'instagram/youtube/facebook = the handle or URL if present. ' +
  '"extras" is an array of {label, value} objects capturing any OTHER useful detail on the card ' +
  "(clinic/working hours, tagline, services offered, memberships, awards, extra handles) — use [] if none. " +
  "Output ONLY the raw JSON object — no markdown code fences, no commentary before or after.";

const PROMPT =
  "The image(s) below are different sides/photos of the SAME business card. " +
  "Combine them into ONE contact and extract the fields as JSON.";

// Parse a model's reply into an object, tolerating code fences, surrounding
// prose, or a truncated tail — never throws.
function parseLoose(s) {
  if (!s) return {};
  let t = String(s).replace(/```(?:json)?/gi, "").trim();
  const a = t.indexOf("{");
  const b = t.lastIndexOf("}");
  if (a !== -1 && b > a) t = t.slice(a, b + 1);
  try {
    return JSON.parse(t);
  } catch {
    return {};
  }
}

// Pick the active provider from env (first key present wins).
export function aiProvider() {
  if (process.env.GROQ_API_KEY) {
    return { name: "groq", kind: "openai", apiKey: process.env.GROQ_API_KEY,
      baseURL: "https://api.groq.com/openai/v1", model: process.env.GROQ_MODEL || "meta-llama/llama-4-scout-17b-16e-instruct" };
  }
  if (process.env.XAI_API_KEY) {
    return { name: "xai", kind: "openai", apiKey: process.env.XAI_API_KEY,
      baseURL: "https://api.x.ai/v1", model: process.env.XAI_MODEL || "grok-2-vision-1212" };
  }
  if (process.env.OPENAI_API_KEY) {
    return { name: "openai", kind: "openai", apiKey: process.env.OPENAI_API_KEY,
      baseURL: undefined, model: process.env.OPENAI_MODEL || "gpt-4o" };
  }
  if (process.env.ANTHROPIC_API_KEY) {
    return { name: "anthropic", kind: "anthropic", apiKey: process.env.ANTHROPIC_API_KEY,
      model: process.env.ANTHROPIC_MODEL || "claude-opus-4-8" };
  }
  return null;
}

export function aiAvailable() {
  return Boolean(aiProvider());
}

function normalize(obj, provider, usage) {
  const out = { source: "ai", provider: provider.name, model: provider.model };
  for (const k of FIELDS) out[k] = typeof obj?.[k] === "string" ? obj[k].trim() : "";
  out.confidence = ["high", "medium", "low"].includes(obj?.confidence) ? obj.confidence : "medium";
  out.extras = Array.isArray(obj?.extras)
    ? obj.extras
        .filter((e) => e && e.label && e.value)
        .map((e) => ({ label: String(e.label).trim(), value: String(e.value).trim() }))
        .slice(0, 12)
    : [];
  if (usage) out.tokens = usage;
  return out;
}

async function toJpegB64(buffer) {
  const jpeg = await sharp(buffer)
    .rotate()
    .resize({ width: 1400, height: 1400, fit: "inside", withoutEnlargement: true })
    .jpeg({ quality: 85 })
    .toBuffer();
  return jpeg.toString("base64");
}

// --- OpenAI-compatible path (covers OpenAI and xAI/Grok/Groq) ---
async function viaOpenAI(p, b64s) {
  const { default: OpenAI } = await import("openai");
  const client = new OpenAI({ apiKey: p.apiKey, baseURL: p.baseURL });
  const res = await client.chat.completions.create({
    model: p.model,
    max_tokens: 2048,
    response_format: { type: "json_object" },
    messages: [
      { role: "system", content: SYSTEM },
      {
        role: "user",
        content: [
          { type: "text", text: PROMPT },
          ...b64s.map((b) => ({ type: "image_url", image_url: { url: `data:image/jpeg;base64,${b}` } })),
        ],
      },
    ],
  });
  const data = parseLoose(res.choices[0].message.content);
  return normalize(data, p, res.usage && { input: res.usage.prompt_tokens, output: res.usage.completion_tokens });
}

// --- Anthropic (Claude) path with strict structured output ---
async function viaAnthropic(p, b64s) {
  const { default: Anthropic } = await import("@anthropic-ai/sdk");
  const client = new Anthropic({ apiKey: p.apiKey });
  const schema = {
    type: "object",
    properties: Object.fromEntries([
      ...FIELDS.map((k) => [k, { type: "string" }]),
      ["confidence", { type: "string", enum: ["high", "medium", "low"] }],
      ["extras", {
        type: "array",
        items: {
          type: "object",
          properties: { label: { type: "string" }, value: { type: "string" } },
          required: ["label", "value"],
          additionalProperties: false,
        },
      }],
    ]),
    required: [...FIELDS, "confidence", "extras"],
    additionalProperties: false,
  };
  const res = await client.messages.create({
    model: p.model,
    max_tokens: 2048,
    system: SYSTEM,
    messages: [
      {
        role: "user",
        content: [
          ...b64s.map((b) => ({ type: "image", source: { type: "base64", media_type: "image/jpeg", data: b } })),
          { type: "text", text: PROMPT },
        ],
      },
    ],
    output_config: { format: { type: "json_schema", schema } },
  });
  const block = res.content.find((b) => b.type === "text");
  const data = parseLoose(block ? block.text : "");
  return normalize(data, p, res.usage && { input: res.usage.input_tokens, output: res.usage.output_tokens });
}

// Accepts a single image buffer or an array of buffers (front/back/extra photos
// of the SAME card) — sent together so the model merges them into one contact.
export async function extractCardWithAI(input) {
  const p = aiProvider();
  if (!p) throw new Error("No AI key set — add GROQ_API_KEY, XAI_API_KEY, OPENAI_API_KEY, or ANTHROPIC_API_KEY to .env");
  const buffers = (Array.isArray(input) ? input : [input]).slice(0, 4); // cap to 4 images
  const b64s = await Promise.all(buffers.map(toJpegB64));
  return p.kind === "anthropic" ? viaAnthropic(p, b64s) : viaOpenAI(p, b64s);
}
