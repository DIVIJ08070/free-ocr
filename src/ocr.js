// Preprocessing + OCR.
// Phone photos and clean scans need different treatment, so we OCR several
// cleaned variants of each image and keep whichever reads best.

import sharp from "sharp";
import { createWorker, createScheduler } from "tesseract.js";
import { hasValidId, hasStrictId, harvestIdNumbers } from "./extract.js";
import { dewarpCard, adaptiveBin } from "./cardcrop.js";
import { ocrCardPaddle } from "./paddle.js";

let scheduler = null;
// A dedicated worker (outside the scheduler) for the ID-number sweep, locked to
// sparse-text mode + an alphanumeric whitelist so it can't emit the lowercase /
// punctuation noise that corrupts ID numbers — kills O/0, I/1, S/5 at source.
let fieldWorker = null;

// Spin up a pool of Tesseract workers once at startup. The scheduler queues
// jobs across workers, so concurrent HTTP requests share the pool safely.
// Use the higher-accuracy LSTM model ("best") by default — noticeably fewer
// character errors than "fast" on tough/low-contrast cards. Override with
// OCR_QUALITY=fast for speed. Falls back to the default model if "best" can't
// be fetched (e.g. offline first run), so startup never breaks.
// PaddleOCR is the primary card engine now, so Tesseract is only a fallback —
// default it to the light/fast model. Override with OCR_QUALITY=best.
const OCR_QUALITY = process.env.OCR_QUALITY || "fast";
const BEST_OPTS = { langPath: "https://tessdata.projectnaptha.com/4.0.0_best" };
async function makeWorker(psm) {
  let worker;
  try {
    worker = await createWorker("eng", 1, OCR_QUALITY === "fast" ? {} : BEST_OPTS);
  } catch {
    worker = await createWorker("eng"); // fallback to the default/fast model
  }
  await worker.setParameters({ tessedit_pageseg_mode: psm });
  return worker;
}

export async function initOcr(numWorkers = Number(process.env.OCR_WORKERS) || 1) {
  if (scheduler) return scheduler;
  scheduler = createScheduler();
  for (let i = 0; i < numWorkers; i++) {
    scheduler.addWorker(await makeWorker("6")); // PSM 6: assume a uniform block of text
  }
  fieldWorker = await createWorker("eng");
  await fieldWorker.setParameters({
    tessedit_pageseg_mode: "11", // PSM 11: sparse text — find ID tokens anywhere
    tessedit_char_whitelist: "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789 ",
    user_defined_dpi: "300",
  });
  return scheduler;
}

export async function shutdownOcr() {
  if (scheduler) {
    await scheduler.terminate();
    scheduler = null;
  }
  if (fieldWorker) {
    await fieldWorker.terminate();
    fieldWorker = null;
  }
}

const ROTATIONS = [0, 90, 180, 270];

// Upscale target: phone photos of a card leave the actual text quite small
// (a 1700px frame → ~25px-tall characters), which Tesseract reads poorly.
// Enlarging the longest edge to ~2200px gives the text enough pixels that faint
// glyphs (e.g. the blood group) read more reliably, without over-enlarging to
// the point where page segmentation starts garbling lines. Larger inputs (good
// scans) are left as-is.
const OCR_TARGET_PX = 2200;

// EXIF-orient + grayscale + upscale once, into a buffer we can cheaply
// re-rotate. EXIF orientation is baked in here so later manual rotations
// don't fight it.
async function normalizedGray(inputBuffer) {
  const meta = await sharp(inputBuffer).metadata();
  const maxDim = Math.max(meta.width || 0, meta.height || 0);
  let p = sharp(inputBuffer).rotate().grayscale(); // .rotate() = EXIF auto-orient
  if (maxDim && maxDim < OCR_TARGET_PX) {
    // fit:inside scales the longest edge to the target (orientation-safe).
    p = p.resize({ width: OCR_TARGET_PX, height: OCR_TARGET_PX, fit: "inside", kernel: "cubic" });
  }
  return p.png().toBuffer();
}

const rotate = (buf, deg) => (deg === 0 ? sharp(buf) : sharp(buf).rotate(deg));

