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
  // Canonical DL: SS RR YYYY NNNNNNN (e.g. MH12 20110012345 / GJ-05-2020-0001234).
  // [\dOIl] in the numeric groups tolerates the common OCR confusions O->0 and
  // I/l->1 (e.g. "ANO1 ..." for "AN01 ..."); we normalize them back below.
  const D = "[\\dOIl]";
  const patterns = [
    new RegExp(`\\b([A-Z]{2}[-\\s]?${D}{2}[-\\s]?(?:19|20)${D}{2}[-\\s]?${D}{7})\\b`),
    new RegExp(`\\b([A-Z]{2}${D}{2}\\s?${D}{11})\\b`),
  ];
  for (const p of patterns) {
    const m = text.match(p);
    if (m) {
      const raw = m[1].replace(/[-\s]/g, "");
      // Keep the 2-letter state code as-is (it may legitimately contain O/I,
      // e.g. OR/OD); normalize only the numeric tail.
      const tail = raw.slice(2).replace(/[Oo]/g, "0").replace(/[Il]/g, "1");
      return raw.slice(0, 2) + tail;
    }
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
  // A DL/Passport carries several dates (issue, validity, DOB), so prefer a
  // date that sits right after a Date-of-Birth label rather than the first one.
  let m = text.match(
    /(?:date\s+of\s+birth|\bd\.?\s?o\.?\s?b\b|\bbirth\b)[^\d]{0,15}(\d{2}[/-]\d{2}[/-]\d{4})/i,
  );
  if (m) return m[1];

  m = text.match(/(?:YoB|Year of Birth)[:\s]*(\d{4})/i);
  if (m) return m[1];

  // No label (OCR often garbles it): the DOB is the EARLIEST-dated line — you
  // are born before any issue/validity/expiry date on the document.
  const dates = [...text.matchAll(/\b(\d{2})[/-](\d{2})[/-]((?:19|20)\d{2})\b/g)];
  if (dates.length) {
    let best = dates[0];
    for (const d of dates) if (+d[3] < +best[3]) best = d;
    return best[0];
  }
  return null;
}

export function extractGender(text) {
  const t = text.toUpperCase();
  if (t.includes("FEMALE")) return "Female";
  if (/\bMALE\b/.test(t)) return "Male";
  return null;
}

// Indian PIN: 6 digits, never starts with 0, optionally printed "411 038".
const PIN_RE = /\b[1-9]\d{2}\s?\d{3}\b/;

// Lines that are clearly NOT part of an address — used to bound the upward walk.
const ADDR_STOP =
  /AADHAAR|GOVERNMENT|UIDAI|\bDOB\b|DATE OF BIRTH|GENDER|\bMALE\b|FEMALE|\bVID\b|\bSON\b|DAUGHTER|WIFE OF|VALIDITY|ISSUE|LICENCE|LICENSE|BLOOD GROUP|ORGAN DONOR|SIGNATURE|\d{4}\s\d{4}\s\d{4}/i;

export function extractAddress(text) {
  // The PIN code sits at the END of an address; when several 6-digit numbers
  // appear (amounts, IDs) we take the LAST one as the anchor.
  const lines = text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  let pinIdx = -1;
  for (let i = 0; i < lines.length; i++) {
    if (PIN_RE.test(lines[i])) pinIdx = i;
  }
  if (pinIdx === -1) return null;

  // Prefer an explicit "Address" label: take everything from there down to the
  // PIN line. This excludes the "Son/Daughter/Wife of ..." relation line that
  // sits above the address on a Driving Licence. The fuzzy form also catches
  // common OCR misreads of the label ("Addr", "Addis", ...).
  const ADDR_LABEL = /add(?:ress|r|is)/i;
  let startIdx = -1;
  for (let i = pinIdx; i >= 0; i--) {
    if (ADDR_LABEL.test(lines[i])) {
      startIdx = i;
      break;
    }
  }

  let collected;
  if (startIdx !== -1) {
    collected = lines.slice(startIdx, pinIdx + 1).slice(0, 6);
    // Drop the label (and any garbled prefix before it) from the first line.
    // `add\w*` consumes the whole label word even when OCR mangles it
    // ("Addregg", "Addrss", ...) so its tail doesn't leak into the address.
    collected[0] = collected[0].replace(/^.*?add\w*[^A-Za-z0-9]*/i, "");
  } else {
    // No label — walk upward from the PIN until a clearly non-address line.
    collected = [];
    for (let i = pinIdx; i >= 0 && collected.length < 3; i--) {
      if (i !== pinIdx && ADDR_STOP.test(lines[i])) break;
      collected.unshift(lines[i]);
    }
  }

  const addr = collected
    .join(", ")
    // Strip a leaked "Son/Daughter/Wife of <NAME>" relation prefix (DLs print it
    // right before the address; OCR often merges it onto the same line).
    .replace(/\bson\b[\s\/]*daughter[\s\/]*wife\s*of\b[\s:]*([A-Z][A-Za-z]+(\s+[A-Z][A-Za-z]+){0,2})?[\s,]*/i, "")
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
  "TRANSPORT", "PASSPORT", "REPUBLIC", "ADDRESS", "NAME",
];

