// HTTP API for offline OCR of Indian ID documents.
//
//   POST /ocr      multipart upload, field "files" (one or many images/PDFs)
//                  optional query ?raw=1 to include raw OCR text per page
//   GET  /health   liveness check

import fs from "node:fs";
import path from "node:path";
import express from "express";
import multer from "multer";

// Load a local .env (if present) so ANTHROPIC_API_KEY can live in a file instead
// of the shell. Existing env vars win; no dependency needed.
try {
  const env = fs.readFileSync(new URL("../.env", import.meta.url), "utf8");
  for (const line of env.split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, "");
  }
} catch {
  /* no .env file — that's fine */
}

import { initOcr, ocrBest, ocrCardRich, shutdownOcr } from "./ocr.js";
import { detectAndExtract } from "./extract.js";
import { renderPdfToImages } from "./pdf.js";
import { readAadhaarQr } from "./qr.js";
import { extractCard, extractCardSmart, localWeak } from "./card.js";
import { extractCardWithAI, mapCardWithAI, aiAvailable, aiProvider } from "./ai.js";
import { CARD_PAGE_HTML } from "./cardpage.js";

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
    <p class="sub">Smart offline ID card reader — PAN · Aadhaar · Voter ID · Driving Licence · Passport. No cloud, no API. &nbsp;·&nbsp; <a href="/cards" style="color:var(--accent2)">📇 Business Card Scanner →</a></p>

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

