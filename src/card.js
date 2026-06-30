// Business-card field extraction from OCR text (the free, local path).
// Easy fields (email/phone/website/linkedin) are reliable via regex; name /
// company / designation / address are best-effort heuristics — the Hybrid (AI)
// mode is there for when these need to be accurate.

const DESIGNATION_WORDS =
  /\b(?:CEO|CTO|CFO|COO|CMO|President|Vice President|VP|Founder|Co-?Founder|Director|Manager|Head|Lead|Chief|Officer|Engineer|Developer|Designer|Architect|Consultant|Analyst|Executive|Specialist|Administrator|Coordinator|Owner|Partner|Principal|Associate|Supervisor|Strategist|Marketing|Sales|Accountant|Advocate|Physician|Surgeon|Dentist|Physiotherapist|Nutritionist|Dietici?an|Therapist|Counsell?or|Coach|Trainer|Pharmacist|Professor|Proprietor|Freelancer|Intern|MBBS|BDS|BHMS|BAMS|MD|MS|MBA|BBA|PhD|B\.?Tech|M\.?Tech|B\.?Com|M\.?Com|CA|CS|LLB|LLM|B\.?Sc|M\.?Sc)\b/i;

const COMPANY_WORDS =
  /\b(?:Inc|Incorporated|LLC|Ltd|Limited|Pvt|Private|Corp|Corporation|Company|Co|Technologies|Technology|Solutions|Systems|Services|Software|Labs|Studio|Studios|Group|Enterprises|Industries|Consulting|Global|International|Ventures|Partners|Associates|Agency|Media|Digital|Networks|Foundation|Clinic|Hospital|Centre|Center|Academy|Institute|Fitness|Gym|Salon|Spa|Cafe|Restaurant|Hotel|Builders|Constructions|Traders|Trading|Motors|Pharma|Pharmacy|Healthcare|Wellness|Kranti)\b/i;

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
  // The person's name is usually a top line of capitalized words (Title-case or
  // ALL-CAPS), possibly with an honorific ("Dr."), that isn't a company,
  // designation, or contact line.
  for (const raw of lines) {
    const line = raw.trim().replace(/[•|·,]+$/, "").trim();
    if (!line || DESIGNATION_WORDS.test(line) || COMPANY_WORDS.test(line)) continue;
    if (/[@\d]|www\.|\.com|http/i.test(line)) continue; // skip emails, phones, urls
    const words = line.split(/\s+/).filter(Boolean);
    const nameWords = words.filter((w) => !HONORIFIC.test(w));
    if (nameWords.length >= 1 && nameWords.length <= 4 && words.every(NAME_WORD)) {
      // single-word names only count if reasonably long (avoid stray initials)
      if (nameWords.length === 1 && nameWords[0].replace(/[^A-Za-z]/g, "").length < 3) continue;
      return line;
    }
  }
  return "";
}

function splitName(name) {
  const parts = name.split(/\s+/).filter(Boolean).filter((p) => !HONORIFIC.test(p));
  if (parts.length === 0) return { firstName: "", lastName: "" };
  if (parts.length === 1) return { firstName: parts[0], lastName: "" };
  return { firstName: parts[0], lastName: parts.slice(1).join(" ") };
}

function extractCompany(lines, name) {
  // 1) A line with an explicit company keyword (Inc/Clinic/Fitness/…) that
  //    isn't actually a job title — "Co-founder & CEO" trips the bare "Co".
  for (const raw of lines) {
    const line = raw.trim();
    if (COMPANY_WORDS.test(line) && !DESIGNATION_WORDS.test(line) && !/@/.test(line)) return line;
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
    if (DESIGNATION_WORDS.test(line) && line.length <= 60 && !/@/.test(line)) return line;
  }
  return "";
}

function extractAddress(lines) {
  // Lines with a PIN/ZIP or street-ish keywords; skip phone/email/label lines.
  const STREET = /\b(?:street|road|rd\.?|lane|ln\.?|avenue|ave\.?|block|sector|floor|suite|near|opp\.?|building|plot|nagar|colony|district|city|state)\b/i;
  const PIN = /\b\d{5,6}\b/;
  const SKIP = /@|whats\s*app|whatsapp|\btel\b|phone|mobile|\bmob\b|fax|cell/i;
  const out = [];
  for (const raw of lines) {
    const l = raw.trim();
    if (SKIP.test(l)) continue;
    if (/^[\s+()\d.\-]+$/.test(l)) continue; // a pure phone/number line
    if (STREET.test(l) || (PIN.test(l) && /[A-Za-z]{3,}/.test(l))) out.push(l);
  }
  return out.join(", ").replace(/\s+/g, " ").slice(0, 200);
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