// A leading field label on a line ("Name :", "S/o", "D/O") — stripped so the
// VALUE after it is read instead of the label word itself.
const NAME_LABEL_RE = /^\s*(?:name|s\s*\/?\s*o|d\s*\/?\s*o|w\s*\/?\s*o)\b[\s:.\-\/]*/i;

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
// "... TH pe" off "Firdos Alam". A leading single-letter initial ("D") is
// skipped, and a lone name word is accepted only if it's long enough (>=4) to
// be a real single name (e.g. "MANIKANDAN") rather than a stray OCR fragment.
function nameFromLine(line) {
  // Strip a leading field label ("Name :", "S/o", ...) so the value is read,
  // and trim edge punctuation off each token ("ANY;" -> "ANY", "4" -> "").
  const words = line
    .replace(NAME_LABEL_RE, "")
    .split(/\s+/)
    .map((w) => w.replace(/^[^A-Za-z]+|[^A-Za-z]+$/g, ""))
    .filter(Boolean);
  const out = [];
  let style = null; // case of the last real name word: "T" (title) or "U" (upper)
  for (const w of words) {
    if (out.length === 0) {
      if (!isNameWord(w)) continue; // skip leading junk/initials until a real name word
      out.push(w);
      style = isUpperWord(w) ? "U" : "T";
      continue;
    }
    if (isInitial(w)) {
      out.push(w); // middle initials don't change the case style
      continue;
    }
    if (!isNameWord(w)) break; // first non-name token ends the name
    const ws = isUpperWord(w) ? "U" : "T";
    // A given+surname may switch case once (Ramesh KUMAR), but after two words a
    // case switch signals trailing OCR junk ("Firdos Alam ESC") — stop there.
    if (out.length >= 2 && ws !== style) break;
    out.push(w);
    style = ws;
  }
  if (out.length < 1 || out.length > 4) return null;
  if (out.length === 1 && out[0].replace(/[^A-Za-z]/g, "").length < 4) return null;
  const joined = out.join(" ");
  if (NAME_SKIP.some((k) => joined.toUpperCase().includes(k))) return null;
  return joined;
}

// Header lines that mark the top of a card — name search starts below them so
// title/garbage tokens up top can't be mistaken for the name.
const HEADER_RE = /income\s*tax|govt|government|union|republic|election|driving|licen[cs]e|aadhaar|unique\s*identification|transport/i;

// Index of the line carrying the date of birth. Prefer an explicit DOB label
// ("Date of Birth" / "DOB" / "Year of Birth"); only then fall back to the first
// plausible date, so issue/validity dates on a DL don't mis-anchor us.
function findDobIdx(lines) {
  const idx = lines.findIndex((l) => /date\s*of\s*birth|\bDOB\b|year\s*of\s*birth/i.test(l));
  if (idx !== -1) return idx;
  // No label: the DOB line is the earliest-dated one (born before issue/validity).
  const DATE = /\b(0[1-9]|[12]\d|3[01])[/-](0[1-9]|1[0-2])[/-]((?:19|20)\d{2})\b/;
  let best = -1;
  let bestYear = Infinity;
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(DATE);
    if (m && +m[3] < bestYear) {
      bestYear = +m[3];
      best = i;
    }
  }
  return best;
}

// All name candidates between the header and the DOB line, top to bottom.
function nameCandidates(lines, start, end) {
  const out = [];
  for (let i = start; i < end; i++) {
    const n = nameFromLine(lines[i]);
    if (n) out.push(n);
  }
  return out;
}

