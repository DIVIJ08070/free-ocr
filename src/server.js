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
import { readAadhaarQr } from "./qr.js";

// When an Aadhaar Secure QR decodes, its UIDAI-signed fields are ground truth —
// override the OCR-guessed name/DOB/gender/address with them.
function applyQr(rec, qr) {
  if (!qr) return rec;
  rec.document_type = "AADHAAR";
  rec.name = qr.name;
  rec.dob = qr.dob;
  if (qr.gender) rec.gender = qr.gender;
  if (qr.address) rec.address = qr.address;
  // Number: prefer a full checksum-verified one — from QR if it has it, else
  // keep OCR's verified number, else fall back to the QR's masked last-4.
  if (qr.aadhaar_verified) {
    rec.aadhaar_number = qr.aadhaar_number;
    rec.aadhaar_verified = true;
    delete rec.aadhaar_masked;
  } else if (!(rec.aadhaar_number && rec.aadhaar_verified)) {
    rec.aadhaar_number = qr.aadhaar_number;
    if (qr.aadhaar_masked) rec.aadhaar_masked = true;
  }
  rec.source = "qr";
  return rec;
}

const IMAGE_EXTS = new Set([
  ".jpg", ".jpeg", ".png", ".bmp", ".tif", ".tiff", ".webp",
  ".avif", ".heic", ".heif", ".gif",
]);

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
  <title>CardSense — Smart ID Reader</title>
  <style>
    :root{
      --bg:#080b16; --panel:rgba(22,30,48,.6); --panel2:#141b2d;
      --line:rgba(148,163,184,.14); --line2:rgba(148,163,184,.24);
      --txt:#eaf0fb; --muted:#8a96ad;
      --accent:#7c8cff; --accent2:#a984ff; --ok:#34d399; --err:#fb7185; --warn:#fbbf24;
      --radius:16px;
    }
    *{box-sizing:border-box}
    body{
      font:15px/1.6 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,system-ui,sans-serif;
      margin:0; color:var(--txt); min-height:100vh;
      background:
        radial-gradient(900px 520px at 12% -12%, rgba(124,140,255,.20), transparent 60%),
        radial-gradient(820px 520px at 102% 0%, rgba(169,132,255,.15), transparent 55%),
        var(--bg);
      background-attachment:fixed; -webkit-font-smoothing:antialiased;
    }
    .wrap{max-width:840px; margin:0 auto; padding:48px 20px 80px}
    header{display:flex; align-items:center; gap:14px; margin-bottom:6px}
    .logo{width:42px; height:42px; border-radius:12px; display:grid; place-items:center; font-size:22px;
      background:linear-gradient(135deg,var(--accent),var(--accent2)); box-shadow:0 8px 30px rgba(124,140,255,.45)}
    h1{font-size:24px; font-weight:700; margin:0; letter-spacing:-.02em}
    .status{margin-left:auto; display:flex; align-items:center; gap:7px; font-size:12.5px; font-weight:600;
      color:var(--ok); background:rgba(52,211,153,.1); border:1px solid rgba(52,211,153,.25);
      padding:5px 12px; border-radius:999px}
    .status .dot{width:8px; height:8px; border-radius:50%; background:var(--ok);
      box-shadow:0 0 10px var(--ok); animation:pulse 2s infinite}
    @keyframes pulse{0%,100%{opacity:1}50%{opacity:.35}}
    .sub{color:var(--muted); margin:4px 0 28px; font-size:14px}
    #drop{background:var(--panel); border:1.5px dashed var(--line2); border-radius:var(--radius);
      backdrop-filter:blur(14px); -webkit-backdrop-filter:blur(14px);
      padding:46px 24px; text-align:center; cursor:pointer; transition:.2s}
    #drop:hover{border-color:var(--accent)}
    #drop.over{border-color:var(--accent); background:rgba(124,140,255,.08);
      box-shadow:0 0 0 4px rgba(124,140,255,.12) inset}
    .up-ic{font-size:32px; display:block; margin-bottom:10px; filter:drop-shadow(0 6px 16px rgba(124,140,255,.5))}
    #drop b{color:var(--txt); font-weight:600}
    #drop .hint{margin:8px 0 0; color:var(--muted); font-size:13px}
    .files{list-style:none; padding:0; margin:14px 0 0; display:flex; flex-wrap:wrap; gap:8px}
    .files li{display:flex; align-items:center; gap:8px; background:var(--panel2); border:1px solid var(--line);
      border-radius:10px; padding:7px 12px; font-size:13px}
    .files .sz{color:var(--muted)}
    .row{display:flex; align-items:center; gap:18px; margin:22px 0; flex-wrap:wrap}
    button{font:inherit; font-weight:600; font-size:15px; color:#fff; border:0; cursor:pointer;
      padding:12px 28px; border-radius:12px; background:linear-gradient(135deg,var(--accent),var(--accent2));
      box-shadow:0 10px 28px rgba(124,140,255,.4); transition:.18s}
    button:hover:not(:disabled){transform:translateY(-1px); box-shadow:0 14px 34px rgba(124,140,255,.55)}
    button:disabled{opacity:.45; cursor:default; box-shadow:none}
    label.chk{display:flex; align-items:center; gap:8px; color:var(--muted); font-size:14px; cursor:pointer; user-select:none}
    label.chk input{accent-color:var(--accent); width:16px; height:16px}
    .spin{display:none; align-items:center; gap:10px; color:var(--muted); font-size:13.5px}
    .spin .sp{width:18px; height:18px; border-radius:50%; border:2.5px solid rgba(148,163,184,.25);
      border-top-color:var(--accent); animation:spin .8s linear infinite}
    @keyframes spin{to{transform:rotate(360deg)}}
    .results{margin-top:26px; display:flex; flex-direction:column; gap:16px}
    .rec{background:var(--panel); border:1px solid var(--line); border-radius:var(--radius);
      backdrop-filter:blur(14px); -webkit-backdrop-filter:blur(14px); padding:20px 22px; position:relative; overflow:hidden}
    .rec::before{content:""; position:absolute; inset:0 0 auto 0; height:3px;
      background:linear-gradient(90deg,var(--accent),var(--accent2))}
    .rec.err::before{background:var(--err)}
    .rec-head{display:flex; align-items:center; gap:12px; margin-bottom:14px}
    .rec-head .fn{font-weight:600; font-size:15px; word-break:break-all}
    .rec-head .pg{color:var(--muted); font-size:12px}
    .badge{margin-left:auto; flex:none; font-size:11px; font-weight:700; letter-spacing:.04em;
      padding:5px 11px; border-radius:999px; color:#fff; background:linear-gradient(135deg,var(--accent),var(--accent2))}
    dl{margin:0; display:grid; grid-template-columns:150px 1fr}
    dt{color:var(--muted); font-size:13.5px; padding:9px 0; border-top:1px solid var(--line)}
    dd{margin:0; padding:9px 0; border-top:1px solid var(--line);
      font-family:ui-monospace,SFMono-Regular,Menlo,monospace; font-size:14px; word-break:break-word}
    .chip{display:inline-block; font-family:inherit; font-size:11.5px; font-weight:700; padding:3px 10px; border-radius:999px}
    .chip.ok{color:var(--ok); background:rgba(52,211,153,.12); border:1px solid rgba(52,211,153,.3)}
    .chip.warn{color:var(--warn); background:rgba(251,191,36,.12); border:1px solid rgba(251,191,36,.3)}
    .muted{color:var(--muted)}
    .raw{margin-top:14px; border-top:1px solid var(--line); padding-top:12px}
    .raw summary{cursor:pointer; color:var(--muted); font-size:13px}
    .raw pre{background:#05080f; border:1px solid var(--line); border-radius:10px; padding:14px; overflow-x:auto;
      font-size:12px; line-height:1.5; white-space:pre-wrap; margin:10px 0 0; color:#aeb8cc}
    .errmsg{color:var(--err); font-size:14px}
    .empty{color:var(--muted); font-size:13.5px; text-align:center; padding:8px}
  </style>
</head>
<body>
  <div class="wrap">
    <header>
      <div class="logo">🪪</div>
      <h1>CardSense</h1>
      <span class="status"><span class="dot"></span> online</span>
    </header>
    <p class="sub">Smart offline ID card reader — PAN · Aadhaar · Voter ID · Driving Licence · Passport. No cloud, no API.</p>

    <div id="drop">
      <span class="up-ic">⬆️</span>
      <b>Click to choose files</b> or drag &amp; drop here
      <p class="hint">images (JPG, PNG, TIFF, WEBP…) or PDFs — up to 25 files</p>
      <input id="file" type="file" multiple accept="image/*,application/pdf" hidden />
    </div>
    <ul class="files" id="filelist"></ul>

    <div class="row">
      <button id="go" disabled>Run OCR</button>
      <label class="chk"><input type="checkbox" id="raw" /> include raw OCR text</label>
      <span class="spin" id="spin"><span class="sp"></span> processing… first run loads the OCR model</span>
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
      fileList.innerHTML = files.map(f => '<li>📄 <span>' + f.name + '</span><span class="sz">' + fmtSize(f.size) + '</span></li>').join('');
      go.disabled = files.length === 0;
    }

    drop.addEventListener('click', () => fileInput.click());
    fileInput.addEventListener('change', e => setFiles(e.target.files));
    drop.addEventListener('dragover', e => { e.preventDefault(); drop.classList.add('over'); });
    drop.addEventListener('dragleave', () => drop.classList.remove('over'));
    drop.addEventListener('drop', e => { e.preventDefault(); drop.classList.remove('over'); setFiles(e.dataTransfer.files); });

    const esc = s => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;');
    const prettyKey = k => k.replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
    function valHtml(k, v) {
      if (v === true) return k.includes('verified') ? '<span class="chip ok">✓ verified</span>' : '<span class="chip ok">✓ yes</span>';
      if (v === false) return k.includes('verified') ? '<span class="chip warn">⚠ unverified</span>' : '<span class="chip warn">⚠ no</span>';
      if (v === null || v === undefined || v === '') return '<span class="muted">—</span>';
      return esc(v);
    }

    function render(records) {
      if (!records.length) { results.innerHTML = ''; return; }
      results.innerHTML = records.map(r => {
        if (r.error) {
          return '<div class="rec err"><div class="rec-head"><span class="fn">' + esc(r.source_file || 'error') +
                 '</span></div><div class="errmsg">⚠ ' + esc(r.error) + '</div></div>';
        }
        const skip = new Set(['source_file', 'page', 'document_type', 'raw_text']);
        const rows = Object.keys(r).filter(k => !skip.has(k))
          .map(k => '<dt>' + prettyKey(k) + '</dt><dd>' + valHtml(k, r[k]) + '</dd>').join('');
        const raw = r.raw_text ? '<details class="raw"><summary>raw OCR text</summary><pre>' +
          esc(r.raw_text) + '</pre></details>' : '';
        return '<div class="rec"><div class="rec-head">' +
          '<span class="fn">' + esc(r.source_file || 'file') + '</span>' +
          (r.page ? '<span class="pg">' + esc(r.page) + '</span>' : '') +
          '<span class="badge">' + esc(r.document_type || 'UNKNOWN') + '</span></div>' +
          '<dl>' + rows + '</dl>' + raw + '</div>';
      }).join('');
    }

    go.addEventListener('click', async () => {
      if (!files.length) return;
      const fd = new FormData();
      files.forEach(f => fd.append('files', f));
      go.disabled = true; spin.style.display = 'flex'; results.innerHTML = '';
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
        // Aadhaar QR (when present) is authoritative — overrides OCR guesses.
        try {
          applyQr(rec, await readAadhaarQr(page.buffer));
        } catch {
          /* QR is best-effort; ignore decode errors */
        }
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
      console.log(`CardSense listening on http://localhost:${PORT}`);
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
