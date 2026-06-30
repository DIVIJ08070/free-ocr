// Aadhaar QR decode — the highest-accuracy, fully-offline source of truth.
//
// Indian Aadhaar carries a UIDAI-signed QR holding the holder's name, DOB,
// gender and full address. Decoding it sidesteps OCR entirely (no glare/angle
// errors). Pure JS: jsQR for the symbol, Node's zlib for decompression.
//
// Supported encodings:
//   - Secure QR v2 (2018+): byte/numeric payload -> gzip -> 0xFF-delimited fields
//   - Legacy QR: plain "PrintLetterBarcodeData" XML with attributes

import sharp from "sharp";
import zlib from "node:zlib";
import jsQR from "jsqr";
import { verhoeffValid } from "./verhoeff.js";

// Try to read a QR symbol from the image. jsQR needs RGBA pixels; we try a few
// scales because the symbol can be small relative to a full-frame photo.
async function readQrSymbol(buffer) {
  const base = sharp(buffer).rotate(); // honour EXIF
  for (const width of [1600, 2400, 1000]) {
    try {
      const { data, info } = await base
        .clone()
        .resize({ width, height: width, fit: "inside", withoutEnlargement: false })
        .ensureAlpha()
        .raw()
        .toBuffer({ resolveWithObject: true });
      const px = new Uint8ClampedArray(data.buffer, data.byteOffset, data.byteLength);
      const res = jsQR(px, info.width, info.height);
      if (res) return res;
    } catch {
      /* try next scale */
    }
  }
  return null;
}

function bigIntToBytes(decStr) {
  let n = BigInt(decStr);
  const out = [];
  while (n > 0n) {
    out.unshift(Number(n & 0xffn));
    n >>= 8n;
  }
  return Buffer.from(out);
}

function inflateMaybe(bytes) {
  // Aadhaar uses GZIP; fall back to raw inflate, else assume already-plain.
  for (const fn of [zlib.gunzipSync, zlib.inflateSync, zlib.inflateRawSync]) {
    try {
      return fn(bytes);
    } catch {
      /* next */
    }
  }
  return bytes;
}

// Field order of the Secure QR v2 payload, after the 0xFF delimiters.
const FIELDS = [
  "_ind", "refId", "name", "dob", "gender", "co", "district", "landmark",
  "house", "location", "pincode", "po", "state", "street", "subdistrict", "vtc",
];

// Normalize any DOB the QR carries (ISO or dd-mm-yyyy) to dd/mm/yyyy, matching
// the OCR pipeline's output format.
function normDob(s) {
  if (!s) return s || null;
  s = s.trim();
  let m = s.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (m) return `${m[3]}/${m[2]}/${m[1]}`;
  m = s.match(/^(\d{2})[-/](\d{2})[-/](\d{4})$/);
  if (m) return `${m[1]}/${m[2]}/${m[3]}`;
  return s;
}

function joinAddress(f) {
  const parts = [f.house, f.street, f.landmark, f.location, f.vtc, f.po, f.subdistrict, f.district, f.state, f.pincode]
    .map((s) => (s || "").trim())
    .filter(Boolean);
  // Aadhaar address components often repeat (district == location == vtc);
  // keep first occurrence of each.
  const seen = new Set();
  const out = [];
  for (const p of parts) {
    const k = p.toLowerCase().replace(/[^a-z0-9]/g, "");
    if (k && !seen.has(k)) { seen.add(k); out.push(p); }
  }
  return out.join(", ") || null;
}

function recordFromSecure(rawBytes) {
  // Split into the first 16 UTF-8 fields on 0xFF; stop before the photo/signature.
  const f = {};
  let start = 0;
  let idx = 0;
  for (let i = 0; i < rawBytes.length && idx < FIELDS.length; i++) {
    if (rawBytes[i] === 0xff) {
      f[FIELDS[idx++]] = rawBytes.slice(start, i).toString("utf8");
      start = i + 1;
    }
  }
  if (!f.name || !f.dob) return null;
  const gender = /^f/i.test(f.gender || "") ? "Female" : /^m/i.test(f.gender || "") ? "Male" : null;
  return {
    document_type: "AADHAAR",
    name: f.name.trim(),
    dob: normDob(f.dob),
    gender,
    address: joinAddress(f),
    aadhaar_number: f.refId ? `XXXX XXXX ${f.refId.slice(0, 4)}` : null,
    aadhaar_masked: true,
    source: "qr",
  };
}

function recordFromXml(xml) {
  const attr = (k) => {
    const m = xml.match(new RegExp(k + '="([^"]*)"', "i"));
    return m ? m[1].trim() : null;
  };
  const name = attr("name");
  if (!name) return null;
  const g = attr("gender");
  // Map XML attribute names onto the shared (deduping) address joiner.
  const address = joinAddress({
    house: attr("house"), street: attr("street"), landmark: attr("lm"),
    location: attr("loc"), vtc: attr("vtc"), po: attr("po"),
    subdistrict: attr("subdist"), district: attr("dist"),
    state: attr("state"), pincode: attr("pc"),
  });
  const rec = {
    document_type: "AADHAAR",
    name,
    dob: normDob(attr("dob") || attr("yob")),
    gender: /^f/i.test(g || "") ? "Female" : /^m/i.test(g || "") ? "Male" : null,
    address,
    source: "qr",
  };
  // Legacy QR often carries the FULL 12-digit UID — emit it, checksum-verified.
  const uid = (attr("uid") || "").replace(/\D/g, "");
  if (uid.length === 12) {
    rec.aadhaar_number = `${uid.slice(0, 4)} ${uid.slice(4, 8)} ${uid.slice(8)}`;
    rec.aadhaar_verified = verhoeffValid(uid);
  } else if (uid.length >= 4) {
    rec.aadhaar_number = `XXXX XXXX ${uid.slice(-4)}`;
    rec.aadhaar_masked = true;
  }
  return rec;
}

// Parse a decoded QR result into an Aadhaar record, or null if it isn't one.
export function parseAadhaarQr(res) {
  if (!res) return null;
  const text = res.data || "";

  // Legacy plain-XML QR.
  if (/PrintLetterBarcodeData|<\?xml/i.test(text)) {
    return recordFromXml(text);
  }

  // Secure QR: payload is either a big decimal integer (numeric mode) or raw
  // bytes (byte mode); both decompress to the delimited field block.
  let bytes = null;
  if (/^\d{40,}$/.test(text.trim())) {
    try { bytes = bigIntToBytes(text.trim()); } catch { /* ignore */ }
  }
  if (!bytes && res.binaryData && res.binaryData.length) {
    bytes = Buffer.from(res.binaryData);
  }
  if (!bytes) return null;

  const raw = inflateMaybe(bytes);
  return recordFromSecure(raw);
}

// Full pipeline: image buffer -> Aadhaar record from its QR, or null.
export async function readAadhaarQr(buffer) {
  const res = await readQrSymbol(buffer);
  return parseAadhaarQr(res);
}