const CARD_HTML = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>CardSense — Business Card Scanner</title>
  <style>
    :root{--bg:#080b16;--panel:rgba(22,30,48,.6);--panel2:#141b2d;--line:rgba(148,163,184,.14);--line2:rgba(148,163,184,.24);--txt:#eaf0fb;--muted:#8a96ad;--accent:#7c8cff;--accent2:#a984ff;--ok:#34d399;--warn:#fbbf24;--err:#fb7185;--r:16px}
    *{box-sizing:border-box}
    body{font:15px/1.6 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,system-ui,sans-serif;margin:0;color:var(--txt);min-height:100vh;overflow-x:hidden;background:var(--bg);-webkit-font-smoothing:antialiased}
    /* slow-drifting gradient aura */
    body::before,body::after{content:"";position:fixed;border-radius:50%;filter:blur(60px);z-index:-1;pointer-events:none}
    body::before{width:620px;height:620px;left:-160px;top:-200px;background:radial-gradient(circle,rgba(124,140,255,.30),transparent 70%);animation:drift1 22s ease-in-out infinite}
    body::after{width:560px;height:560px;right:-160px;top:-120px;background:radial-gradient(circle,rgba(169,132,255,.26),transparent 70%);animation:drift2 26s ease-in-out infinite}
    @keyframes drift1{0%,100%{transform:translate(0,0)}50%{transform:translate(60px,80px)}}
    @keyframes drift2{0%,100%{transform:translate(0,0)}50%{transform:translate(-70px,60px)}}
    @keyframes fadeUp{from{opacity:0;transform:translateY(16px)}to{opacity:1;transform:translateY(0)}}
    @keyframes pulse{0%,100%{opacity:1}50%{opacity:.35}}
    .wrap{max-width:780px;margin:0 auto;padding:54px 20px 40px}
    header{display:flex;align-items:center;gap:14px;margin-bottom:14px;animation:fadeUp .6s ease both}
    .logo{width:48px;height:48px;border-radius:14px;display:grid;place-items:center;font-size:24px;background:linear-gradient(135deg,var(--accent),var(--accent2));box-shadow:0 10px 34px rgba(124,140,255,.5)}
    .brand{display:flex;flex-direction:column;line-height:1.15}
    h1{font-size:25px;font-weight:800;margin:0;letter-spacing:-.025em;background:linear-gradient(120deg,#fff,#c9d2ff);-webkit-background-clip:text;background-clip:text;-webkit-text-fill-color:transparent}
    .brand .tag{font-size:12.5px;color:var(--muted);font-weight:500;letter-spacing:.01em}
    .status{margin-left:auto;display:flex;align-items:center;gap:7px;font-size:12.5px;font-weight:600;color:var(--ok);background:rgba(52,211,153,.1);border:1px solid rgba(52,211,153,.25);padding:5px 12px;border-radius:999px}
    .status .dot{width:8px;height:8px;border-radius:50%;background:var(--ok);box-shadow:0 0 10px var(--ok);animation:pulse 2s infinite}
    .sub{color:var(--muted);margin:4px 0 14px;font-size:14.5px;animation:fadeUp .6s .05s ease both}
    .pills{display:flex;flex-wrap:wrap;gap:8px;margin-bottom:26px;animation:fadeUp .6s .1s ease both}
    .pills span{font-size:12px;font-weight:600;color:#c9d2ff;background:var(--panel);border:1px solid var(--line);border-radius:999px;padding:6px 12px;backdrop-filter:blur(8px)}
    footer{text-align:center;color:var(--muted);font-size:12.5px;padding:28px 20px 44px;opacity:.8}
    #drop{background:var(--panel);border:1.5px dashed var(--line2);border-radius:var(--r);backdrop-filter:blur(14px);padding:40px 24px;text-align:center;cursor:pointer;transition:.2s}
    #drop:hover{border-color:var(--accent)}
    #drop.over{border-color:var(--accent);background:rgba(124,140,255,.08)}
    .up-ic{font-size:30px;display:block;margin-bottom:8px}
    #drop b{color:var(--txt)} #drop .hint{margin:6px 0 0;color:var(--muted);font-size:13px}
    .cammodal{position:fixed;inset:0;background:rgba(0,0,0,.9);display:none;align-items:center;justify-content:center;flex-direction:column;gap:18px;z-index:50;padding:18px}
    .cammodal video{max-width:100%;max-height:68vh;border-radius:14px;background:#000;border:1px solid var(--line2)}
    .cammodal .btns{display:flex;gap:12px}
    .cammodal .cap{background:linear-gradient(135deg,var(--accent),var(--accent2));color:#fff;border:0;padding:13px 30px;border-radius:12px;font:inherit;font-weight:700;font-size:16px;cursor:pointer}
    .cammodal .cancel{background:transparent;color:#fff;border:1px solid rgba(255,255,255,.45);padding:13px 24px;border-radius:12px;font:inherit;cursor:pointer}
    .camrow{margin-top:12px;text-align:center}
    .cam{font:inherit;font-weight:600;font-size:14px;color:var(--txt);background:var(--panel2);border:1px solid var(--line2);border-radius:10px;padding:10px 20px;cursor:pointer;transition:.15s}
    .cam:hover{border-color:var(--accent);color:var(--accent)}
    .thumbs{display:flex;flex-wrap:wrap;gap:10px;margin-top:12px}
    .thumb{position:relative;width:104px;height:64px;border-radius:9px;overflow:hidden;border:1px solid var(--line2)}
    .thumb img{width:100%;height:100%;object-fit:cover}
    .thumb .x{position:absolute;top:3px;right:3px;width:19px;height:19px;border-radius:50%;background:rgba(0,0,0,.65);color:#fff;font-size:13px;line-height:19px;text-align:center;cursor:pointer}
    .thumb .n{position:absolute;bottom:2px;left:5px;font-size:10px;font-weight:700;color:#fff;text-shadow:0 1px 2px #000}
    .row{display:flex;align-items:center;gap:16px;margin:18px 0;flex-wrap:wrap}
    button{font:inherit;font-weight:600;font-size:15px;color:#fff;border:0;cursor:pointer;padding:11px 24px;border-radius:12px;background:linear-gradient(135deg,var(--accent),var(--accent2));box-shadow:0 10px 28px rgba(124,140,255,.4);transition:.18s}
    button:hover:not(:disabled){transform:translateY(-1px)} button:disabled{opacity:.45;cursor:default;box-shadow:none}
    .toggle{display:flex;align-items:center;gap:10px;color:var(--muted);font-size:14px;cursor:pointer;user-select:none}
    .sw{width:42px;height:24px;border-radius:999px;background:var(--panel2);border:1px solid var(--line2);position:relative;transition:.2s;flex:none}
    .sw::after{content:"";position:absolute;top:2px;left:2px;width:18px;height:18px;border-radius:50%;background:var(--muted);transition:.2s}
    .toggle input{display:none}
    .toggle input:checked + .sw{background:linear-gradient(135deg,var(--accent),var(--accent2));border-color:transparent}
    .toggle input:checked + .sw::after{left:22px;background:#fff}
    .ai-tag{font-size:11px;font-weight:700;color:var(--accent2);background:rgba(169,132,255,.12);border:1px solid rgba(169,132,255,.3);padding:2px 8px;border-radius:999px}
    .spin{display:none;align-items:center;gap:9px;color:var(--muted);font-size:13.5px}
    .spin .sp{width:17px;height:17px;border-radius:50%;border:2.5px solid rgba(148,163,184,.25);border-top-color:var(--accent);animation:spin .8s linear infinite}
    @keyframes spin{to{transform:rotate(360deg)}}
    .card{background:var(--panel);border:1px solid var(--line);border-radius:var(--r);backdrop-filter:blur(14px);padding:20px 22px;margin-top:22px;display:none}
    .chead{display:flex;align-items:center;gap:10px;margin-bottom:18px}
    .chead .t{font-weight:600}
    .badge{margin-left:auto;font-size:12px;font-weight:700;padding:5px 12px;border-radius:999px}
    .b-high{color:var(--ok);background:rgba(52,211,153,.12);border:1px solid rgba(52,211,153,.3)}
    .b-medium{color:var(--warn);background:rgba(251,191,36,.12);border:1px solid rgba(251,191,36,.3)}
    .b-low{color:var(--err);background:rgba(251,113,133,.12);border:1px solid rgba(251,113,133,.3)}
    .src{font-size:11px;color:var(--muted)}
    .grid{display:grid;grid-template-columns:1fr 1fr;gap:14px 16px}
    .grid .full{grid-column:1 / -1}
    label.f{display:block;color:var(--muted);font-size:12.5px;margin-bottom:5px}
    input.v{width:100%;background:var(--panel2);border:1px solid var(--line);border-radius:10px;color:var(--txt);font:14px ui-monospace,Menlo,monospace;padding:9px 11px}
    input.v:focus{outline:none;border-color:var(--accent)}
    .morefields{margin-top:12px}
    .morefields a{color:var(--muted);font-size:13px;cursor:pointer;text-decoration:underline}
    .morefields a:hover{color:var(--accent)}
    /* entrance animations */
    #drop,.camrow,.thumbs{animation:fadeUp .6s ease both}
    #drop{animation-delay:.13s}.camrow{animation-delay:.18s}
    .row{animation:fadeUp .6s .23s ease both}
    .card{animation:fadeUp .5s ease both}
    .grid>div,.chead,.exrow{animation:fadeUp .42s ease both}
    .exhead{margin:18px 0 10px;color:var(--accent2);font-size:12px;font-weight:700;letter-spacing:.04em;text-transform:uppercase}
    .exrow{display:grid;grid-template-columns:150px 1fr;gap:0 16px;margin-bottom:8px}
    .exrow input{background:var(--panel2);border:1px solid var(--line);border-radius:10px;color:var(--txt);font:14px ui-monospace,Menlo,monospace;padding:8px 11px}
    .exrow input:focus{outline:none;border-color:var(--accent)}
    .exrow .ek{color:var(--muted)}
    @media(max-width:560px){.exrow{grid-template-columns:1fr;gap:4px}}
    .raw{margin-top:16px;border-top:1px solid var(--line);padding-top:12px}
    .raw summary{cursor:pointer;color:var(--muted);font-size:13px}
    .raw pre{background:#05080f;border:1px solid var(--line);border-radius:10px;padding:12px;overflow-x:auto;font-size:12px;white-space:pre-wrap;margin:10px 0 0;color:#aeb8cc}
    .errmsg{color:var(--err);font-size:14px}
    @media(max-width:560px){.grid{grid-template-columns:1fr}}
  </style>
</head>
<body>
  <div class="wrap">
    <header>
      <div class="logo">📇</div>
      <div class="brand"><h1>CardSense</h1><span class="tag">Business Card Scanner</span></div>
      <span class="status"><span class="dot"></span> online</span>
    </header>
    <p class="sub">Snap a visiting card → clean, structured contact details. <b>AI assist</b> auto-kicks in only when the local read is weak.</p>
    <div class="pills"><span>⚡ Instant</span><span>🔒 Local-first</span><span>✨ AI when needed</span><span>🖼 Front + back merge</span></div>

    <div id="drop">
      <span class="up-ic">⬆️</span>
      <b>Click or drop</b> card photos
      <p class="hint">Add front, back &amp; any extra sides of the same card · up to 4</p>
      <input id="file" type="file" accept="image/*" multiple hidden />
      <input id="camera" type="file" accept="image/*" capture="environment" hidden />
    </div>
    <div class="camrow"><button type="button" class="cam" id="camBtn">📷 Take Photo</button></div>
    <div class="thumbs" id="thumbs"></div>

    <div class="row">
      <button id="go" disabled>Scan Card</button>
      <label class="toggle"><input type="checkbox" id="hybrid" checked /><span class="sw"></span> AI assist <span class="ai-tag">auto</span></label>
      <span class="spin" id="spin"><span class="sp"></span> <span id="spintxt">reading…</span></span>
    </div>

    <div class="card" id="card">
      <div class="chead">
        <span class="t">Review Scanned Details</span>
        <span class="badge" id="badge">—</span>
      </div>
      <div class="src" id="src"></div>
      <div class="grid" id="fields"></div>
      <div class="morefields" id="moreFields"></div>
      <div id="extras"></div>
      <details class="raw" id="rawwrap"><summary>Show raw OCR text</summary><pre id="raw"></pre></details>
    </div>
  </div>

  <div class="cammodal" id="cammodal">
    <video id="camvideo" playsinline autoplay muted></video>
    <div class="btns">
      <button class="cap" id="capBtn">📸 Capture</button>
      <button class="cancel" id="cancelCam">Cancel</button>
    </div>
  </div>

  <footer>100% offline OCR · ✨ AI assist via Groq only when needed · your card images stay on your machine</footer>

  <script>
    const FIELDS = [
      ['first_name','First Name'],['last_name','Last Name'],
      ['company','Company'],['designation','Designation / Job Title'],
      ['email','Email'],['phone','Phone'],
      ['whatsapp','WhatsApp'],['website','Website'],
      ['linkedin','LinkedIn'],['instagram','Instagram'],
      ['youtube','YouTube'],['facebook','Facebook'],
      ['address','Address / Location',true],
    ];
    const drop=document.getElementById('drop'),fileInput=document.getElementById('file'),
      go=document.getElementById('go'),spin=document.getElementById('spin'),spintxt=document.getElementById('spintxt'),
      card=document.getElementById('card'),badge=document.getElementById('badge'),src=document.getElementById('src'),
      fields=document.getElementById('fields'),thumbs=document.getElementById('thumbs'),
      extrasEl=document.getElementById('extras'),moreFields=document.getElementById('moreFields'),
      raw=document.getElementById('raw'),hybrid=document.getElementById('hybrid'),
      camBtn=document.getElementById('camBtn'),camera=document.getElementById('camera');
    const MAX=4; let files=[];
    const esc=s=>String(s==null?'':s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/"/g,'&quot;');
    const LABELS=['front','back','3','4'];

    function renderThumbs(){
      thumbs.innerHTML=files.map((f,i)=>'<div class="thumb"><img src="'+URL.createObjectURL(f)+'"/>'+
        '<span class="n">'+(LABELS[i]||(i+1))+'</span><span class="x" data-i="'+i+'">×</span></div>').join('');
      go.disabled=files.length===0;
      thumbs.querySelectorAll('.x').forEach(x=>x.addEventListener('click',()=>{files.splice(+x.dataset.i,1);renderThumbs();}));
    }
    function addFiles(list){
      for(const f of list){ if(files.length>=MAX)break; if(f&&f.type.startsWith('image/')) files.push(f); }
      renderThumbs();
    }
    drop.addEventListener('click',()=>fileInput.click());
    fileInput.addEventListener('change',e=>{addFiles(e.target.files);fileInput.value='';});
    camera.addEventListener('change',e=>{addFiles(e.target.files);camera.value='';});

    // Live camera (works on localhost / https). Falls back to the native photo
    // picker where getUserMedia is blocked (e.g. a phone on plain http LAN).
    const cammodal=document.getElementById('cammodal'),camvideo=document.getElementById('camvideo'),
      capBtn=document.getElementById('capBtn'),cancelCam=document.getElementById('cancelCam');
    let stream=null;
    async function openCamera(){
      if(!navigator.mediaDevices||!navigator.mediaDevices.getUserMedia){ camera.click(); return; }
      try{
        stream=await navigator.mediaDevices.getUserMedia({video:{facingMode:{ideal:'environment'}}});
        camvideo.srcObject=stream; cammodal.style.display='flex';
      }catch(err){ camera.click(); } // permission denied / not available → native picker
    }
    function closeCamera(){ if(stream){stream.getTracks().forEach(t=>t.stop());stream=null;} cammodal.style.display='none'; camvideo.srcObject=null; }
    camBtn.addEventListener('click',openCamera);
    cancelCam.addEventListener('click',closeCamera);
    capBtn.addEventListener('click',()=>{
      const c=document.createElement('canvas'); c.width=camvideo.videoWidth||1280; c.height=camvideo.videoHeight||720;
      c.getContext('2d').drawImage(camvideo,0,0,c.width,c.height);
      c.toBlob(b=>{ if(b) addFiles([new File([b],'photo_'+Date.now()+'.jpg',{type:'image/jpeg'})]); closeCamera(); },'image/jpeg',0.9);
    });
    drop.addEventListener('dragover',e=>{e.preventDefault();drop.classList.add('over')});
    drop.addEventListener('dragleave',()=>drop.classList.remove('over'));
    drop.addEventListener('drop',e=>{e.preventDefault();drop.classList.remove('over');addFiles(e.dataTransfer.files)});

    let lastData=null, showAll=false;
    function render(d){ lastData=d; showAll=false; draw(); }
    function draw(){
      const d=lastData; card.style.display='block';
      const c=(d.confidence||'low');
      badge.textContent=(c[0].toUpperCase()+c.slice(1))+' confidence';
      badge.className='badge b-'+c;
      const imgs=(d.images>1?('🖼 '+d.images+' images merged  ·  '):'');
      src.textContent = imgs + (d.ai_used
        ? ('✨ AI assisted'+(d.escalated?' (escalated)':'')+' · '+(d.provider||'')+' '+(d.model||'')+(d.tokens?('  ·  '+(d.tokens.input+d.tokens.output)+' tokens'):''))
        : ('🆓 Local OCR'+(d.ai_note?('  ·  '+d.ai_note):'')));
      const has=([k])=>d[k]&&String(d[k]).trim();
      const list=FIELDS.filter(f=>showAll||has(f));
      const ex=Array.isArray(d.extras)?d.extras:[];
      fields.innerHTML = list.length
        ? list.map(([k,lbl,full],i)=>'<div'+(full?' class="full"':'')+' style="animation-delay:'+(i*0.04).toFixed(2)+'s"><label class="f">'+lbl+'</label>'+
            '<input class="v" id="f_'+k+'" value="'+esc(d[k])+'" /></div>').join('')
        : (ex.length?'':'<div class="full muted">No fields detected — try AI assist or a clearer photo.</div>');
      const empty=FIELDS.length-FIELDS.filter(has).length;
      moreFields.innerHTML = empty>0 ? '<a id="toggleAll">'+(showAll?'Hide empty fields':('＋ Show all fields ('+empty+' empty)'))+'</a>' : '';
      const ta=document.getElementById('toggleAll'); if(ta) ta.addEventListener('click',()=>{showAll=!showAll;draw();});
      extrasEl.innerHTML = ex.length
        ? '<div class="exhead">Other details</div>'+ex.map(e=>
            '<div class="exrow"><input class="ek" value="'+esc(e.label)+'"/><input class="ev" value="'+esc(e.value)+'"/></div>').join('')
        : '';
      raw.textContent=d.raw_text||'(none)';
    }
    function renderErr(msg){ card.style.display='block'; badge.textContent='error'; badge.className='badge b-low';
      src.textContent=''; fields.innerHTML='<div class="full errmsg">⚠ '+esc(msg)+'</div>'; raw.textContent=''; }

    go.addEventListener('click',async()=>{
      if(!files.length)return;
      const fd=new FormData(); files.forEach(f=>fd.append('files',f));
      const useAI=hybrid.checked;
      go.disabled=true; spin.style.display='flex'; card.style.display='none';
      spintxt.textContent=useAI?'reading card… (AI if needed)':'reading card…';
      try{
        const res=await fetch('/card?mode='+(useAI?'auto':'local'),{method:'POST',body:fd});
        const d=await res.json();
        if(d.error) renderErr(d.error); else render(d);
      }catch(e){ renderErr(e.message); }
      finally{ go.disabled=false; spin.style.display='none'; }
    });
  </script>
</body>
</html>`;

// Business Card scanner is the homepage. The ID-OCR page is hidden (still
// reachable at /id, just not linked) for now.
app.get("/", (_req, res) => {
  res.type("html").send(CARD_PAGE_HTML);
});

app.get("/cards", (_req, res) => {
  res.type("html").send(CARD_PAGE_HTML);
});

app.get("/id", (_req, res) => {
  res.type("html").send(LANDING_HTML);
});

app.get("/health", (_req, res) => {
  const p = aiProvider();
  res.json({ status: "ok", ai: Boolean(p), provider: p ? p.name : null, model: p ? p.model : null });
});

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

// Business-card scanner. One card may have several images (front / back / extra
// photos) — they're OCR'd and merged into ONE contact.
// mode: local (free OCR+regex) | auto (AI only if local is weak) | hybrid (always AI)
app.post("/card", upload.any(), async (req, res) => {
  const buffers = (req.files || []).slice(0, 4).map((f) => f.buffer);
  if (buffers.length === 0) {
    return res.status(400).json({ error: 'no files uploaded — field "files"' });
  }
  const mode = req.query.mode || req.body.mode || "local";
  const haveAi = aiAvailable();
  try {
    // OCR every side (with per-line geometry); combine text for the raw panel,
    // and run layout-aware extraction across all sides.
    const pages = await Promise.all(buffers.map((b) => ocrCardRich(b).catch(() => ({ text: "", lines: [] }))));
    const text =
      buffers.length > 1
        ? pages.map((p, i) => `--- image ${i + 1} ---\n${p.text}`).join("\n\n")
        : pages[0].text;
    const local = extractCardSmart(pages);

    let rec = local;
    let aiUsed = false;
    // When AI assist is on, map the (already local, free) OCR text → fields with a
    // cheap text model — no image sent. Rules stay as an instant fallback.
    const wantAi = mode !== "local";
    if (wantAi && haveAi) {
      try {
        rec = await mapCardWithAI(text);
        aiUsed = true;
      } catch (e) {
        // AI hiccup (rate limit / bad reply / network) — never fail the request.
        rec = local;
        rec.ai_note = "AI mapping failed, showing local result — " + e.message;
      }
    } else if (wantAi && !haveAi) {
      rec.ai_note = "AI requested but no API key set (GROQ / XAI / OPENAI / ANTHROPIC).";
    }

    rec.ai_used = aiUsed;
    rec.mode = mode;
    rec.images = buffers.length;
    rec.raw_text = text;
    res.json(rec);
  } catch (err) {
    res.status(500).json({ error: err.message, mode });
  }
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