// Score a probe reading: real words + letters + a big bonus for a valid ID.
// Sideways/upside-down pages yield few real words and low confidence, so this
// cleanly separates the correct orientation from the wrong ones.
function orientScore(text, confidence) {
  const t = text || "";
  const letters = (t.match(/[A-Za-z]/g) || []).length;
  const words = (t.match(/\b[A-Za-z]{3,}\b/g) || []).length;
  return 200 * hasValidId(t) + 8 * words + letters + (confidence || 0);
}

// Find the upright orientation by OCR'ing a fast, downscaled probe at each of
// the four 90° rotations and keeping the best-scoring one.
async function bestOrientation(grayBuf) {
  const probes = await Promise.all(
    ROTATIONS.map((deg) =>
      rotate(grayBuf, deg)
        // Cap the LONGEST edge (not just width) so all four rotations are scored
        // at the same pixel budget; small/fast so probing stays cheap.
        .resize({ width: 700, height: 700, fit: "inside", withoutEnlargement: true })
        .normalize()
        .png()
        .toBuffer()
        .then((buf) => ({ deg, buf })),
    ),
  );
  const scored = await Promise.all(
    probes.map(({ deg, buf }) =>
      scheduler
        .addJob("recognize", buf)
        .then((r) => ({ deg, score: orientScore(r.data.text, r.data.confidence) })),
    ),
  );
  scored.sort((a, b) => b.score - a.score);
  return scored[0].deg;
}

// Produce a few cleaned versions of an already-oriented grayscale buffer.
async function variantsFrom(grayBuf) {
  // CLAHE throws if its window is larger than the image, so clamp it to the
  // actual dimensions (matters for thin/cropped inputs).
  const meta = await sharp(grayBuf).metadata();
  const win = Math.max(8, Math.min(64, meta.width || 64, meta.height || 64));

  const [otsu, adaptive, gray] = await Promise.all([
    // a) normalize + global threshold — best for clean, evenly-lit scans
    sharp(grayBuf).normalize().threshold(128).png().toBuffer(),
    // b) CLAHE local contrast + threshold — best for phone photos with uneven light
    sharp(grayBuf).clahe({ width: win, height: win }).threshold(128).png().toBuffer(),
    // c) plain normalized grayscale — sometimes wins when thresholding eats strokes
    sharp(grayBuf).normalize().png().toBuffer(),
  ]);
  return [otsu, adaptive, gray];
}

// OCR the image: auto-detect orientation, then OCR several preprocessing
// variants at that orientation and return the text that looks richest.
export async function ocrBest(inputBuffer) {
  if (!scheduler) throw new Error("OCR not initialized — call initOcr() first");

  const grayBuf = await normalizedGray(inputBuffer);
  const deg = await bestOrientation(grayBuf);
  const orientedGray = await rotate(grayBuf, deg).png().toBuffer();

  const vs = await variantsFrom(orientedGray);
  const results = await Promise.all(
    vs.map((v) => scheduler.addJob("recognize", v).then((r) => r.data.text)),
  );

  let bestText = "";
  let bestScore = -1;
  for (const text of results) {
    // Reward finding a valid ID number, then total useful (non-space) characters.
    const score = 3 * hasValidId(text) + text.replace(/\s/g, "").length;
    if (score > bestScore) {
      bestText = text;
      bestScore = score;
    }
  }

  // If no ID number surfaced, do ONE higher-resolution sweep purely to recover
  // it. The ID is format-identifiable, so we harvest only ID-shaped tokens and
  // append them — the positional fields still come from the main pass above.
  // Re-derive from the ORIGINAL input at 3000px (the main pass is capped lower,
  // and small ID text needs the extra pixels), reusing the detected orientation.
  if (!hasStrictId(bestText)) {
    const exifGray = await sharp(inputBuffer).rotate().grayscale().toBuffer();
    const sweep = await rotate(exifGray, deg)
      .resize({ width: 3000, height: 3000, fit: "inside", kernel: "cubic" })
      .normalize()
      .png()
      .toBuffer();
    // Use the alphanumeric-whitelisted field worker so the recovered number is
    // clean (no O/0 or I/1 noise); fall back to the scheduler if unavailable.
    const sweepText = fieldWorker
      ? await fieldWorker.recognize(sweep).then((r) => r.data.text)
      : await scheduler.addJob("recognize", sweep).then((r) => r.data.text);
    const ids = harvestIdNumbers(sweepText);
    if (ids.length) bestText += "\n" + ids.join("\n");
  }

  return bestText;
}

