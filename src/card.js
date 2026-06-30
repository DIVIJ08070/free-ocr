// Business-card field extraction from OCR text (the free, local path).
// Easy fields (email/phone/website/linkedin) are reliable via regex; name /
// company / designation / address are best-effort heuristics — the Hybrid (AI)
// mode is there for when these need to be accurate.

const DESIGNATION_WORDS =
  /\b(?:CEO|CTO|CFO|COO|CMO|President|Vice President|VP|Founder|Co-?Founder|Director|Manager|Head|Lead|Chief|Officer|Engineer|Developer|Designer|Architect|Consultant|Analyst|Executive|Specialist|Administrator|Coordinator|Owner|Partner|Principal|Associate|Supervisor|Strategist|Marketing|Sales|Accountant|Advocate|Physician|Surgeon|Dentist|Physiotherapist|Nutritionist|Dietici?an|Therapist|Counsell?or|Coach|Trainer|Pharmacist|Professor|Proprietor|Freelancer|Intern|MBBS|BDS|BHMS|BAMS|MD|MS|MBA|BBA|PhD|B\.?Tech|M\.?Tech|B\.?Com|M\.?Com|CA|CS|LLB|LLM|B\.?Sc|M\.?Sc)\b/i;

const COMPANY_WORDS =
  /\b(?:Inc|Incorporated|LLC|Ltd|Limited|Pvt|Private|Corp|Corporation|Company|Co(?![-A-Za-z])|GmbH|AG|PLC|LLP|Oy|Srl|Pte|Sdn|Bhd|Technologies|Technology|Solutions|Systems|Services|Software|Labs|Studio|Studios|Group|Enterprises|Industries|Consulting|Global|International|Ventures|Partners|Associates|Agency|Media|Digital|Networks|Foundation|Clinic|Hospital|Centre|Center|Academy|Institute|Fitness|Gym|Salon|Spa|Cafe|Restaurant|Hotel|Builders|Constructions|Traders|Trading|Motors|Pharma|Pharmacy|Healthcare|Wellness|Kranti)\b/i;

// Legal-entity suffixes — an unambiguous "this line IS the company" signal that
// overrides a stray title word (e.g. "Müller & Partner GmbH" → company, not title).
// "Co" requires it not be "Co-founder"/"Company".
const COMPANY_SUFFIX =
  /\b(?:Inc|Incorporated|LLC|Ltd|Limited|Pvt|Private|Corp|Corporation|Co(?![-A-Za-z])|GmbH|AG|PLC|LLP|Oy|Srl|Pte|Sdn|Bhd)\b/i;

