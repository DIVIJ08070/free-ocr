// Pure rule-based field extraction (regex + checksum) — the "no AI" part.

import { verhoeffValid } from "./verhoeff.js";

// ---------------------------------------------------------------------
// Per-document ID extractors
// ---------------------------------------------------------------------
export function extractPan(text) {
  const m = text.match(/\b[A-Z]{5}[0-9]{4}[A-Z]\b/);
  return m ? m[0] : null;
}

export function extractAadhaar(text) {
  // Returns { value, verified, masked } or null.
  //  - verified:true  -> 12 digits that pass the Verhoeff checksum
  //  - verified:false -> 12 digits in the right shape but checksum fails
  //                      (almost always a single OCR digit misread)
  //  - masked:true    -> only the last 4 digits are printed (XXXX XXXX 1234)
  const re = /\b(\d{4}[\s-]?\d{4}[\s-]?\d{4})\b/g;
  let m;
  let fallback = null;
  while ((m = re.exec(text)) !== null) {
    const d = m[1].replace(/\D/g, "");
    if (d.length !== 12) continue;
    const fmt = `${d.slice(0, 4)} ${d.slice(4, 8)} ${d.slice(8, 12)}`;
    // Real Aadhaars never start with 0/1 and pass the checksum -> trusted.
    if ("23456789".includes(d[0]) && verhoeffValid(d)) {
      return { value: fmt, verified: true };
    }
    // Anything else of the right shape (sample numbers, OCR misreads) is
    // surfaced as unverified rather than dropped.
    if (!fallback) fallback = { value: fmt, verified: false };
  }
  if (fallback) return fallback;

  // Masked Aadhaar on newer cards / e-KYC: first 8 digits hidden as X or *.
  // Digit boundaries keep it from slicing the last 4 off a longer number, and
  // we drop lowercase "x" since it shows up in ordinary text.
  const mask = text.match(/(?<!\d)(?:[X*]{4}[\s-]){2}(\d{4})(?!\d)/);
  if (mask) return { value: `XXXX XXXX ${mask[1]}`, masked: true, verified: false };

  return null;
}

export function extractVoter(text) {
  const m = text.match(/\b[A-Z]{3}[0-9]{7}\b/);
  return m ? m[0] : null;
}

export function extractDl(text) {
  // Canonical DL: SS RR YYYY NNNNNNN (e.g. MH12 20110012345 / GJ-05-2020-0001234)
  const patterns = [
    /\b([A-Z]{2}[-\s]?\d{2}[-\s]?(?:19|20)\d{2}[-\s]?\d{7})\b/,
    /\b([A-Z]{2}\d{2}\s?\d{11})\b/,
  ];
  for (const p of patterns) {
    const m = text.match(p);
    if (m) return m[1].replace(/[-\s]/g, "");
  }
  return null;
}

export function extractPassport(text) {
  // Indian passport: 1 letter + 7 digits (e.g. A1234567).
  const m = text.match(/\b([A-PR-WY][0-9]{7})\b/);
  return m ? m[1] : null;
}

// ---------------------------------------------------------------------
// Shared fields across all document types
// ---------------------------------------------------------------------
export function extractDob(text) {
  let m = text.match(/\b(\d{2}[/-]\d{2}[/-]\d{4})\b/);
  if (m) return m[1];
  m = text.match(/(?:YoB|Year of Birth)[:\s]*(\d{4})/i);
  return m ? m[1] : null;
}

export function extractGender(text) {
  const t = text.toUpperCase();
  if (t.includes("FEMALE")) return "Female";
  if (/\bMALE\b/.test(t)) return "Male";
  return null;
}

// Indian PIN: 6 digits, never starts with 0, optionally printed "411 038".
const PIN_RE = /\b[1-9]\d{2}\s?\d{3}\b/;

export function extractAddress(text) {
  // Anchor on the PIN code, then walk upward gathering the address lines above
  // it until we hit a non-address line. The PIN sits at the END of an address,
  // so when several 6-digit numbers appear (amounts, IDs) we take the LAST one.
  const lines = text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  let pinIdx = -1;
  for (let i = 0; i < lines.length; i++) {
    if (PIN_RE.test(lines[i])) pinIdx = i;
  }
  if (pinIdx === -1) return null;

  const STOP = /AADHAAR|GOVERNMENT|UIDAI|\bDOB\b|GENDER|\bMALE\b|FEMALE|\bVID\b|\d{4}\s\d{4}\s\d{4}/i;
  const collected = [];
  for (let i = pinIdx; i >= 0 && collected.length < 3; i--) {
    if (i !== pinIdx && STOP.test(lines[i])) break;
    collected.unshift(lines[i]);
  }

  const addr = collected
    .join(", ")
    .replace(/[^\w\s,.\-/]/g, " ") // strip OCR bracket/symbol junk
    .replace(/\s+/g, " ")
    .replace(/\s*,\s*/g, ", ")
    .replace(/(,\s*)+/g, ", ")
    .replace(/^[\s,]+|[\s,]+$/g, "")
    .trim();

  return addr || null;
}

const NAME_SKIP = [
  "INCOME", "TAX", "DEPARTMENT", "GOVT", "GOVERNMENT", "INDIA",
  "PERMANENT", "ACCOUNT", "NUMBER", "FATHER", "DATE", "BIRTH",
  "MALE", "FEMALE", "AADHAAR", "UNIQUE", "AUTHORITY", "SIGNATURE",
  "ELECTION", "COMMISSION", "ELECTOR", "LICENCE", "LICENSE",
  "TRANSPORT", "PASSPORT", "REPUBLIC", "ADDRESS",
];

