// CardSense — Business Card Scanner page.
// Art direction: "Clean machine" — ChatGPT-style AI tool. White canvas, the
// signature teal-green accent, Inter for UI + JetBrains Mono for a robotic
// data-readout feel, a sparkle AI mark, and a "thinking…" animation.
// Self-contained (CSS + JS). Talks to POST /card?mode=local|auto.

export const CARD_PAGE_HTML = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1, maximum-scale=1" />
<title>CardSense — AI Business Card Scanner</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&family=JetBrains+Mono:wght@400;500;600&display=swap" rel="stylesheet">
<style>
  :root{
    --bg:#000000; --surface:#161618; --raised:#1d1d20;
    --ink:#ececec; --body:#cfd0d4; --muted:#a3a3ad; --faint:#85858f;
    --line:rgba(255,255,255,.09); --line2:rgba(255,255,255,.17);
    --green:#19c37d; --green-d:#23d089; --green-soft:rgba(25,195,125,.14); --green-ring:rgba(25,195,125,.4);
    --r:14px; --shadow:0 1px 2px rgba(0,0,0,.4),0 12px 36px -18px rgba(0,0,0,.7);
  }
  *{box-sizing:border-box}
  html{-webkit-text-size-adjust:100%}
  body{margin:0;min-height:100vh;color:var(--body);background:var(--bg);
    font-family:'Inter',system-ui,-apple-system,"Segoe UI",sans-serif;font-size:15px;line-height:1.6;
    -webkit-font-smoothing:antialiased;text-rendering:optimizeLegibility}
  .mono{font-family:'JetBrains Mono',ui-monospace,Menlo,monospace}
  @keyframes up{from{opacity:0;transform:translateY(10px)}to{opacity:1;transform:translateY(0)}}
  @keyframes pop{from{opacity:0;transform:translateY(8px) scale(.99)}to{opacity:1;transform:none}}
  @keyframes blink{0%,49%{opacity:1}50%,100%{opacity:0}}
  @keyframes think{0%{opacity:.25;transform:translateY(0)}40%{opacity:1;transform:translateY(-3px)}80%,100%{opacity:.25;transform:translateY(0)}}
  @keyframes spin{to{transform:rotate(360deg)}}

  .wrap{max-width:680px;margin:0 auto;padding:34px 18px 24px}

  /* ── top bar ── */
  .top{display:flex;align-items:center;gap:11px;margin-bottom:34px;animation:up .45s ease both}
  .mark{width:34px;height:34px;border-radius:9px;background:var(--green);display:grid;place-items:center;flex:none;
    box-shadow:0 4px 12px -3px var(--green-ring)}
  .mark svg{width:19px;height:19px;fill:#fff}
  .top .name{font-weight:700;font-size:16px;color:var(--ink);letter-spacing:-.01em;line-height:1}
  .top .sub{font-size:11.5px;color:var(--muted);margin-top:2px}
  .top .stat{margin-left:auto;display:flex;align-items:center;gap:6px;font-size:11.5px;font-weight:500;color:var(--green);
    background:var(--green-soft);border:1px solid rgba(25,195,125,.3);padding:4px 10px;border-radius:999px}
  .top .stat .d{width:6px;height:6px;border-radius:50%;background:var(--green);animation:blink 1.6s infinite}

  /* ── hero ── */
  h1{font-size:26px;font-weight:700;letter-spacing:-.025em;color:var(--ink);margin:0 0 7px;animation:up .45s .04s ease both}
  h1 .car{display:inline-block;width:2px;height:.82em;background:var(--green);margin-left:4px;vertical-align:-1px;animation:blink 1.1s infinite}
  .lead{color:var(--muted);font-size:15px;margin:0 0 22px;animation:up .45s .08s ease both}

  /* ── card / panel ── */
  .panel{background:var(--surface);border:1px solid var(--line);border-radius:var(--r);box-shadow:var(--shadow);
    padding:18px;animation:up .45s .12s ease both}
  #drop{border:1.5px dashed var(--line2);border-radius:11px;padding:30px 18px;text-align:center;cursor:pointer;transition:.16s;background:var(--raised)}
  #drop:hover{border-color:var(--green);background:var(--green-soft)}
  #drop.over{border-color:var(--green);background:var(--green-soft)}
  .up-ic{width:42px;height:42px;border-radius:11px;margin:0 auto 11px;display:grid;place-items:center;
    background:var(--green-soft);color:var(--green)}
  .up-ic svg{width:21px;height:21px;stroke:var(--green);fill:none;stroke-width:1.7}
  #drop .t{font-weight:600;font-size:14.5px;color:var(--ink)}
  #drop .t em{color:var(--green);font-style:normal}
  #drop .hint{margin:4px 0 0;color:var(--faint);font-size:12px}

  .thumbs{display:flex;flex-wrap:wrap;gap:9px;margin-top:13px}
  .thumb{position:relative;width:98px;height:60px;border-radius:9px;overflow:hidden;border:1px solid var(--line2)}
  .thumb img{width:100%;height:100%;object-fit:cover}
  .thumb .n{position:absolute;bottom:3px;left:5px;font-size:9px;font-weight:600;letter-spacing:.06em;color:#fff;text-shadow:0 1px 2px #0009;text-transform:uppercase}
  .thumb .x{position:absolute;top:3px;right:3px;width:18px;height:18px;border-radius:50%;background:rgba(13,13,13,.55);color:#fff;font-size:12px;line-height:18px;text-align:center;cursor:pointer}

  /* ── controls ── */
  .ctl{display:flex;align-items:center;gap:11px;flex-wrap:wrap;margin-top:15px}
  .btn{font-family:inherit;font-weight:600;font-size:14px;cursor:pointer;color:#fff;border:1px solid var(--green);
    background:var(--green);padding:10px 18px;border-radius:10px;transition:.15s}
  .btn:hover:not(:disabled){background:var(--green-d);border-color:var(--green-d)}
  .btn:active:not(:disabled){transform:translateY(1px)}
  .btn:disabled{opacity:.45;cursor:default}
  .btn.ghost{color:var(--body);background:var(--surface);border-color:var(--line2)}
  .btn.ghost:hover{background:var(--raised);border-color:var(--green);color:var(--green)}
  .btn.sm{padding:8px 13px;font-size:13px}
  .switch{display:flex;align-items:center;gap:8px;font-size:13px;font-weight:500;color:var(--muted);cursor:pointer;user-select:none;margin-left:auto}
  .switch input{display:none}
  .sw{width:36px;height:21px;border-radius:999px;background:#4a4a52;position:relative;transition:.18s;flex:none}
  .sw::after{content:"";position:absolute;top:2px;left:2px;width:17px;height:17px;border-radius:50%;background:#fff;box-shadow:0 1px 2px rgba(0,0,0,.18);transition:.18s}
  .switch input:checked + .sw{background:var(--green)} .switch input:checked + .sw::after{left:17px}
  .switch .tag{font-family:'JetBrains Mono',monospace;font-size:9.5px;font-weight:600;color:#fff;background:var(--green);padding:2px 5px;border-radius:5px}

  .spin{display:none;align-items:center;gap:0;color:var(--body);font-size:13.5px;width:100%;margin-top:2px}
  .spin .cur{color:var(--green);font-weight:600;margin-left:1px;animation:blink 1s steps(2,start) infinite}

  /* ── result ── */
  .result{margin-top:16px;background:var(--surface);border:1px solid var(--line);border-radius:var(--r);box-shadow:var(--shadow);padding:20px;display:none;animation:pop .4s ease both}
  .rhead{display:flex;align-items:center;gap:12px;padding-bottom:16px;border-bottom:1px solid var(--line)}
  .rhead .ai{width:30px;height:30px;border-radius:8px;background:var(--green);display:grid;place-items:center;flex:none}
  .rhead .ai svg{width:16px;height:16px;fill:#fff}
  .rhead .nm{font-weight:700;font-size:16px;color:var(--ink);line-height:1.2}
  .rhead .ro{font-size:12.5px;color:var(--muted);margin-top:1px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
  .conf{margin-left:auto;flex:none;font-family:'JetBrains Mono',monospace;font-size:10.5px;font-weight:600;padding:4px 9px;border-radius:7px;text-transform:lowercase}
  .c-high{color:var(--green);background:var(--green-soft)} .c-medium{color:#e7b85a;background:rgba(231,184,90,.15)} .c-low{color:#f0857a;background:rgba(240,133,122,.15)}
  .meta{font-family:'JetBrains Mono',monospace;font-size:11px;color:var(--faint);margin:13px 0 2px}

  .frow{display:flex;align-items:flex-start;gap:14px;padding:11px 2px;border-bottom:1px solid var(--line);animation:up .35s ease both}
  .frow .fl{flex:none;width:118px;padding-top:4px;font-family:'JetBrains Mono',monospace;font-size:11px;font-weight:500;color:var(--faint);text-transform:uppercase;letter-spacing:.02em}
  .frow .fv{flex:1;min-width:0;display:block;border:0;background:transparent;color:var(--ink);font-family:inherit;font-size:14.5px;line-height:1.5;padding:3px 0;border-bottom:1.5px solid transparent;transition:.15s;resize:none;overflow:hidden;white-space:pre-wrap;overflow-wrap:anywhere}
  .frow .fv:focus{outline:none;border-bottom-color:var(--green)}
  .morefields{margin-top:13px}
  .morefields a{font-size:13px;font-weight:500;color:var(--green);cursor:pointer}
  .exhead{margin:20px 0 2px;font-family:'JetBrains Mono',monospace;font-size:10.5px;font-weight:600;letter-spacing:.05em;text-transform:uppercase;color:var(--green)}
  .exrow{display:flex;align-items:flex-start;gap:14px;padding:9px 2px;border-bottom:1px solid var(--line)}
  .exrow .ek{flex:none;width:130px;padding-top:3px;font-family:'JetBrains Mono',monospace;font-size:11px;color:var(--faint);text-transform:uppercase;border:0;background:transparent}
  .exrow .ev{flex:1;min-width:0;display:block;border:0;background:transparent;color:var(--ink);font-family:inherit;font-size:14px;line-height:1.5;resize:none;overflow:hidden;white-space:pre-wrap;overflow-wrap:anywhere}
  .exrow .ev:focus,.exrow .ek:focus{outline:none}
  .rowbtns{display:flex;gap:10px;margin-top:20px;flex-wrap:wrap}
  .raw{margin-top:16px;border-top:1px solid var(--line);padding-top:12px}
  .raw summary{cursor:pointer;font-family:'JetBrains Mono',monospace;font-size:11.5px;color:var(--muted)}
  .raw pre{background:#0d1117;color:#c9d1d9;border-radius:9px;padding:13px;overflow-x:auto;font:11.5px/1.55 'JetBrains Mono',monospace;white-space:pre-wrap;margin:10px 0 0}
  .empty{text-align:center;color:var(--muted);padding:8px 0;font-size:14px}
  .errbox{color:#f0857a;background:rgba(240,133,122,.12);border:1px solid rgba(240,133,122,.32);border-radius:9px;padding:11px 13px;font-size:14px}

  .toast{position:fixed;left:50%;bottom:26px;transform:translateX(-50%) translateY(16px);background:#34343a;color:#ececec;border:1px solid var(--line2);
    font-size:13px;font-weight:500;padding:10px 18px;border-radius:10px;opacity:0;transition:.22s;pointer-events:none;z-index:60}
  .toast.show{opacity:1;transform:translateX(-50%) translateY(0)}
  footer{text-align:center;color:var(--faint);font-family:'JetBrains Mono',monospace;font-size:11px;padding:26px 16px 36px}

  .cammodal{position:fixed;inset:0;background:rgba(13,13,13,.78);backdrop-filter:blur(3px);display:none;align-items:center;justify-content:center;flex-direction:column;gap:16px;z-index:50;padding:18px}
  .cammodal video{max-width:100%;max-height:66vh;border-radius:12px;background:#000}
  .cammodal .cbtns{display:flex;gap:10px}
  @media(max-width:520px){.frow .fl{width:96px}.switch{margin-left:0}.wrap{padding-top:26px}}
</style>
</head>
<body>
  <div class="wrap">
    <div class="top">
      <div class="mark"><svg viewBox="0 0 24 24"><path d="M12 1.6c.55 5.2 2.6 7.25 7.8 7.8-5.2.55-7.25 2.6-7.8 7.8-.55-5.2-2.6-7.25-7.8-7.8 5.2-.55 7.25-2.6 7.8-7.8z"/></svg></div>
      <div><div class="name">CardSense</div><div class="sub mono">ai contact extractor</div></div>
      <span class="stat"><span class="d"></span> online</span>
    </div>

    <h1>Scan a business card<span class="car"></span></h1>
    <p class="lead">Drop a card and the model reads it into clean, structured contact details — local first, AI only when it needs a second look.</p>

    <div class="panel">
      <div id="drop">
        <div class="up-ic"><svg viewBox="0 0 24 24"><path d="M12 16V4m0 0l-4 4m4-4l4 4M5 20h14" stroke-linecap="round" stroke-linejoin="round"/></svg></div>
        <div class="t"><em>Upload a card</em> or drop it here</div>
        <div class="hint">front · back · extra sides — up to 4</div>
        <input id="file" type="file" accept="image/*" multiple hidden />
        <input id="camera" type="file" accept="image/*" capture="environment" hidden />
      </div>
      <div class="thumbs" id="thumbs"></div>
      <div class="ctl">
        <button class="btn" id="go" disabled>Scan card</button>
        <button class="btn ghost sm" id="camBtn">Take photo</button>
        <label class="switch"><input type="checkbox" id="hybrid" checked /><span class="sw"></span> AI assist <span class="tag">auto</span></label>
        <span class="spin" id="spin"><span id="spintxt"></span><span class="cur">▌</span></span>
      </div>
    </div>

    <div class="result" id="result">
      <div class="rhead">
        <div class="ai"><svg viewBox="0 0 24 24"><path d="M12 1.6c.55 5.2 2.6 7.25 7.8 7.8-5.2.55-7.25 2.6-7.8 7.8-.55-5.2-2.6-7.25-7.8-7.8 5.2-.55 7.25-2.6 7.8-7.8z"/></svg></div>
        <div><div class="nm" id="nm">—</div><div class="ro" id="ro"></div></div>
        <span class="conf" id="conf"></span>
      </div>
      <div class="meta" id="meta"></div>
      <div id="fields"></div>
      <div class="morefields" id="moreFields"></div>
      <div id="extras"></div>
      <div class="rowbtns">
        <button class="btn sm" id="vcard">Save contact (vCard)</button>
        <button class="btn ghost sm" id="copyjson">Copy JSON</button>
      </div>
      <details class="raw"><summary>raw_ocr_text</summary><pre id="raw"></pre></details>
    </div>
  </div>

  <footer>100% offline ocr · ai assist only when needed · images stay on device</footer>

  <div class="cammodal" id="cammodal">
    <video id="camvideo" playsinline autoplay muted></video>
    <div class="cbtns"><button class="btn" id="capBtn">Capture</button><button class="btn ghost" id="cancelCam">Cancel</button></div>
  </div>
  <div class="toast" id="toast"></div>

<script>
  var FIELDS=[['first_name','first_name'],['last_name','last_name'],['company','company'],['designation','title'],
    ['email','email'],['phone','phone'],['whatsapp','whatsapp'],['website','website'],
    ['linkedin','linkedin'],['instagram','instagram'],['youtube','youtube'],['facebook','facebook'],['address','address']];
  var $=function(id){return document.getElementById(id)};
  var drop=$('drop'),fileInput=$('file'),camera=$('camera'),camBtn=$('camBtn'),go=$('go'),spin=$('spin'),spintxt=$('spintxt'),
    hybrid=$('hybrid'),result=$('result'),thumbs=$('thumbs'),nm=$('nm'),ro=$('ro'),conf=$('conf'),
    meta=$('meta'),fields=$('fields'),moreFields=$('moreFields'),extrasEl=$('extras'),raw=$('raw'),toast=$('toast');
  var MAX=4,files=[],LABELS=['front','back','3','4'],lastData=null,showAll=false;
  function esc(s){return String(s==null?'':s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/"/g,'&quot;')}

  function renderThumbs(){
    thumbs.innerHTML=files.map(function(f,i){return '<div class="thumb"><img src="'+URL.createObjectURL(f)+'"/><span class="n">'+(LABELS[i]||(i+1))+'</span><span class="x" data-i="'+i+'">×</span></div>'}).join('');
    go.disabled=files.length===0;
    [].forEach.call(thumbs.querySelectorAll('.x'),function(x){x.addEventListener('click',function(){files.splice(+x.dataset.i,1);renderThumbs()})});
  }
  function addFiles(list){for(var i=0;i<list.length;i++){if(files.length>=MAX)break;var f=list[i];if(f&&f.type.indexOf('image/')===0)files.push(f)}renderThumbs()}
  drop.addEventListener('click',function(){fileInput.click()});
  fileInput.addEventListener('change',function(e){addFiles(e.target.files);fileInput.value=''});
  camera.addEventListener('change',function(e){addFiles(e.target.files);camera.value=''});
  drop.addEventListener('dragover',function(e){e.preventDefault();drop.classList.add('over')});
  drop.addEventListener('dragleave',function(){drop.classList.remove('over')});
  drop.addEventListener('drop',function(e){e.preventDefault();drop.classList.remove('over');addFiles(e.dataTransfer.files)});

  var cammodal=$('cammodal'),camvideo=$('camvideo'),capBtn=$('capBtn'),cancelCam=$('cancelCam'),stream=null;
  camBtn.addEventListener('click',function(){
    if(!navigator.mediaDevices||!navigator.mediaDevices.getUserMedia){camera.click();return}
    navigator.mediaDevices.getUserMedia({video:{facingMode:{ideal:'environment'}}})
      .then(function(s){stream=s;camvideo.srcObject=s;cammodal.style.display='flex'}).catch(function(){camera.click()});
  });
  function closeCam(){if(stream){stream.getTracks().forEach(function(t){t.stop()});stream=null}cammodal.style.display='none';camvideo.srcObject=null}
  cancelCam.addEventListener('click',closeCam);
  capBtn.addEventListener('click',function(){
    var c=document.createElement('canvas');c.width=camvideo.videoWidth||1280;c.height=camvideo.videoHeight||720;
    c.getContext('2d').drawImage(camvideo,0,0,c.width,c.height);
    c.toBlob(function(b){if(b)addFiles([new File([b],'photo_'+Date.now()+'.jpg',{type:'image/jpeg'})]);closeCam()},'image/jpeg',.9);
  });

  function showToast(t){toast.textContent=t;toast.classList.add('show');setTimeout(function(){toast.classList.remove('show')},1600)}

  // ChatGPT-style typewriter status — types a step out, holds, erases it, then
  // types the next; loops through the list until the scan finishes.
  var STEPS_LOCAL=['Reading the card','Detecting orientation','Cleaning up the image','Recognizing the text','Pulling out the details','Almost done'];
  var STEPS_AI=['Reading the card','Recognizing the text','Checking the local read','Asking AI to take a closer look','Structuring the details','Almost done'];
  var typing=false;
  function startSteps(useAI){
    typing=true;
    var steps=useAI?STEPS_AI:STEPS_LOCAL,si=0,ci=0,erasing=false;
    (function tick(){
      if(!typing)return;
      var w=steps[si];
      if(!erasing){
        spintxt.textContent=w.slice(0,++ci);
        if(ci>=w.length){erasing=true;setTimeout(tick,820);}else setTimeout(tick,42+Math.random()*34);
      }else{
        spintxt.textContent=w.slice(0,--ci);
        if(ci<=0){erasing=false;si=(si+1)%steps.length;setTimeout(tick,180);}else setTimeout(tick,22);
      }
    })();
  }
  function stopSteps(){typing=false;spintxt.textContent='';}

  function grow(el){el.style.height='auto';el.style.height=el.scrollHeight+'px'}
  function growAll(){[].forEach.call(document.querySelectorAll('.fv,.ev'),grow)}
  result.addEventListener('input',function(e){var t=e.target;if(t.classList&&(t.classList.contains('fv')||t.classList.contains('ev')))grow(t)});

  function render(d){lastData=d;showAll=false;result.style.display='block';draw()}
  function draw(){
    var d=lastData;
    nm.textContent=[d.first_name,d.last_name].filter(Boolean).join(' ')||d.company||'Contact';
    ro.textContent=[d.designation,d.company].filter(Boolean).join(' · ');
    var c=d.confidence||'low';conf.textContent=c;conf.className='conf c-'+c;
    var imgs=(d.images>1?(d.images+' images · '):'');
    meta.textContent=imgs+(d.ai_used?('ai · '+(d.provider||'')+(d.tokens?(' · '+(d.tokens.input+d.tokens.output)+' tok'):'')):('local ocr'+(d.ai_note?(' · '+d.ai_note):'')));
    var has=function(f){return d[f[0]]&&String(d[f[0]]).trim()};
    var list=FIELDS.filter(function(f){return showAll||has(f)});
    var ex=(d.extras&&d.extras.length)?d.extras:[];
    fields.innerHTML=list.length?list.map(function(f,i){return '<div class="frow" style="animation-delay:'+(i*0.03).toFixed(2)+'s"><span class="fl">'+f[1]+'</span><textarea class="fv" rows="1" id="f_'+f[0]+'">'+esc(d[f[0]])+'</textarea></div>'}).join('')
      :(ex.length?'':'<div class="empty">No fields detected — turn on AI assist or try a clearer photo.</div>');
    var empty=FIELDS.filter(function(f){return !has(f)}).length;
    moreFields.innerHTML=empty>0?'<a id="tgl">'+(showAll?'Hide empty fields':('+ show all fields ('+empty+' empty)'))+'</a>':'';
    var t=$('tgl');if(t)t.addEventListener('click',function(){showAll=!showAll;draw()});
    extrasEl.innerHTML=ex.length?('<div class="exhead">other_details</div>'+ex.map(function(e){return '<div class="exrow"><input class="ek" value="'+esc(e.label)+'"/><textarea class="ev" rows="1">'+esc(e.value)+'</textarea></div>'}).join('')):'';
    raw.textContent=d.raw_text||'(none)';
    growAll();
  }
  function renderErr(m){result.style.display='block';nm.textContent='Error';ro.textContent='';conf.textContent='';meta.textContent='';
    fields.innerHTML='<div class="errbox">⚠ '+esc(m)+'</div>';moreFields.innerHTML='';extrasEl.innerHTML='';raw.textContent=''}

  go.addEventListener('click',function(){
    if(!files.length)return;
    var fd=new FormData();files.forEach(function(f){fd.append('files',f)});
    var useAI=hybrid.checked;
    go.disabled=true;spin.style.display='flex';result.style.display='none';
    startSteps(useAI);
    fetch('/card?mode='+(useAI?'auto':'local'),{method:'POST',body:fd})
      .then(function(r){return r.json()}).then(function(d){if(d.error)renderErr(d.error);else render(d)})
      .catch(function(e){renderErr(e.message)}).then(function(){stopSteps();go.disabled=false;spin.style.display='none'});
  });

  function collect(){var o={};FIELDS.forEach(function(f){var el=$('f_'+f[0]);o[f[0]]=el?el.value.trim():''});
    o.extras=[].map.call(extrasEl.querySelectorAll('.exrow'),function(r){return {label:r.querySelector('.ek').value.trim(),value:r.querySelector('.ev').value.trim()}}).filter(function(e){return e.label||e.value});return o}
  function vcard(d){var L=['BEGIN:VCARD','VERSION:3.0'];var fn=[d.first_name,d.last_name].filter(Boolean).join(' ');
    if(fn){L.push('FN:'+fn);L.push('N:'+(d.last_name||'')+';'+(d.first_name||'')+';;;')}
    if(d.company)L.push('ORG:'+d.company);if(d.designation)L.push('TITLE:'+d.designation);
    if(d.email)L.push('EMAIL;TYPE=WORK:'+d.email);if(d.phone)L.push('TEL;TYPE=WORK,VOICE:'+d.phone);
    if(d.whatsapp)L.push('TEL;TYPE=CELL:'+d.whatsapp);if(d.website)L.push('URL:'+d.website);
    if(d.address)L.push('ADR;TYPE=WORK:;;'+d.address.replace(/,/g,'\\\\,')+';;;;');
    ['linkedin','instagram','youtube','facebook'].forEach(function(k){if(d[k])L.push('X-SOCIALPROFILE;TYPE='+k+':'+d[k])});
    (d.extras||[]).forEach(function(e){L.push('NOTE:'+e.label+': '+e.value)});
    L.push('END:VCARD');return L.join('\\r\\n')}
  $('vcard').addEventListener('click',function(){var d=collect();var blob=new Blob([vcard(d)],{type:'text/vcard'});
    var a=document.createElement('a');a.href=URL.createObjectURL(blob);a.download=((d.first_name||'contact')+'_'+(d.last_name||'')).replace(/\\s+/g,'')+'.vcf';a.click();showToast('vCard downloaded')});
  $('copyjson').addEventListener('click',function(){var d=collect();
    (navigator.clipboard?navigator.clipboard.writeText(JSON.stringify(d,null,2)):Promise.reject()).then(function(){showToast('JSON copied')}).catch(function(){showToast('Copy failed')})});
</script>
</body>
</html>`;