// ── Business-card OCR ────────────────────────────────────────────────────────
// Cards are often photographed with the text running sideways (printed rotated
// 90°), and many are low-contrast (cream on olive, foil on dark, etc). The ID
// path scores orientation by "valid ID present", which never fires on a card —
// so cards need their own orientation signal and stronger contrast handling.

// How "card-like" a reading is. An @email, a URL, or a long digit-run are almost
// impossible to hallucinate from sideways text, so they decisively reward the
// upright rotation; real words + letters + Tesseract confidence break ties.
function cardScore(text, confidence) {
  const t = text || "";
  const words = (t.match(/\b[A-Za-z]{3,}\b/g) || []).length;
  const letters = (t.match(/[A-Za-z]/g) || []).length;
  const email = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/.test(t) ? 1 : 0;
  const url = /(?:https?:\/\/|www\.|\.com|\.in\b|\.org|\.net|\.co\b)/i.test(t) ? 1 : 0;
  const phone = t.replace(/\D/g, "").length >= 8 ? 1 : 0;
  return 90 * email + 35 * url + 25 * phone + 6 * words + 0.3 * letters + 0.4 * (confidence || 0);
}

const CARD_PROBE_PX = 1100;

// EXIF-orient + upscale (keeping colour), rotate, then return the single colour
// channel with the most contrast. For coloured cards (cream-on-olive, foil) one
// channel separates text far better than luminance grayscale does.
async function bestChannel(inputBuffer, deg) {
  const meta = await sharp(inputBuffer).metadata();
  const maxDim = Math.max(meta.width || 0, meta.height || 0);
  let p = sharp(inputBuffer).rotate();
  if (maxDim && maxDim < OCR_TARGET_PX) {
    p = p.resize({ width: OCR_TARGET_PX, height: OCR_TARGET_PX, fit: "inside", kernel: "cubic" });
  }
  let buf = await p.removeAlpha().toBuffer();
  if (deg) buf = await sharp(buf).rotate(deg).toBuffer();
  const stats = await sharp(buf).stats();
  let ch = 0, bestStd = -1;
  stats.channels.slice(0, 3).forEach((c, i) => { if (c.stdev > bestStd) { bestStd = c.stdev; ch = i; } });
  return sharp(buf).extractChannel(ch);
}

// Normalize a Tesseract result's lines into {text, conf, h (font size), x, y}.
function linesFrom(data) {
  return (data.lines || [])
    .map((l) => ({
      text: (l.text || "").replace(/\s+/g, " ").trim(),
      conf: l.confidence || 0,
      h: l.bbox ? l.bbox.y1 - l.bbox.y0 : 0,
      y: l.bbox ? l.bbox.y0 : 0,
      x: l.bbox ? l.bbox.x0 : 0,
    }))
    .filter((l) => l.text);
}

// OCR one card image → { text, lines }. Detects the upright angle, then reads a
// few contrast-boosted variants (grayscale + best colour channel) at that angle,
// returning the richest one with its per-line geometry for layout-aware fields.
// When OCR_DEBUG_DIR is set, save intermediate images/text so we can see exactly
// what the OCR worked with on a real photo (detection result, variant, raw text).
let _dbgN = 0;
async function dbgSave(buf, tag) {
  const dir = process.env.OCR_DEBUG_DIR;
  if (!dir || !buf) return 0;
  const n = ++_dbgN;
  try { await sharp(buf).png().toFile(`${dir}/${n}-${tag}.png`); } catch { /* best-effort */ }
  return n;
}
async function dbgText(n, text, note) {
  const dir = process.env.OCR_DEBUG_DIR;
  if (!dir) return;
  try { (await import("node:fs")).writeFileSync(`${dir}/${n}-raw.txt`, note + "\n----\n" + (text || "")); } catch { /* best-effort */ }
}