export function extractName(text, docType) {
  // Best-effort name guess — weakest field, treat as "verify me".
  const lines = text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);

  const dobIdx = findDobIdx(lines);
  const headerIdx = lines.findIndex((l) => HEADER_RE.test(l));
  const start = headerIdx >= 0 ? headerIdx + 1 : 0;
  const end = dobIdx > start ? dobIdx : lines.length;

  // PAN prints the cardholder name ABOVE the father's name (both above DOB), so
  // take the TOPMOST candidate. Prefer multi-word names so single-word OCR junk
  // ("SIRT") above the name can't be mistaken for it; fall back to single-word
  // only when there's no multi-word candidate (single-name holders).
  if (docType === "PAN") {
    const cands = nameCandidates(lines, start, end);
    const multi = cands.filter((c) => c.includes(" "));
    const pick = multi.length ? multi : cands;
    if (pick.length) return pick[0];
  }

  // Everyone else: the name sits NEAR the DOB — above on most cards, but BELOW
  // it on some DLs. Search a window around the DOB line, prefer a MULTI-word
  // name (over OCR noise like a single "Sree"), and among those take the one
  // CLOSEST to the DOB line (so the cardholder wins over the father/guardian).
  if (dobIdx >= 0) {
    const lo = Math.max(start, dobIdx - 3);
    const hi = Math.min(lines.length - 1, dobIdx + 3);
    let multi = null, multiDist = Infinity;
    let single = null, singleDist = Infinity;
    for (let i = lo; i <= hi; i++) {
      if (i === dobIdx) continue;
      const n = nameFromLine(lines[i]);
      if (!n) continue;
      const dist = Math.abs(i - dobIdx);
      if (n.includes(" ")) {
        if (dist < multiDist) { multi = n; multiDist = dist; }
      } else if (dist < singleDist) {
        single = n; singleDist = dist;
      }
    }
    if (multi) return multi;
    if (single) return single;
  }

  // Fallback: first multi-word name below the header, else first single-word.
  let single = null;
  for (let i = start; i < lines.length; i++) {
    const n = nameFromLine(lines[i]);
    if (!n) continue;
    if (n.includes(" ")) return n;
    if (!single) single = n;
  }
  return single;
}

// ---------------------------------------------------------------------
// Optional per-document extra fields. Each returns only the fields it finds,
// so a record shows more detail when the document actually carries it.
// ---------------------------------------------------------------------
const DATE = "(\\d{2}[/-]\\d{2}[/-]\\d{4})";

// All full dates in the text, de-duped and sorted oldest -> newest.
function sortedDates(text) {
  const seen = new Set();
  const out = [];
  for (const m of text.matchAll(/\b(\d{2})[/-](\d{2})[/-]((?:19|20)\d{2})\b/g)) {
    if (seen.has(m[0])) continue;
    seen.add(m[0]);
    out.push({ s: m[0], val: +m[3] * 10000 + +m[2] * 100 + +m[1] });
  }
  return out.sort((a, b) => a.val - b.val);
}

export function extractDlExtras(text) {
  const out = {};

  // --- Father/guardian ("Son/Daughter/Wife of: NAME") ---
  const g = text.match(/son[\s\/]*daughter[\s\/]*wife\s*of\b[ \t:]*([A-Z][A-Za-z]+(?:[ \t]+[A-Z][A-Za-z]+){0,2})/i);
  if (g) {
    out.guardian = g[1].trim();
  } else {
    // Label garbled by OCR — take the name printed just below the cardholder,
    // skipping the (garbled) relation-label line itself.
    const lines = text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
    const holder = extractName(text, "DRIVING_LICENSE");
    const hIdx = holder ? lines.findIndex((l) => nameFromLine(l) === holder) : -1;
    if (hIdx !== -1) {
      const REL = /\bof\b|daughter|daiagh|\bwife\b|wine|\bson\b|husband/i;
      for (let i = hIdx + 1; i <= Math.min(lines.length - 1, hIdx + 4); i++) {
        if (REL.test(lines[i])) continue; // skip the relation label line
        const n = nameFromLine(lines[i]);
        if (n && n !== holder) { out.guardian = n; break; }
      }
    }
  }

  // --- Issue / validity dates ---
  // Labels first; they often garble on DLs, so fall back to chronology:
  // DOB < issue < validity, so among all dates the 2nd-oldest is the issue date
  // and the newest is the validity.
  const iss = text.match(new RegExp(`(?:date\\s*of\\s*issue|issue\\s*date|first\\s*issue)\\b[^\\d]{0,15}${DATE}`, "i"));
  if (iss) out.issue_date = iss[1];
  const val = text.match(new RegExp(`valid(?:ity)?\\b[^\\d]{0,15}${DATE}`, "i"));
  if (val) out.validity = val[1];
  if (!out.issue_date || !out.validity) {
    const dates = sortedDates(text);
    if (dates.length >= 3) {
      if (!out.issue_date) out.issue_date = dates[1].s;
      if (!out.validity) out.validity = dates[dates.length - 1].s;
    } else if (dates.length === 2 && !out.validity) {
      out.validity = dates[1].s; // DOB + one more → assume the later is validity
    }
  }

  // --- Blood group ---
  // Prefer a labelled real group (A/B/AB/O ±). Else, if the label is garbled,
  // look for a standalone group-with-sign token anywhere ("A+"). Else surface
  // the raw value next to a readable label, flagged unverified.
  const bgValid = text.match(/blood\s*group\b[ \t:_-]*((?:AB|A|B|O)\s?[+\-]?)(?![A-Za-z])/i);
  if (bgValid) {
    out.blood_group = bgValid[1].replace(/\s+/g, "").toUpperCase();
  } else {
    const bgToken = text.match(/(?<![A-Za-z])(AB|A|B|O)\s?[+\-](?![A-Za-z])/);
    if (bgToken) {
      out.blood_group = bgToken[0].replace(/\s+/g, "").toUpperCase();
    } else {
      const bgRaw = text.match(/blood\s*group\b[ \t:_-]*([A-Za-z]{1,2}[+\-]?)\b/i);
      if (bgRaw) {
        out.blood_group = bgRaw[1].toUpperCase();
        out.blood_group_verified = false;
      }
    }
  }

  // --- Organ donor Y/N ---
  const od = text.match(/organ\s*donor\b[\s:_-]*([YN]|yes|no)\b/i);
  if (od) out.organ_donor = /^y/i.test(od[1]) ? "Yes" : "No";

  return out;
}

