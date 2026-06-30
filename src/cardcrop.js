// Detect the business card in a photo, crop to it, and flatten its perspective
// using OpenCV (WASM). Real phone photos have the card small + tilted on a busy
// background (hand, desk), which wrecks OCR — cropping to just the card and
// dewarping it to a flat rectangle is the single biggest local-accuracy win.
// Also exposes an adaptive (local) threshold, which beats global thresholding on
// low-contrast / unevenly-lit cards. Everything degrades gracefully to null.

import sharp from "sharp";
import cvModule from "@techstark/opencv-js";

let _cv = null;
async function cv() {
  if (_cv) return _cv;
  let c = cvModule;
  if (c && typeof c.then === "function") c = await c;
  if (c && c.default) c = c.default;
  if (c && typeof c.then === "function") c = await c;
  if (!c || !c.Mat) {
    await new Promise((res) => {
      const t = setTimeout(res, 8000);
      if (c && "onRuntimeInitialized" in c) c.onRuntimeInitialized = () => { clearTimeout(t); res(); };
    });
  }
  _cv = c;
  return c;
}

// Raw RGBA pixels from a buffer (EXIF-oriented), optionally downscaled to `width`.
async function rgba(buffer, width) {
  let p = sharp(buffer).rotate();
  if (width) p = p.resize({ width });
  const { data, info } = await p.ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  return { data, width: info.width, height: info.height };
}

const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);
function orderCorners(pts) {
  const bySum = [...pts].sort((a, b) => a.x + a.y - (b.x + b.y));   // tl smallest sum, br largest
  const byDiff = [...pts].sort((a, b) => a.y - a.x - (b.y - b.x));  // tr smallest (y-x), bl largest
  return [bySum[0], byDiff[0], bySum[3], byDiff[3]];                // tl, tr, br, bl
}

// Contrast-boosted single-channel grayscale — amplifies a faint card/background
// edge so Canny can find it. Detection only (the warp uses full-res colour).
async function grayForDetection(buffer, DW) {
  const { data, info } = await sharp(buffer).rotate().resize({ width: DW })
    .grayscale().normalise().linear(1.6, -50).blur(0.6)
    .raw().toBuffer({ resolveWithObject: true });
  return { data, width: info.width, height: info.height };
}

// Find the largest card-shaped region at detection resolution (rotated rect, so
// rounded corners and tilt are fine). Returns its 4 ordered corners, or null.
async function findQuad(c, buffer, DW) {
  const { data, width, height } = await grayForDetection(buffer, DW);
  const gray = new c.Mat(height, width, c.CV_8UC1);
  gray.data.set(data);
  const edges = new c.Mat(), closed = new c.Mat();
  const contours = new c.MatVector(), hier = new c.Mat();
  let quad = null;
  try {
    c.Canny(gray, edges, 30, 90);
    const k = c.getStructuringElement(c.MORPH_RECT, new c.Size(11, 11));
    c.morphologyEx(edges, closed, c.MORPH_CLOSE, k); // seal the border into a closed loop
    k.delete();
    c.findContours(closed, contours, hier, c.RETR_EXTERNAL, c.CHAIN_APPROX_SIMPLE);
    let bestArea = 0.12 * width * height; // card must fill >=12% of the frame
    for (let i = 0; i < contours.size(); i++) {
      const cnt = contours.get(i);
      const area = c.contourArea(cnt);
      if (area > bestArea) {
        const rr = c.minAreaRect(cnt);
        const rw = rr.size.width, rh = rr.size.height;
        const rectArea = rw * rh;
        const rectangularity = rectArea > 0 ? area / rectArea : 0; // is the blob actually rectangular?
        const ar = Math.max(rw, rh) / Math.max(1, Math.min(rw, rh));
        if (rectangularity > 0.62 && ar < 3.2) {
          let pts = null;
          try { pts = c.RotatedRect.points(rr); } catch { /* unsupported */ }
          if (pts && pts.length === 4) {
            bestArea = area;
            quad = { corners: orderCorners(pts.map((p) => ({ x: p.x, y: p.y }))), dw: width, dh: height };
          }
        }
      }
      cnt.delete();
    }
  } finally {
    gray.delete(); edges.delete(); closed.delete(); contours.delete(); hier.delete();
  }
  return quad;
}

// Detect → crop → flatten. Returns a PNG buffer of the upright-ish flat card, or
// null if no confident card rectangle was found (caller falls back to the photo).
export async function dewarpCard(buffer) {
  let c;
  try { c = await cv(); } catch { return null; }
  if (!c || !c.Mat) return null;

  const quad = await findQuad(c, buffer, 1000).catch(() => null);
  if (!quad) return null;

  const { data, width, height } = await rgba(buffer, null); // warp the full-res image for quality
  const sx = width / quad.dw, sy = height / quad.dh;
  const o = quad.corners.map((p) => ({ x: p.x * sx, y: p.y * sy }));
  const W = Math.round(Math.max(dist(o[0], o[1]), dist(o[3], o[2])));
  const H = Math.round(Math.max(dist(o[0], o[3]), dist(o[1], o[2])));
  if (W < 200 || H < 120) return null;

  const src = c.matFromImageData({ data: new Uint8ClampedArray(data), width, height });
  const dst = new c.Mat();
  const srcTri = c.matFromArray(4, 1, c.CV_32FC2, [o[0].x, o[0].y, o[1].x, o[1].y, o[2].x, o[2].y, o[3].x, o[3].y]);
  const dstTri = c.matFromArray(4, 1, c.CV_32FC2, [0, 0, W, 0, W, H, 0, H]);
  let out = null;
  try {
    const M = c.getPerspectiveTransform(srcTri, dstTri);
    c.warpPerspective(src, dst, M, new c.Size(W, H), c.INTER_CUBIC, c.BORDER_REPLICATE, new c.Scalar());
    M.delete();
    out = await sharp(Buffer.from(dst.data), { raw: { width: W, height: H, channels: 4 } }).png().toBuffer();
  } finally {
    src.delete(); dst.delete(); srcTri.delete(); dstTri.delete();
  }
  return out;
}

// Adaptive (local) threshold — handles uneven light / low contrast far better
// than a single global threshold. Returns a 1-channel PNG buffer, or null.
export async function adaptiveBin(buffer, invert = false) {
  let c;
  try { c = await cv(); } catch { return null; }
  if (!c || !c.Mat) return null;
  const { data, width, height } = await rgba(buffer, null);
  const src = c.matFromImageData({ data: new Uint8ClampedArray(data), width, height });
  const gray = new c.Mat(), bin = new c.Mat();
  let out = null;
  try {
    c.cvtColor(src, gray, c.COLOR_RGBA2GRAY);
    // BINARY_INV makes light-text-on-dark cards into dark-text-on-light, which
    // Tesseract reads far better. Block 41 / C 12 suits card-sized text.
    c.adaptiveThreshold(gray, bin, 255, c.ADAPTIVE_THRESH_GAUSSIAN_C, invert ? c.THRESH_BINARY_INV : c.THRESH_BINARY, 41, 12);
    out = await sharp(Buffer.from(bin.data), { raw: { width, height, channels: 1 } }).png().toBuffer();
  } finally {
    src.delete(); gray.delete(); bin.delete();
  }
  return out;
}
