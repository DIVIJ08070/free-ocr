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
  // `model` = vision model (image path); `textModel` = cheap text model used to
  // map already-OCR'd text → fields (no image tokens, ~5× cheaper).
  if (process.env.GROQ_API_KEY) {
    return { name: "groq", kind: "openai", apiKey: process.env.GROQ_API_KEY,
      baseURL: "https://api.groq.com/openai/v1",
      model: process.env.GROQ_MODEL || "meta-llama/llama-4-scout-17b-16e-instruct",
      textModel: process.env.GROQ_TEXT_MODEL || "llama-3.3-70b-versatile" };
  }
  if (process.env.XAI_API_KEY) {
    return { name: "xai", kind: "openai", apiKey: process.env.XAI_API_KEY,
      baseURL: "https://api.x.ai/v1",
      model: process.env.XAI_MODEL || "grok-2-vision-1212",
      textModel: process.env.XAI_TEXT_MODEL || "grok-2-1212" };
  }
  if (process.env.OPENAI_API_KEY) {
    return { name: "openai", kind: "openai", apiKey: process.env.OPENAI_API_KEY,
      baseURL: undefined,
      model: process.env.OPENAI_MODEL || "gpt-4o",
      textModel: process.env.OPENAI_TEXT_MODEL || "gpt-4o-mini" };
  }
  if (process.env.ANTHROPIC_API_KEY) {
    return { name: "anthropic", kind: "anthropic", apiKey: process.env.ANTHROPIC_API_KEY,
      model: process.env.ANTHROPIC_MODEL || "claude-opus-4-8",
      textModel: process.env.ANTHROPIC_TEXT_MODEL || "claude-haiku-4-5" };
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

// ── Text mapping (cheap) ─────────────────────────────────────────────────────
// Map the already-OCR'd card text → structured fields with a small TEXT model.
// No image is sent, so it's ~5× cheaper than the vision path and just as good
// once the OCR text is clean (which PaddleOCR gives us).
// The AI returns ONE `name` field; we split it into first/last deterministically.
const MAP_FIELDS = ["name", "company", "designation", "email", "phone", "whatsapp", "website", "linkedin", "instagram", "youtube", "facebook", "address"];

const HONOR = /^(?:dr|mr|mrs|ms|miss|prof|sri|smt|shri|er|adv|ca)\.?$/i;
function splitFullName(name) {
  let parts = String(name || "").trim().split(/\s+/).filter(Boolean).filter((p) => !HONOR.test(p));
  // drop trailing ALL-CAPS badge/acronym tokens (BNI, ISO) on an otherwise title-case name
  if (parts.some((p) => /^[A-Z][a-z]/.test(p))) {
    while (parts.length > 1 && /^[A-Z]{2,5}$/.test(parts[parts.length - 1])) parts.pop();
  }
  if (!parts.length) return { first: "", last: "" };
  if (parts.length === 1) return { first: parts[0], last: "" };
  return { first: parts[0], last: parts.slice(1).join(" ") };
}

const MAP_SYSTEM =
  "You convert the raw OCR text of a business card into a structured JSON contact record. " +
  "name = the cardholder's FULL personal name (given name + surname) exactly as a person's name — NOT a company, brand, logo, or job title. " +
  "The name almost always matches the email address — e.g. 'goelmudit@kkhavo.com' corresponds to 'Mudit Goel'. " +
  "Use the email to find and confirm the correct name in the text, even if it's buried mid-line. " +
  "IGNORE handwritten notes, logos, brand wordmarks, and slogans; a name-like line unrelated to the email/contacts is likely a stray note. " +
  "Strip honorifics (Dr/Mr/Mrs/Ms/Shri) from name. Do not include membership badges (BNI, Rotary, Lions Club, ISO) in the name or designation. " +
  "designation = the person's job title — set it ONLY if the line is clearly a standard job title " +
  '(Manager, Engineer, Director, Founder, CEO, Stylist, etc.). If a line is garbled, ambiguous, or not clearly a title, leave designation "". ' +
  "company = the business name (prefer a full legal name or the main brand), not the person. " +
  "Operating hours/timings, appointment instructions, addresses, and taglines are NOT the company. " +
  "Keep phone numbers with their country code. website = the web address, not an email. " +
  "instagram/youtube/facebook/linkedin = the handle or URL if present. " +
  "If a website is just the email's domain with an obvious OCR typo, output the clean email domain instead. " +
  "Fix an obvious OCR typo in an email or URL ONLY when unambiguous (e.g. from the email's domain). " +
  "Respond ONLY with a JSON object with these keys: " + MAP_FIELDS.join(", ") +
  ', confidence (one of "high","medium","low"), and extras. ' +
  'extras = an array of {"label": string, "value": string} objects capturing any OTHER useful detail on the card ' +
  "(opening hours/timings, tagline, services offered, memberships like BNI, awards, extra social handles, review links); use [] if none. " +
  "Every extras item MUST have a non-empty label AND a non-empty value. Use an empty string for any absent top-level field. No markdown, no commentary.";

// normalize() + deterministic name split → final record.
function finalizeMap(data, p, usage) {
  const out = normalize(data, { ...p, model: p.textModel }, usage);
  const { first, last } = splitFullName(data && data.name);
  out.first_name = first;
  out.last_name = last;
  out.source = "ai-map";
  return out;
}

async function mapViaOpenAI(p, text) {
  const { default: OpenAI } = await import("openai");
  const client = new OpenAI({ apiKey: p.apiKey, baseURL: p.baseURL });
  const res = await client.chat.completions.create({
    model: p.textModel,
    max_tokens: 800,
    temperature: 0,
    response_format: { type: "json_object" },
    messages: [
      { role: "system", content: MAP_SYSTEM },
      { role: "user", content: "OCR text from the card:\n" + text },
    ],
  });
  const data = parseLoose(res.choices[0].message.content);
  return finalizeMap(data, p, res.usage && { input: res.usage.prompt_tokens, output: res.usage.completion_tokens });
}

async function mapViaAnthropic(p, text) {
  const { default: Anthropic } = await import("@anthropic-ai/sdk");
  const client = new Anthropic({ apiKey: p.apiKey });
  const res = await client.messages.create({
    model: p.textModel,
    max_tokens: 800,
    system: MAP_SYSTEM,
    messages: [{ role: "user", content: "OCR text from the card:\n" + text }],
  });
  const block = res.content.find((b) => b.type === "text");
  const data = parseLoose(block ? block.text : "");
  return finalizeMap(data, p, res.usage && { input: res.usage.input_tokens, output: res.usage.output_tokens });
}

export async function mapCardWithAI(text) {
  const p = aiProvider();
  if (!p) throw new Error("No AI key set — add GROQ_API_KEY (or XAI / OPENAI / ANTHROPIC) to .env");
  if (!text || !text.trim()) throw new Error("no OCR text to map");
  return p.kind === "anthropic" ? mapViaAnthropic(p, text) : mapViaOpenAI(p, text);
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