export async function ocrCardRich(inputBuffer) {
  await dbgSave(inputBuffer, "orig");

  // 1) Neural OCR (PaddleOCR) first — far more accurate on real photos. It reads
  //    all four rotations and returns clean per-line text + geometry. Falls back
  //    to the Tesseract pipeline below if the engine isn't available.
  try {
    const pad = await ocrCardPaddle(inputBuffer);
    if (pad && pad.lines && pad.lines.length >= 2) {
      await dbgText(_dbgN, pad.text, "[paddle] lines=" + pad.lines.length);
      return pad;
    }
  } catch { /* fall through to Tesseract */ }

  if (!scheduler) throw new Error("OCR not initialized — call initOcr() first");

  // Detect + crop + flatten the card out of the photo. On real phone shots this
  // is the biggest win — it removes the hand/background and corrects tilt so OCR
  // works on a clean, full-resolution card. Falls back to the raw photo.
  let work = inputBuffer, dewarped = false;
  try {
    const cropped = await dewarpCard(inputBuffer);
    if (cropped) { work = cropped; dewarped = true; }
  } catch { /* dewarp is best-effort */ }
  await dbgSave(work, dewarped ? "dewarped" : "nodewarp");

  const grayBuf = await normalizedGray(work);

  // 1) Orientation: score all four 90° rotations by how card-like the text reads.
  const probes = await Promise.all(
    ROTATIONS.map((deg) =>
      rotate(grayBuf, deg)
        .resize({ width: CARD_PROBE_PX, height: CARD_PROBE_PX, fit: "inside", withoutEnlargement: true })
        .normalize().linear(1.3, -28).sharpen().png().toBuffer()
        .then((buf) => ({ deg, buf })),
    ),
  );
  const scored = await Promise.all(
    probes.map(({ deg, buf }) => scheduler.addJob("recognize", buf).then((r) => ({ deg, score: cardScore(r.data.text, r.data.confidence) }))),
  );
  scored.sort((a, b) => b.score - a.score);
  const deg = scored[0].deg;

  // 2) Full-res read at the chosen angle — grayscale + best colour channel —
  //    capturing line geometry; keep whichever variant reads most card-like.
  const orientedGray = await rotate(grayBuf, deg).png().toBuffer();
  const meta = await sharp(orientedGray).metadata();
  const win = Math.max(8, Math.min(64, meta.width || 64, meta.height || 64));
  const stat = await sharp(orientedGray).stats();
  const lightOnDark = (stat.channels[0]?.mean ?? 128) < 125; // light text on a darker card
  const lum = await sharp(orientedGray).normalize().linear(1.3, -28).sharpen().png().toBuffer();
  let channelVariant = null, adaptiveA = null, adaptiveB = null;
  try { channelVariant = await (await bestChannel(work, deg)).normalize().linear(1.3, -22).sharpen().png().toBuffer(); } catch { /* best-effort */ }
  try { adaptiveA = await adaptiveBin(orientedGray, lightOnDark); } catch { /* best-effort */ }
  try { adaptiveB = await adaptiveBin(orientedGray, !lightOnDark); } catch { /* best-effort */ }

  const variants = [
    lum,
    await sharp(lum).negate().png().toBuffer(),                              // dark-on-light for light-on-dark cards
    await sharp(orientedGray).clahe({ width: win, height: win }).png().toBuffer(),
    ...(channelVariant ? [channelVariant] : []),
    ...(adaptiveA ? [adaptiveA] : []),
    ...(adaptiveB ? [adaptiveB] : []),
  ];
  const reads = await Promise.all(
    variants.map((v) =>
      scheduler.addJob("recognize", v, {}, { blocks: true }).then((r) => ({
        buf: v, text: r.data.text, score: cardScore(r.data.text, r.data.confidence), lines: linesFrom(r.data),
      })),
    ),
  );
  reads.sort((a, b) => b.score - a.score);
  const n = await dbgSave(reads[0].buf, "bestvariant");
  await dbgText(n, reads[0].text, (dewarped ? "[dewarped] " : "[NO dewarp] ") + "orientation=" + deg + " score=" + Math.round(reads[0].score));
  return { text: reads[0].text, lines: reads[0].lines };
}

export async function ocrCard(inputBuffer) {
  return (await ocrCardRich(inputBuffer)).text;
}