export function extractPanExtras(text) {
  // PAN prints NAME then FATHER'S NAME above the DOB; extractName takes the
  // first, so the father's name is the second candidate.
  const out = {};
  const lines = text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  const dobIdx = findDobIdx(lines);
  const headerIdx = lines.findIndex((l) => HEADER_RE.test(l));
  const start = headerIdx >= 0 ? headerIdx + 1 : 0;
  const end = dobIdx > start ? dobIdx : lines.length;
  const cands = nameCandidates(lines, start, end);
  const multi = cands.filter((c) => c.includes(" "));
  const pick = multi.length ? multi : cands;
  if (pick.length >= 2) out.father_name = pick[1];
  return out;
}

export function extractPassportExtras(text) {
  const out = {};
  const iss = text.match(new RegExp(`(?:date\\s*of\\s*issue|issue)\\b[^\\d]{0,15}${DATE}`, "i"));
  if (iss) out.issue_date = iss[1];
  const exp = text.match(new RegExp(`(?:date\\s*of\\s*expiry|expiry|valid\\s*until)\\b[^\\d]{0,15}${DATE}`, "i"));
  if (exp) out.expiry_date = exp[1];
  const pob = text.match(/place\s*of\s*birth\b[\s:]*([A-Z][A-Za-z .,]{2,40})/i);
  if (pob) out.place_of_birth = pob[1].trim();
  const poi = text.match(/place\s*of\s*issue\b[\s:]*([A-Z][A-Za-z .,]{2,40})/i);
  if (poi) out.place_of_issue = poi[1].trim();
  return out;
}

// ---------------------------------------------------------------------
// Document-type registry — add a new ID type by adding one entry.
// ---------------------------------------------------------------------
export const DOC_TYPES = {
  PAN: {
    keywords: ["INCOME TAX", "PERMANENT ACCOUNT", "PAN"],
    idField: "pan_number",
    idFunc: extractPan,
    extras: extractPanExtras,
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
    extras: extractDlExtras,
  },
  PASSPORT: {
    keywords: ["PASSPORT", "REPUBLIC OF INDIA", "P<IND"],
    idField: "passport_number",
    idFunc: extractPassport,
    extras: extractPassportExtras,
  },
};

// Normalize an extractor's return into { value, verified?, masked? } | null.
// Aadhaar returns a rich object; the others return a plain string.
function idResult(spec, text) {
  const r = spec.idFunc(text);
  if (!r) return null;
  return typeof r === "string" ? { value: r } : r;
}

// ID-shaped tokens (any document), harvested from a supplementary OCR pass when
// the main pass misses the number. Format-based, so reading order is irrelevant.
const ID_PATTERNS = [
  /\b[A-Z]{5}[0-9]{4}[A-Z]\b/g, // PAN
  /\b[A-Z]{3}[0-9]{7}\b/g, // Voter
  /\b[A-PR-WY][0-9]{7}\b/g, // Passport
  /\b[A-Z]{2}[\dOIl]{2}\s?[\dOIl]{11}\b/g, // Driving licence
  /\b\d{4}\s?\d{4}\s?\d{4}\b/g, // Aadhaar (12 digits)
];

export function harvestIdNumbers(text) {
  const found = [];
  for (const re of ID_PATTERNS) {
    for (const m of text.matchAll(re)) found.push(m[0]);
  }
  return found;
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
    name: extractName(text, bestType),
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
    // Document-specific extra fields — only those actually found are added.
    if (spec.extras) {
      for (const [k, v] of Object.entries(spec.extras(text))) {
        if (v != null && v !== "") record[k] = v;
      }
    }
  }

  return record;
}
