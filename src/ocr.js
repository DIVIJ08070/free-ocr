// Preprocessing + OCR.
// Phone photos and clean scans need different treatment, so we OCR several
// cleaned variants of each image and keep whichever reads best.

import sharp from "sharp";
import { createWorker, createScheduler } from "tesseract.js";
import { hasValidId, harvestIdNumbers } from "./extract.js";

let scheduler = null;

// Spin up a pool of Tesseract workers once at startup. The scheduler queues
// jobs across workers, so concurrent HTTP requests share the pool safely.
export async function initOcr(numWorkers = Number(process.env.OCR_WORKERS) || 2) {
  if (scheduler) return scheduler;
  scheduler = createScheduler();
  for (let i = 0; i < numWorkers; i++) {
    const worker = await createWorker("eng");
    await worker.setParameters({ tessedit_pageseg_mode: "6" }); // PSM 6: assume a uniform block of text
    scheduler.addWorker(worker);
  }
  return scheduler;
}

export async function shutdownOcr() {
  if (scheduler) {
    await scheduler.terminate();
    scheduler = null;
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
  if (!hasValidId(bestText)) {
    const exifGray = await sharp(inputBuffer).rotate().grayscale().toBuffer();
    const sweep = await rotate(exifGray, deg)
      .resize({ width: 3000, height: 3000, fit: "inside", kernel: "cubic" })
      .normalize()
      .png()
      .toBuffer();
    const sweepText = await scheduler.addJob("recognize", sweep).then((r) => r.data.text);
    const ids = harvestIdNumbers(sweepText);
    if (ids.length) bestText += "\n" + ids.join("\n");
  }

  return bestText;
}
