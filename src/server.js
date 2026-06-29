// HTTP API for offline OCR of Indian ID documents.
//
//   POST /ocr      multipart upload, field "files" (one or many images/PDFs)
//                  optional query ?raw=1 to include raw OCR text per page
//   GET  /health   liveness check

import path from "node:path";
import express from "express";
import multer from "multer";

import { initOcr, ocrBest, shutdownOcr } from "./ocr.js";
import { detectAndExtract } from "./extract.js";
import { renderPdfToImages } from "./pdf.js";

const IMAGE_EXTS = new Set([".jpg", ".jpeg", ".png", ".bmp", ".tif", ".tiff", ".webp"]);

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 25 * 1024 * 1024, files: 25 }, // 25 MB / file, 25 files / request
});

const app = express();

const LANDING_HTML = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Indian ID OCR</title>
  <style>
    :root { --bg:#0f172a; --card:#1e293b; --line:#334155; --txt:#e2e8f0; --muted:#94a3b8; --accent:#6366f1; --ok:#22c55e; --err:#ef4444; }
    * { box-sizing: border-box; }
    body { font: 15px/1.5 system-ui, -apple-system, sans-serif; margin: 0; background: var(--bg); color: var(--txt); }
    .wrap { max-width: 860px; margin: 0 auto; padding: 32px 20px 64px; }
    header { display: flex; align-items: baseline; gap: 12px; margin-bottom: 4px; }
    h1 { font-size: 22px; margin: 0; }
    .status { color: var(--ok); font-size: 13px; font-weight: 600; }
    .sub { color: var(--muted); margin: 0 0 24px; font-size: 14px; }
    #drop { border: 2px dashed var(--line); border-radius: 12px; padding: 40px 20px; text-align: center; cursor: pointer; transition: .15s; background: var(--card); }
    #drop.over { border-color: var(--accent); background: #232f4b; }
    #drop p { margin: 8px 0 0; color: var(--muted); font-size: 13px; }
    #drop strong { color: var(--txt); }
    .files { list-style: none; padding: 0; margin: 16px 0 0; }
    .files li { display: flex; justify-content: space-between; background: var(--card); border: 1px solid var(--line); border-radius: 8px; padding: 8px 12px; margin-bottom: 6px; font-size: 13px; }
    .files .sz { color: var(--muted); }
    .row { display: flex; align-items: center; gap: 16px; margin: 18px 0; flex-wrap: wrap; }
    button { background: var(--accent); color: #fff; border: 0; border-radius: 8px; padding: 10px 20px; font-size: 15px; font-weight: 600; cursor: pointer; }
    button:disabled { opacity: .5; cursor: default; }
    label.chk { display: flex; align-items: center; gap: 6px; color: var(--muted); font-size: 14px; cursor: pointer; }
    .results { margin-top: 24px; }
    .rec { background: var(--card); border: 1px solid var(--line); border-radius: 10px; padding: 16px; margin-bottom: 14px; }
    .rec.err { border-color: var(--err); }
    .rec h3 { margin: 0 0 4px; font-size: 15px; }
    .rec .meta { color: var(--muted); font-size: 12px; margin-bottom: 12px; }
    .badge { display: inline-block; background: var(--accent); color: #fff; font-size: 11px; font-weight: 700; padding: 2px 8px; border-radius: 999px; vertical-align: middle; margin-left: 8px; }
    table { width: 100%; border-collapse: collapse; font-size: 14px; }
    td { padding: 5px 8px; border-top: 1px solid var(--line); vertical-align: top; }
    td.k { color: var(--muted); width: 160px; }
    td.v { font-family: ui-monospace, monospace; }
    .raw { margin-top: 10px; }
    .raw summary { cursor: pointer; color: var(--muted); font-size: 13px; }
    .raw pre { background: #0b1222; border: 1px solid var(--line); border-radius: 8px; padding: 12px; overflow-x: auto; font-size: 12px; white-space: pre-wrap; }
    .errmsg { color: var(--err); }
    .spin { display: none; color: var(--muted); font-size: 14px; }
  </style>
</head>
<body>
  <div class="wrap">
    <header><h1>Indian ID OCR</h1><span class="status">● running</span></header>
    <p class="sub">PAN · Aadhaar · Voter ID · Driving License · Passport — 100% offline.</p>

    <div id="drop">
      <strong>Click to choose files</strong> or drag &amp; drop here
      <p>images (jpg, png, tiff, webp…) or PDFs — up to 25 files</p>
      <input id="file" type="file" multiple accept="image/*,application/pdf" hidden />
    </div>
    <ul class="files" id="filelist"></ul>

    <div class="row">
      <button id="go" disabled>Run OCR</button>
      <label class="chk"><input type="checkbox" id="raw" /> include raw OCR text</label>
      <span class="spin" id="spin">⏳ processing… (first run loads OCR models, can take a bit)</span>
    </div>

    <div class="results" id="results"></div>
  </div>

  <script>
    const drop = document.getElementById('drop');
    const fileInput = document.getElementById('file');
    const fileList = document.getElementById('filelist');
    const go = document.getElementById('go');
    const spin = document.getElementById('spin');
    const results = document.getElementById('results');
    let files = [];

    const fmtSize = b => b < 1024 ? b + ' B' : b < 1048576 ? (b/1024).toFixed(1) + ' KB' : (b/1048576).toFixed(1) + ' MB';

    function setFiles(list) {
      files = Array.from(list);
      fileList.innerHTML = files.map(f => '<li><span>' + f.name + '</span><span class="sz">' + fmtSize(f.size) + '</span></li>').join('');
      go.disabled = files.length === 0;
    }

    drop.addEventListener('click', () => fileInput.click());
    fileInput.addEventListener('change', e => setFiles(e.target.files));
    drop.addEventListener('dragover', e => { e.preventDefault(); drop.classList.add('over'); });
    drop.addEventListener('dragleave', () => drop.classList.remove('over'));
    drop.addEventListener('drop', e => { e.preventDefault(); drop.classList.remove('over'); setFiles(e.dataTransfer.files); });

    function render(records) {
      results.innerHTML = records.map(r => {
        if (r.error) {
          return '<div class="rec err"><h3>' + (r.source_file || 'error') + '</h3>' +
                 '<div class="errmsg">⚠ ' + r.error + '</div></div>';
        }
        const skip = new Set(['source_file', 'page', 'document_type', 'raw_text']);
        const rows = Object.keys(r).filter(k => !skip.has(k))
          .map(k => '<tr><td class="k">' + k + '</td><td class="v">' + (r[k] ?? '—') + '</td></tr>').join('');
        const raw = r.raw_text ? '<details class="raw"><summary>raw OCR text</summary><pre>' +
          r.raw_text.replace(/</g, '&lt;') + '</pre></details>' : '';
        return '<div class="rec"><h3>' + (r.source_file || 'file') +
          '<span class="badge">' + (r.document_type || 'UNKNOWN') + '</span></h3>' +
          '<div class="meta">' + (r.page || '') + '</div>' +
          '<table>' + rows + '</table>' + raw + '</div>';
      }).join('');
    }

    go.addEventListener('click', async () => {
      if (!files.length) return;
      const fd = new FormData();
      files.forEach(f => fd.append('files', f));
      go.disabled = true; spin.style.display = 'inline'; results.innerHTML = '';
      try {
        const url = '/ocr' + (document.getElementById('raw').checked ? '?raw=1' : '');
        const res = await fetch(url, { method: 'POST', body: fd });
        const data = await res.json();
        render(Array.isArray(data) ? data : [data]);
      } catch (err) {
        results.innerHTML = '<div class="rec err"><div class="errmsg">⚠ ' + err.message + '</div></div>';
      } finally {
        go.disabled = false; spin.style.display = 'none';
      }
    });
  </script>
</body>
</html>`;

app.get("/", (_req, res) => {
  res.type("html").send(LANDING_HTML);
});

app.get("/health", (_req, res) => res.json({ status: "ok" }));

// Turn one uploaded file into a list of { label, buffer } pages.
async function pagesFor(file) {
  const ext = path.extname(file.originalname).toLowerCase();
  const mime = file.mimetype || "";

  if (ext === ".pdf" || mime === "application/pdf") {
    const imgs = await renderPdfToImages(file.buffer);
    return imgs.map((buffer, i) => ({ label: `page_${i + 1}`, buffer }));
  }
  if (IMAGE_EXTS.has(ext) || mime.startsWith("image/")) {
    return [{ label: "page_1", buffer: file.buffer }];
  }
  throw new Error(`unsupported file type: ${ext || mime || "unknown"}`);
}

app.post("/ocr", upload.any(), async (req, res) => {
  const files = req.files || [];
  if (files.length === 0) {
    return res.status(400).json({
      error: 'no files uploaded — send multipart form-data with field "files"',
    });
  }

  const wantRaw = req.query.raw === "1" || req.query.raw === "true";
  const records = [];

  for (const file of files) {
    try {
      const pages = await pagesFor(file);
      for (const page of pages) {
        const text = await ocrBest(page.buffer);
        const rec = detectAndExtract(text);
        rec.source_file = file.originalname;
        rec.page = page.label;
        if (wantRaw) rec.raw_text = text;
        records.push(rec);
      }
    } catch (err) {
      records.push({ source_file: file.originalname, error: err.message });
    }
  }

  res.json(records);
});

// Multer + general error handler (e.g. file too large / too many files).
app.use((err, _req, res, _next) => {
  res.status(400).json({ error: err.message });
});

const PORT = Number(process.env.PORT) || 3001;

initOcr()
  .then(() => {
    const server = app.listen(PORT, () => {
      console.log(`ID OCR service listening on http://localhost:${PORT}`);
    });
    const stop = async () => {
      server.close();
      await shutdownOcr();
      process.exit(0);
    };
    process.on("SIGINT", stop);
    process.on("SIGTERM", stop);
  })
  .catch((err) => {
    console.error("Failed to initialize OCR workers:", err);
    process.exit(1);
  });