// A title-case name word (Firdos, Alam, D'Souza, O'Brien — apostrophe allowed
// right after the leading cap) vs an all-caps one (RAMESH).
const isTitleWord = (w) => /^[A-Z][a-z'’.\-][A-Za-z'’.\-]*$/.test(w);
const isUpperWord = (w) => /^[A-Z][A-Z'’.\-]+$/.test(w);
const isInitial = (w) => /^[A-Z]\.?$/.test(w);
// A real name word of either casing, long enough not to be 2-letter OCR junk
// (e.g. "TH", "Th", "pe"). Single letters are handled separately as initials.
const isNameWord = (w) => (isTitleWord(w) || isUpperWord(w)) && w.length >= 3;

// Pull a clean name out of one line: take the leading run of name words, then
// STOP at the first token that isn't one. Accepts mixed casing within a name
// ("Ramesh KUMAR") but the length>=3 rule strips trailing OCR junk like
// "... TH pe" off "Firdos Alam".
function nameFromLine(line) {
  const words = line.split(/\s+/).filter(Boolean);
  const out = [];
  let started = false;
  for (const w of words) {
    if (!started) {
      if (!isNameWord(w)) continue; // skip leading junk until a real name word
      started = true;
      out.push(w);
      continue;
    }
    if (isNameWord(w) || isInitial(w)) out.push(w);
    else break; // first non-name token ends the name
  }
  if (out.length < 2 || out.length > 4) return null;
  const joined = out.join(" ");
  if (NAME_SKIP.some((k) => joined.toUpperCase().includes(k))) return null;
  return joined;
}

export function extractName(text) {
  // Best-effort name guess — weakest field, treat as "verify me".
  const lines = text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);

  // The English name almost always sits just above the DOB/date line, so
  // anchor there and walk upward — far more reliable than first-match top-down.
  // Prefer an explicit DOB keyword; only fall back to a plausible-looking date
  // (day 1-31, month 1-12) so stray serials/issue dates don't mis-anchor us.
  let dobIdx = lines.findIndex((l) => /\bDOB\b|year of birth/i.test(l));
  if (dobIdx === -1) {
    dobIdx = lines.findIndex((l) =>
      /\b(0[1-9]|[12]\d|3[01])[/-](0[1-9]|1[0-2])[/-](19|20)\d{2}\b/.test(l),
    );
  }
  if (dobIdx > 0) {
    for (let i = dobIdx - 1; i >= 0; i--) {
      const n = nameFromLine(lines[i]);
      if (n) return n;
    }
  }

  // Fallback: first qualifying line, top-down.
  for (const line of lines) {
    const n = nameFromLine(line);
    if (n) return n;
  }
  return null;
}

// ---------------------------------------------------------------------
// Document-type registry — add a new ID type by adding one entry.
// ---------------------------------------------------------------------
export const DOC_TYPES = {
  PAN: {
    keywords: ["INCOME TAX", "PERMANENT ACCOUNT", "PAN"],
    idField: "pan_number",
    idFunc: extractPan,
  },
  AADHAAR: {
    keywords: ["AADHAAR", "UNIQUE IDENTIFICATION", "UIDAI", "VID"],
    idField: "aadhaar_number",
    idFunc: extractAadhaar,
  },
  VOTER_ID: {
    keywords: ["ELECTION COMMISSION", "ELECTOR", "EPIC", "IDENTITY CARD"],
    idField: "voter_id",
    idFunc: extractVoter,
  },
  DRIVING_LICENSE: {
    keywords: ["DRIVING LICENCE", "DRIVING LICENSE", "TRANSPORT", "DL NO"],
    idField: "dl_number",
    idFunc: extractDl,
  },
  PASSPORT: {
    keywords: ["PASSPORT", "REPUBLIC OF INDIA", "P<IND"],
    idField: "passport_number",
    idFunc: extractPassport,
  },
};

// Normalize an extractor's return into { value, verified?, masked? } | null.
// Aadhaar returns a rich object; the others return a plain string.
function idResult(spec, text) {
  const r = spec.idFunc(text);
  if (!r) return null;
  return typeof r === "string" ? { value: r } : r;
}

// 1 if any known ID pattern is found (used to score OCR variants).
// A checksum-failing Aadhaar doesn't count here, so variant selection still
// prefers a reading where the number passes Verhoeff.
export function hasValidId(text) {
  for (const [name, spec] of Object.entries(DOC_TYPES)) {
    const id = idResult(spec, text);
    if (!id) continue;
    if (name === "AADHAAR" && id.verified !== true) continue;
    return 1;
  }
  return 0;
}

export function detectAndExtract(text) {
  const upper = text.toUpperCase();
  let bestType = null;
  let bestScore = 0;

  for (const [name, spec] of Object.entries(DOC_TYPES)) {
    let score = 0;
    for (const kw of spec.keywords) {
      if (upper.includes(kw)) score += 2;
    }
    if (idResult(spec, text)) score += 3;
    if (score > bestScore) {
      bestType = name;
      bestScore = score;
    }
  }

  const record = {
    document_type: bestType || "UNKNOWN",
    name: extractName(text),
    dob: extractDob(text),
    gender: extractGender(text),
    address: extractAddress(text),
  };

  if (bestType) {
    const spec = DOC_TYPES[bestType];
    const id = idResult(spec, text);
    record[spec.idField] = id ? id.value : null;
    if (bestType === "AADHAAR" && id) {
      record.aadhaar_verified = id.verified === true;
      if (id.masked) record.aadhaar_masked = true;
    }
  }

  return record;
}