// Honorifics to strip from a name (kept out of first/last name).
const HONORIFIC = /^(?:dr|mr|mrs|ms|miss|prof|sri|smt|shri|er|adv|ca)\.?$/i;
// A name word: Title-case, ALL-CAPS, a single initial, or an honorific.
const NAME_WORD = (w) =>
  HONORIFIC.test(w) || /^[A-Z][a-zA-Z.'’-]+$/.test(w) || /^[A-Z]{2,}\.?$/.test(w) || /^[A-Z]\.?$/.test(w);

function firstMatch(text, re) {
  const m = text.match(re);
  return m ? (m[1] || m[0]).trim() : "";
}

function extractEmail(text) {
  return firstMatch(text, /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/);
}

function socialUrl(text, re) {
  const m = text.match(re);
  return m ? m[0].replace(/^https?:\/\//i, "").replace(/^www\./i, "").replace(/[).,]+$/, "") : "";
}
const extractInstagram = (t) => socialUrl(t, /(?:https?:\/\/)?(?:www\.)?instagram\.com\/[A-Za-z0-9._]+/i);
const extractYoutube = (t) => socialUrl(t, /(?:https?:\/\/)?(?:www\.)?(?:youtube\.com|youtu\.be)\/[A-Za-z0-9._@/-]+/i);
const extractFacebook = (t) => socialUrl(t, /(?:https?:\/\/)?(?:www\.)?(?:facebook\.com|fb\.com)\/[A-Za-z0-9._/-]+/i);

function extractLinkedin(text) {
  const m = text.match(/((?:https?:\/\/)?(?:www\.)?linkedin\.com\/(?:in|company|pub)\/[A-Za-z0-9_%-]+)/i);
  if (m) return m[1].replace(/^https?:\/\//, "");
  // bare handle like "in/john-doe"
  const h = text.match(/\bin\/([A-Za-z0-9_-]{3,})\b/);
  return h ? `linkedin.com/in/${h[1]}` : "";
}

function extractWebsite(text, email) {
  const emailDomain = email.includes("@") ? email.split("@")[1].toLowerCase() : "";
  const re = /\b((?:https?:\/\/)?(?:www\.)?[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+(?:\/[^\s]*)?)\b/g;
  for (const m of text.matchAll(re)) {
    let url = m[1];
    if (/@/.test(url)) continue;
    if (/linkedin\.com|facebook\.com|twitter\.com|instagram\.com|youtube\.com|youtu\.be|wa\.me/i.test(url)) continue;
    const bare = url.replace(/^https?:\/\//, "").replace(/^www\./, "").toLowerCase();
    if (bare.split("/")[0] === emailDomain) return bare.replace(/\/$/, ""); // company site == email domain
    // require a known-ish TLD to avoid matching "Dum.Dum" style noise
    if (/\.(com|net|org|io|co|in|dev|app|biz|info|tech|me|ai|us|uk|ca)\b/i.test(url)) {
      return bare.replace(/\/$/, "");
    }
  }
  // fall back to the email domain as the website
  return emailDomain && !/(gmail|yahoo|outlook|hotmail|icloud|proton)\./i.test(emailDomain)
    ? emailDomain
    : "";
}

function extractPhones(text) {
  const out = [];
  const re = /(?:(?:\+|00)\d{1,3}[\s-]?)?(?:\(?\d{2,4}\)?[\s-]?){2,5}\d{2,4}/g;
  for (const m of text.matchAll(re)) {
    const digits = m[0].replace(/\D/g, "");
    if (digits.length >= 8 && digits.length <= 15) out.push(m[0].trim());
  }
  return [...new Set(out)];
}

function extractWhatsapp(text, phones) {
  const wa = text.match(/wa\.me\/(\+?\d[\d]{7,14})/i);
  if (wa) return wa[1];
  // a phone on/after a line mentioning WhatsApp
  const lines = text.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    if (/whats\s*app|whatsapp|w\.app/i.test(lines[i])) {
      const here = lines[i].match(/(?:\+|00)?\d[\d\s-]{7,}\d/);
      if (here) return here[0].trim();
      const next = (lines[i + 1] || "").match(/(?:\+|00)?\d[\d\s-]{7,}\d/);
      if (next) return next[0].trim();
    }
  }
  return "";
}

function extractName(lines) {
  // The person's name: the first line that passes the strict personal-name test
  // (rejects logos like "YOS", taglines like "THE INDIAN YOGA SHOP", companies,
  // titles, and contacts) — same rule the geometry path uses, for consistency.
  for (const raw of lines) {
    const line = raw.trim().replace(/[•|·,]+$/, "").trim();
    if (line && looksName(line)) return line;
  }
  return "";
}

function splitName(name) {
  let parts = name.split(/\s+/).filter(Boolean).filter((p) => !HONORIFIC.test(p));
  // Drop trailing ALL-CAPS acronym/badge tokens (BNI, ISO, MBA) when the name is
  // otherwise title-case — they're membership/qualification badges, not a surname.
  // (Keep real initials like "V." and all-caps names like "MUDIT GOEL".)
  if (parts.some((p) => /^[A-Z][a-z]/.test(p))) {
    while (parts.length > 1 && /^[A-Z]{2,5}$/.test(parts[parts.length - 1])) parts.pop();
  }
  if (parts.length === 0) return { firstName: "", lastName: "" };
  if (parts.length === 1) return { firstName: parts[0], lastName: "" };
  return { firstName: parts[0], lastName: parts.slice(1).join(" ") };
}

// Operating-hours, instruction, and long-sentence lines are never the company —
// e.g. "Time: 10:00 am - 1:00 pm ... (Clinic Visit)" trips the "Clinic" keyword.
const NOT_COMPANY = (t) =>
  /\b\d{1,2}[:.]\d{2}\s*(?:[ap]\.?m)\b/i.test(t) ||                  // a clock time → hours line
  /^\s*(?:time|timing|hours|mon|tue|wed|thu|fri|sat|sun)\b/i.test(t) ||
  /\bkindly\b|prior\s+appointment/i.test(t) ||
  t.split(/\s+/).filter(Boolean).length > 8;                        // long sentence/tagline

function extractCompany(lines, name) {
  // 1) A legal-entity suffix is authoritative — it's the company even if the line
  //    also contains a title word ("& Partner GmbH").
  for (const raw of lines) {
    const line = raw.trim();
    if (COMPANY_SUFFIX.test(line) && !/@/.test(line) && !NOT_COMPANY(line)) return line;
  }
  // 2) Otherwise a brand-keyword line that isn't itself a job title.
  for (const raw of lines) {
    const line = raw.trim();
    if (COMPANY_WORDS.test(line) && !DESIGNATION_WORDS.test(line) && !/@/.test(line) && !NOT_COMPANY(line)) return line;
  }
  // 2) Fallback: a prominent brand line — a short, mostly-letters line right
  //    around the name that isn't the name itself, a designation, or a contact.
  for (const raw of lines) {
    const line = raw.trim();
    if (!line || line === name) continue;
    if (DESIGNATION_WORDS.test(line)) continue;
    if (/[@]|www\.|\.com|http|\d{4,}/i.test(line)) continue;
    const words = line.split(/\s+/).filter(Boolean);
    const letters = line.replace(/[^A-Za-z]/g, "").length;
    // brand-ish: 1–5 words, enough letters, has a capital, not just one short word
    if (words.length >= 1 && words.length <= 5 && letters >= 4 && /[A-Z]/.test(line)) {
      // don't return a line that looks exactly like a person's name we'd pick
      if (line === name) continue;
      return line;
    }
  }
  return "";
}

function extractDesignation(lines) {
  for (const raw of lines) {
    const line = raw.trim().replace(/^[-–•*\s]+/, ""); // drop leading bullet/dash
    // a legal-entity suffix (e.g. "& Partner GmbH") outranks a title keyword ("Partner")
    if (DESIGNATION_WORDS.test(line) && !COMPANY_SUFFIX.test(line) && line.length <= 60 && !/@/.test(line)) return line;
  }
  return "";
}

function extractAddress(lines) {
  // Lines with a PIN/ZIP or street-ish keywords; skip phone/email/url/label and
  // marketing-sentence lines (a card tagline/SEO blurb is not an address).
  const STREET = /\b(?:street|st\.|road|rd\.?|lane|ln\.?|avenue|ave\.?|block|sector|floor|suite|near|opp\.?|building|plot|nagar|colony|chhaya|marg|district)\b/i;
  const PIN = /\b\d{5,6}\b/;
  const SKIP = /@|whats\s*app|whatsapp|\btel\b|phone|mobile|\bmob\b|fax|cell|www\.|https?:/i;
  const out = [];
  for (const raw of lines) {
    const l = raw.trim();
    if (SKIP.test(l)) continue;
    if (/^[\s+()\d.\-/]+$/.test(l)) continue;        // a pure number/punctuation line
    if (/[!?]/.test(l) || l.split(/\s+/).length > 9) continue; // marketing sentence, not an address
    if (STREET.test(l) || (PIN.test(l) && /[A-Za-z]{3,}/.test(l))) out.push(l);
  }
  return out
    .join(", ")
    .replace(/[\/|]+/g, " ")          // stray OCR slashes/pipes
    .replace(/\s*,\s*/g, ", ")
    .replace(/(?:,\s*)+/g, ", ")       // collapse repeated commas
    .replace(/\s{2,}/g, " ")
    .replace(/[\s,]+$/, "")
    .slice(0, 200);
}

export function extractCard(text) {
  const lines = text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  const email = extractEmail(text);
  const phones = extractPhones(text);
  const name = extractName(lines);
  const { firstName, lastName } = splitName(name);

  const rec = {
    first_name: firstName,
    last_name: lastName,
    company: extractCompany(lines, name),
    designation: extractDesignation(lines),
    email,
    phone: phones[0] || "",
    whatsapp: extractWhatsapp(text, phones),
    website: extractWebsite(text, email),
    linkedin: extractLinkedin(text),
    instagram: extractInstagram(text),
    youtube: extractYoutube(text),
    facebook: extractFacebook(text),
    address: extractAddress(lines),
    extras: [], // populated only by the AI path
    source: "local",
  };

  // Confidence: how many of the 4 core fields we found. "high" only when all
  // are present — that's the signal the AI fallback uses to decide to escalate.
  const coreKeys = ["first_name", "email", "phone", "company"];
  rec.missing_core = coreKeys.filter((k) => !rec[k]);
  const found = coreKeys.length - rec.missing_core.length;
  rec.confidence = found === 4 ? "high" : found >= 2 ? "medium" : "low";
  return rec;
}

// Local result is "weak" (worth an AI call) if any core field is missing or
// confidence is low.
export function localWeak(rec) {
  return (rec.missing_core && rec.missing_core.length > 0) || rec.confidence === "low";
}

// ── Layout-aware extraction ─────────────────────────────────────────────────
// When OCR gives us per-line geometry (font size via box height, position,
// confidence), we can assign name / company / designation by *prominence* rather
// than first-match. The person's name is almost always the largest non-contact
// text; the company is the largest line with a company word (or a big brand line).

const median = (a) => {
  if (!a.length) return 0;
  const s = [...a].sort((x, y) => x - y);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};
const CONTACTish = (t) => /[@]|www\.|https?:|\.com|\.in\b|\d{3,}/i.test(t);
// Social-platform labels printed beside QR codes — never a person's name.
const SOCIAL_LABEL = /^(?:you\s*tube|youtube|google(?:\s*reviews?)?|gog|instagram|insta|facebook|fb|twitter|linke?d\s*in|whats\s*app|telegram|snapchat|pinterest|reviews?)\b/i;
// A name following an honorific anywhere in a line ("MD(A.M) Dr. Chirag Dhakkaan"
// → "Chirag Dhakkaan"). Very reliable for professionals/doctors.
const HON_NAME = /\b(?:Dr|Mr|Mrs|Ms|Miss|Prof|Shri|Smt|Sri)\.?\s+([A-Z][a-zA-Z.'’-]+(?:\s+[A-Z][a-zA-Z.'’-]+){0,2})/;

// Does a line look like a person's name (not a brand, title, tagline, social
// label, or contact)? General, structural — no per-card vocabularies.
function looksName(t) {
  if (CONTACTish(t) || DESIGNATION_WORDS.test(t) || COMPANY_WORDS.test(t)) return false;
  if (SOCIAL_LABEL.test(t)) return false;       // "You Tube", "Google", "Instagram"…
  if (/^(?:the|a|an)\b/i.test(t)) return false; // a personal name never starts with an article
  const words = t.split(/\s+/).filter(Boolean);
  const nameWords = words.filter((w) => !HONORIFIC.test(w));
  // personal names are 1–3 tokens, all capitalised words — "THE INDIAN YOGA SHOP" (4) is a brand
  if (!(nameWords.length >= 1 && nameWords.length <= 3 && words.every(NAME_WORD))) return false;
  if (t.replace(/[^A-Za-z]/g, "").length < 3) return false;
  if (nameWords.length === 1 && /^[A-Z0-9.]{1,4}$/.test(nameWords[0])) return false; // logo acronym like "YOS"
  return true;
}

// A phone or email line — the cardholder's personal contact block.
const isContactBlock = (t) => /@/.test(t) || /(?:\+?\d[\d\s().-]{7,}\d)/.test(t);

// General, layout-based name score — no per-card word lists. The cardholder's
// name sits next to the title and/or their contact block (phone/email), is near
// the top of its side, and looks personal. Floating handwritten notes and big
// logos score low because they're far from the contact block.
function nameScore(l, med, desig, pageMaxY, contacts) {
  const t = l.text.trim();
  let s = 0;
  if (/\b[A-Z]\.?$/.test(t)) s += 1.2;                  // has an initial, e.g. "V."
  if (/^[A-Z][a-z]/.test(t)) s += 0.5;                  // proper-case first word
  if (desig && l.page === desig.page) {                 // adjacency to the title (same side)
    const dy = (l.y || 0) - (desig.y || 0);
    if (dy < 0 && -dy < med * 4) s += 3;
    else if (dy > 0 && dy < med * 3) s += 1.2;
  }
  const near = contacts.filter((c) => c.page === l.page); // proximity to phone/email block
  if (near.length) {
    const d = Math.min(...near.map((c) => Math.abs((c.y || 0) - (l.y || 0))));
    if (d < med * 4) s += 3;                             // right by the contact details → the cardholder
    else if (d < med * 9) s += 1.2;
  }
  const my = pageMaxY[l.page || 0] || 1;
  s += Math.max(0, 1 - (l.y || 0) / my);                // higher on the card → more name-like
  s += Math.min(0.8, (med ? l.h / med : 1) * 0.3);      // size: mild tiebreaker
  s += ((l.conf || 80) - 80) / 50;                      // low-confidence (handwriting/garbled) → lower
  return s;
}

function pickFromGeometry(lines, med, name0) {
  const out = { name: "", company: "", designation: "" };

  const desig = lines.find((l) => DESIGNATION_WORDS.test(l.text) && !COMPANY_SUFFIX.test(l.text) && l.text.length <= 60 && !/@/.test(l.text));
  if (desig) out.designation = desig.text.replace(/^[-–•*\s]+/, "");

  // A line repeated on both sides of the card is a brand/logo, never a personal
  // name (e.g. "Kkhavo" printed on front and back).
  const norm = (s) => s.toLowerCase().replace(/[^a-z0-9]/g, "");
  const pagesOf = {};
  for (const l of lines) { const k = norm(l.text); if (k.length >= 3) (pagesOf[k] = pagesOf[k] || new Set()).add(l.page); }
  const repeated = (l) => { const s = pagesOf[norm(l.text)]; return s && s.size > 1; };

  const nameCands = lines.filter((l) => looksName(l.text.trim()) && !repeated(l));
  // Prefer multi-token candidates — a real name ("VAISHNAVI V.") beats a lone
  // generic word ("India"); fall back to single-token only if nothing else.
  const multi = nameCands.filter((l) => l.text.trim().split(/\s+/).filter((w) => !HONORIFIC.test(w)).length >= 2);
  const pool = multi.length ? multi : nameCands;
  const pageMaxY = {};
  for (const l of lines) pageMaxY[l.page || 0] = Math.max(pageMaxY[l.page || 0] || 1, l.y || 0);
  const contacts = lines.filter((l) => isContactBlock(l.text));
  pool.sort((a, b) => nameScore(b, med, desig, pageMaxY, contacts) - nameScore(a, med, desig, pageMaxY, contacts));
  if (pool.length) out.name = pool[0].text.trim();
  const chosenName = out.name || name0;

  // company: legal suffix wins; else a brand repeated on both sides; else a
  // brand-keyword line; else the most prominent brand.
  let comp = lines.filter((l) => COMPANY_SUFFIX.test(l.text) && !/@/.test(l.text) && !NOT_COMPANY(l.text));
  if (!comp.length) {
    comp = lines.filter((l) => pagesOf[norm(l.text)] && pagesOf[norm(l.text)].size > 1
      && !CONTACTish(l.text) && !DESIGNATION_WORDS.test(l.text) && !NOT_COMPANY(l.text) && l.text.trim() !== chosenName);
  }
  if (!comp.length) comp = lines.filter((l) => COMPANY_WORDS.test(l.text) && !DESIGNATION_WORDS.test(l.text) && !/@/.test(l.text) && !NOT_COMPANY(l.text));
  if (!comp.length) {
    comp = lines.filter((l) => {
      const t = l.text.trim();
      if (t === chosenName || CONTACTish(t) || DESIGNATION_WORDS.test(t) || NOT_COMPANY(t)) return false;
      if (t.replace(/[^A-Za-z]/g, "").length < 3) return false;
      return l.h >= med * 1.1; // visually prominent
    });
  }
  comp.sort((a, b) => b.h - a.h);
  if (comp.length) out.company = comp[0].text.trim();
  return out;
}

// Derive the cardholder's name from the email when the local-part is the name
// (e.g. "goelmudit@..." → finds "MUDIT GOEL" anywhere in the text, even buried in
// a jumbled OCR line). Strongest no-AI name signal; skips generic mailboxes.
const GENERIC_EMAIL = /^(?:info|contact|sales|admin|hello|hi|mail|office|support|enquir\w*|care|team|account|accounts|help)$/i;
function nameFromEmail(lines, email) {
  if (!email || !email.includes("@")) return "";
  const localRaw = email.split("@")[0];
  const local = localRaw.toLowerCase().replace(/[^a-z]/g, "");
  if (local.length < 4 || GENERIC_EMAIL.test(localRaw.replace(/[^a-z]/gi, ""))) return "";
  for (const l of lines) {
    const words = (l.text.match(/[A-Z][a-zA-Z'’.]+/g) || []).filter((w) => w.replace(/[^a-z]/gi, "").length >= 2);
    for (let i = 0; i < words.length; i++) {
      for (let j = i + 2; j <= Math.min(words.length, i + 3); j++) { // require 2–3 words
        const seq = words.slice(i, j);
        const norm = seq.map((w) => w.toLowerCase().replace(/[^a-z]/g, ""));
        // every name word appears in the email local-part, and together they cover most of it
        if (norm.every((w) => w.length >= 2 && local.includes(w)) && norm.join("").length >= Math.min(local.length, 5)) {
          return seq.join(" ");
        }
      }
    }
  }
  return "";
}

// Best-effort merge of geometry into the regex result. `pages` = array of
// { text, lines } from ocrCardRich (front/back/etc).
export function extractCardSmart(pages) {
  const valid = (pages || []).filter(Boolean);
  const combined = valid.map((p) => p.text || "").join("\n");
  const base = extractCard(combined); // reliable contact fields + heuristic fallback

  const lines = valid
    .flatMap((p, pi) => (p.lines || []).map((l) => ({ ...l, page: pi })))
    .filter((l) => l && l.text && l.conf >= 45);
  if (lines.length >= 3) {
    const med = median(lines.map((l) => l.h).filter(Boolean)) || 1;
    const name0 = `${base.first_name} ${base.last_name}`.trim();
    const g = pickFromGeometry(lines, med, name0);
    const setName = (n) => { const sp = splitName(n); base.first_name = sp.firstName; base.last_name = sp.lastName; };
    if (g.name) setName(g.name);
    // A name right after an honorific ("Dr. Chirag Dhakkaan", even merged with a
    // degree) is reliable; an email-derived name is the strongest of all.
    const honName = lines.map((l) => l.text.match(HON_NAME)).find((m) => m && m[1] && !COMPANY_WORDS.test(m[1]) && !DESIGNATION_WORDS.test(m[1]));
    if (honName) setName(honName[1].trim());
    const emailName = nameFromEmail(lines, base.email);
    if (emailName) setName(emailName);

    if (g.company) base.company = g.company;
    if (g.designation && !base.designation) base.designation = g.designation;
    // strip an embedded "Dr. Firstname Lastname" from a merged title line
    if (base.designation) base.designation = base.designation.replace(HON_NAME, "").replace(/\s{2,}/g, " ").replace(/^[\s,–-]+|[\s,–-]+$/g, "").trim();

    const core = ["first_name", "email", "phone", "company"];
    base.missing_core = core.filter((k) => !base[k]);
    const found = core.length - base.missing_core.length;
    base.confidence = found === 4 ? "high" : found >= 2 ? "medium" : "low";
  }
  return base;
}
