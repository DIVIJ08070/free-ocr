// Neural OCR via PaddleOCR (PP-OCR ONNX models on onnxruntime — 100% offline,
// free, no cloud). Dramatically more accurate than Tesseract on real-world
// photos: low-contrast, coloured, textured, slightly blurred cards.
//
// PaddleOCR wants upright text, so we read the image at all four 90° rotations
// and keep whichever yields the most high-confidence text. Returns the same
// { text, lines:[{text,conf,h,x,y}] } shape the rest of the pipeline expects, so
// the layout-aware field extractor works unchanged. Returns null if the engine
// can't load (then the caller falls back to Tesseract).

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import sharp from "sharp";

let _ocr = null;
let _failed = false;
async function engine() {
  if (_ocr) return _ocr;
  if (_failed) return null;
  try {
    const mod = await import("@gutenye/ocr-node");
    const Ocr = mod.default || mod;
    _ocr = await Ocr.create({});
    return _ocr;
  } catch {
    _failed = true; // missing native binary / unsupported platform → use Tesseract
    return null;
  }
}

export async function paddleAvailable() {
  return (await engine()) != null;
}

const ROT = [0, 90, 180, 270];
let _tmpN = 0;
const tmpPath = () => path.join(os.tmpdir(), `cardsense_${process.pid}_${Date.now()}_${++_tmpN}.png`);

function boxGeom(box) {
  if (!Array.isArray(box) || !box.length) return { x: 0, y: 0, h: 0 };
  const xs = box.map((p) => (Array.isArray(p) ? p[0] : p.x));
  const ys = box.map((p) => (Array.isArray(p) ? p[1] : p.y));
  return { x: Math.min(...xs), y: Math.min(...ys), h: Math.max(...ys) - Math.min(...ys) };
}

async function detectFile(ocr, buf) {
  const p = tmpPath();
  try {
    fs.writeFileSync(p, buf);
    const res = await ocr.detect(p, { language: "en" });
    return Array.isArray(res) ? res : [];
  } catch {
    return [];
  } finally {
    try { fs.unlinkSync(p); } catch { /* ignore */ }
  }
}
// total high-confidence text — used to pick the upright orientation
const scoreArr = (arr) => arr.reduce((s, l) => s + (l.mean || 0) * (l.text ? l.text.length : 0), 0);

export async function ocrCardPaddle(inputBuffer) {
  const ocr = await engine();
  if (!ocr) return null;
  const oriented = await sharp(inputBuffer).rotate().toFormat("png").toBuffer(); // EXIF-correct once

  // 1) Cheap orientation probe on a small image — pick the upright 90° rotation.
  const small = await sharp(oriented).resize({ width: 720, withoutEnlargement: true }).toFormat("png").toBuffer();
  let bestDeg = 0, bestScore = -1;
  for (const deg of ROT) {
    const r = deg ? await sharp(small).rotate(deg).toFormat("png").toBuffer() : small;
    const sc = scoreArr(await detectFile(ocr, r));
    if (sc > bestScore) { bestScore = sc; bestDeg = deg; }
  }

  // 2) ONE full-resolution read at the chosen rotation (the accurate, costly pass).
  const full = await sharp(oriented).resize({ width: 1600, withoutEnlargement: true }).rotate(bestDeg).toFormat("png").toBuffer();
  const arr = await detectFile(ocr, full);
  if (!arr.length) return null;

  const lines = arr
    .map((l) => {
      const g = boxGeom(l.box || l.frame || l.points || l.bbox);
      return {
        text: String(l.text || "").replace(/\s*@\s*/g, "@").trim(), // fix "info @host" → "info@host"
        conf: Math.round((l.mean || 0) * 100),
        h: g.h,
        x: g.x,
        y: g.y,
      };
    })
    .filter((l) => l.text);
  lines.sort((a, b) => a.y - b.y);
  return { text: lines.map((l) => l.text).join("\n"), lines };
}
