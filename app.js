const STATE = {
  focal:null, toneKey:null, shades:null, focalData:null,
  currentStep:0, stepResults:[], faceMesh:null, camera:null,
  stream:null, lastLandmarks:null, checkPending:false,
};
 
const STEPS       = ['lips','blush','eyebrows','contour'];
const STEP_LABELS = { lips:'Lips', blush:'Blush', eyebrows:'Eyebrows', contour:'Contour' };
 
const STEP_INSTRUCTIONS = {
  lips:     'Follow the glowing outline on your lips. Start at the gold dot on the V-shape at the top center, then work outward to each corner. Fill in the top, then repeat from the bottom center outward.',
  blush:    'Smile softly and sweep blush onto the apples of your cheeks, blending upward along the oval guide.',
  eyebrows: 'Fill in your brows following the guide. Use short, hair-like strokes for a natural finish.',
  contour:  'Apply contour below your cheekbones and along your jawline using the outline as your guide.',
};
 
// ── LIP LANDMARKS ──
const LIP_OUTER_LOOP = [
  61, 185, 40, 39, 37, 0, 267, 269, 270, 409, 291,
  375, 321, 405, 314, 17, 84, 181, 91, 146
];
const LIP_INNER = [
  78, 191, 80, 81, 82, 13, 312, 311, 310, 415, 308,
  324, 318, 402, 317, 14, 87, 178, 88, 95
];
const LM_CUPID_VALLEY  = 0;
const LM_BOTTOM_CENTER = 17;
 
const BLUSH_LEFT  = [116,123,147,213,192,214,212,202,204,194,32,31,228,229,230,231,232,233,128,121,120,119,118,117];
const BLUSH_RIGHT = [345,352,376,433,411,434,432,422,424,414,262,261,448,449,450,451,452,453,357,350,349,348,347,346];
const BROW_LEFT_TOP     = [70,63,105,66,107];
const BROW_LEFT_BOTTOM  = [46,53,52,65,55];
const BROW_RIGHT_TOP    = [300,293,334,296,336];
const BROW_RIGHT_BOTTOM = [276,283,282,295,285];
const JAW_LEFT       = [234,93,132,58,172,136,150,149,176,148,152];
const JAW_RIGHT      = [454,323,361,288,397,365,379,378,400,377,152];
const CHEEK_HOLLOW_L = [123,50,36,203,142,126,209,49,129,64];
const CHEEK_HOLLOW_R = [352,280,266,423,371,355,429,279,358,294];
 
const SAMPLE_IDX = {
  lips:     [13,14,0,17,61,291,40,270],
  blush:    [123,352,116,345,50,280,205,425],
  eyebrows: [70,300,66,296,63,293,105,334],
  contour:  [172,397,136,365,58,288,152,148],
};
 
// ─────────────────────────────────────────
//  CANVAS / OVERLAY SYNC
//
//  This is the core fix. We match the canvas's intrinsic
//  pixel dimensions to the video element's CSS display size.
//  Landmarks (normalised 0–1) × W/H then land on exactly
//  the right screen pixel regardless of CSS scaling.
//
//  Returns { W, H } so callers use them for drawing.
// ─────────────────────────────────────────
function syncOverlay(canvasEl, videoEl) {
  const rect = videoEl.getBoundingClientRect();
  const W    = Math.round(rect.width)  || videoEl.videoWidth  || 640;
  const H    = Math.round(rect.height) || videoEl.videoHeight || 480;
  // Only update when dimensions actually changed — avoids clearing the canvas unnecessarily
  if (canvasEl.width !== W)  canvasEl.width  = W;
  if (canvasEl.height !== H) canvasEl.height = H;
  return { W, H };
}
 
// ─────────────────────────────────────────
//  PATH HELPERS
// ─────────────────────────────────────────
// Plain polygon — passes through every point, zero overshoot
function polyPath(ctx, pts) {
  if (!pts.length) return;
  ctx.moveTo(pts[0].x, pts[0].y);
  for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i].x, pts[i].y);
  ctx.closePath();
}
 
// Midpoint-rounded polygon for the fill — slightly softer corners,
// still never goes outside the landmark positions
function softPolyPath(ctx, pts) {
  const n = pts.length; if (n < 2) return;
  const s = { x:(pts[n-1].x+pts[0].x)/2, y:(pts[n-1].y+pts[0].y)/2 };
  ctx.moveTo(s.x, s.y);
  for (let i = 0; i < n; i++) {
    const a = pts[i], b = pts[(i+1)%n];
    ctx.quadraticCurveTo(a.x, a.y, (a.x+b.x)/2, (a.y+b.y)/2);
  }
  ctx.closePath();
}
 
function lmPts(lm, indices, W, H) {
  return indices.map(i => ({ x: lm[i].x * W, y: lm[i].y * H }));
}
 
// ─────────────────────────────────────────
//  DATA LOADING
// ─────────────────────────────────────────
async function loadData() {
  try {
    const [s, f] = await Promise.all([
      fetch('data/shades.json').then(r => r.json()),
      fetch('data/focal-points.json').then(r => r.json()),
    ]);
    STATE.shades = s; STATE.focalData = f;
    console.log('Data loaded. Keys:', Object.keys(s));
  } catch(e) { console.error('Data load error:', e); }
}
 
// ─────────────────────────────────────────
//  SCREEN NAVIGATION
// ─────────────────────────────────────────
function goTo(id) {
  document.querySelectorAll('.screen').forEach(s => s.classList.remove('active'));
  document.getElementById(id)?.classList.add('active');
  if (id === 'screen-camera') initCamera();
  else if (id !== 'screen-step') stopStream();
}
 
// ─────────────────────────────────────────
//  PARTICLES
// ─────────────────────────────────────────
function initParticles() {
  const canvas = document.getElementById('particles-bg'), ctx = canvas.getContext('2d');
  let W, H, P = [];
  function resize() { W = canvas.width = window.innerWidth; H = canvas.height = window.innerHeight; }
  resize(); window.addEventListener('resize', resize);
  for (let i = 0; i < 60; i++) P.push({
    x:Math.random()*window.innerWidth, y:Math.random()*window.innerHeight,
    r:Math.random()*1.4+0.3, dx:(Math.random()-.5)*.4, dy:(Math.random()-.5)*.4, o:Math.random()*.5+.1
  });
  (function draw() {
    ctx.clearRect(0,0,W,H);
    P.forEach(p => {
      ctx.beginPath(); ctx.arc(p.x,p.y,p.r,0,Math.PI*2);
      ctx.fillStyle=`rgba(201,149,106,${p.o})`; ctx.fill();
      p.x+=p.dx; p.y+=p.dy;
      if(p.x<0)p.x=W; if(p.x>W)p.x=0; if(p.y<0)p.y=H; if(p.y>H)p.y=0;
    });
    requestAnimationFrame(draw);
  })();
}
 
// ─────────────────────────────────────────
//  FOCAL SELECTION
// ─────────────────────────────────────────
function selectFocal(focal, el) {
  STATE.focal = focal;
  document.querySelectorAll('.focal-card').forEach(c => c.classList.remove('selected'));
  el.classList.add('selected');
  document.getElementById('btn-to-camera').disabled = false;
}
 
// ─────────────────────────────────────────
//  CAMERA SETUP
// ─────────────────────────────────────────
async function initCamera() {
  const video   = document.getElementById('video');
  const titleEl = document.getElementById('cam-title');
  const subEl   = document.getElementById('cam-sub');
  titleEl.textContent = 'Requesting camera...';
  subEl.textContent   = 'Allow camera permission when prompted';
  try {
    STATE.stream = await navigator.mediaDevices.getUserMedia(
      { video: { width:{ideal:640}, height:{ideal:480}, facingMode:'user' } });
    video.srcObject = STATE.stream;
    video.onloadedmetadata = () => {
      titleEl.textContent = 'Camera ready ✓';
      subEl.textContent   = 'Click Detect My Face when ready';
      document.getElementById('btn-detect').disabled = false;
      startLightingCheck();
    };
  } catch(e) {
    titleEl.textContent = 'Camera access denied';
    subEl.textContent   = 'Please allow camera access in browser settings';
  }
}
 
function stopStream() {
  if (STATE.stream) { STATE.stream.getTracks().forEach(t => t.stop()); STATE.stream = null; }
  if (STATE.faceMesh) { try { STATE.faceMesh.close(); } catch(e) {} STATE.faceMesh = null; }
  STATE.camera = null;
}
 
// ─────────────────────────────────────────
//  LIGHTING CHECK
// ─────────────────────────────────────────
function startLightingCheck() {
  const video = document.getElementById('video');
  const warn  = document.getElementById('light-warn');
  const tmp   = document.createElement('canvas'); tmp.width=64; tmp.height=48;
  const tctx  = tmp.getContext('2d');
  setInterval(() => {
    if (!STATE.stream) return;
    try {
      tctx.drawImage(video,0,0,64,48);
      const d = tctx.getImageData(0,0,64,48).data;
      let br = 0;
      for (let i=0; i<d.length; i+=4) br += d[i]*.299 + d[i+1]*.587 + d[i+2]*.114;
      warn.classList.toggle('hide', (br/(d.length/4)) >= 55);
    } catch(e) {}
  }, 1500);
}
 
// ─────────────────────────────────────────
//  MEDIAPIPE — DETECTION SCREEN
// ─────────────────────────────────────────
function startDetection() {
  document.getElementById('cam-title').textContent = 'Scanning your face...';
  document.getElementById('cam-sub').textContent   = 'Keep still and look straight ahead';
  document.getElementById('btn-detect').disabled   = true;
  const video = document.getElementById('video');
  if (!STATE.faceMesh) {
    STATE.faceMesh = new FaceMesh({ locateFile: f => `https://cdn.jsdelivr.net/npm/@mediapipe/face_mesh/${f}` });
    STATE.faceMesh.setOptions({ maxNumFaces:1, refineLandmarks:true, minDetectionConfidence:.6, minTrackingConfidence:.6 });
  }
  STATE.faceMesh.onResults(onDetectResults);
  STATE.camera = new Camera(video, {
    onFrame: async () => { if (STATE.faceMesh) await STATE.faceMesh.send({ image: video }); },
    width:640, height:480,
  });
  STATE.camera.start();
}
 
function onDetectResults(results) {
  const canvas = document.getElementById('overlay');
  const video  = document.getElementById('video');
 
  // FIX: sync canvas to video's DISPLAYED size, not raw resolution
  const { W, H } = syncOverlay(canvas, video);
 
  const ctx = canvas.getContext('2d');
  ctx.clearRect(0, 0, W, H);
 
  const pFace = document.getElementById('pill-face');
  const pLM   = document.getElementById('pill-lm');
  const pTone = document.getElementById('pill-tone');
 
  if (results.multiFaceLandmarks?.length > 0) {
    const lm = results.multiFaceLandmarks[0];
    STATE.lastLandmarks = lm;
    pFace.textContent = 'Face: Detected ✓'; pFace.classList.add('ok');
    pLM.textContent   = 'Landmarks: 468 ✓'; pLM.classList.add('ok');
 
    ctx.fillStyle = 'rgba(201,149,106,0.22)';
    lm.forEach(pt => { ctx.beginPath(); ctx.arc(pt.x*W, pt.y*H, 1.4, 0, Math.PI*2); ctx.fill(); });
 
    drawLips    (ctx,lm,W,H,'rgba(220,130,120,0.78)','rgba(220,130,120,0.18)',2,false);
    drawBrows   (ctx,lm,W,H,'rgba(180,130,80,0.7)', 'rgba(160,110,60,0.15)',3);
    drawBlush   (ctx,lm,W,H,'rgba(230,150,140,0.55)','rgba(230,150,140,0.10)',2);
    drawContour (ctx,lm,W,H,'rgba(190,140,80,0.6)', 'rgba(170,120,60,0.10)',2.5);
 
    if (!STATE.toneKey) {
      const tone = detectToneFromImage(results.image, lm, W, H);
      if (tone) {
        STATE.toneKey = tone;
        pTone.textContent = `Tone: ${formatTone(tone)} ✓`; pTone.classList.add('ok');
        document.getElementById('cam-title').textContent = 'Analysis complete!';
        document.getElementById('cam-sub').textContent   = 'Tap below to see your shade recommendations';
        const btn = document.getElementById('btn-detect');
        btn.textContent = 'See My Recommendations →'; btn.disabled = false; btn.onclick = showShades;
      }
    }
  } else {
    pFace.textContent = 'Face not found — step closer'; pFace.classList.remove('ok');
    pLM.textContent   = 'Landmarks: —'; pLM.classList.remove('ok');
  }
}
 
// ─────────────────────────────────────────
//  DRAW LIPS
// ─────────────────────────────────────────
function drawLips(ctx, lm, W, H, strokeColor, fillColor, lw, filterMode) {
  const outerPts = lmPts(lm, LIP_OUTER_LOOP, W, H);
  const innerPts = lmPts(lm, LIP_INNER, W, H);
 
  // Soft fill
  if (fillColor) {
    ctx.beginPath(); softPolyPath(ctx, outerPts);
    ctx.fillStyle = fillColor; ctx.fill();
  }
 
  // Wide glow pass (filter mode only)
  if (filterMode) {
    ctx.save();
    ctx.beginPath(); polyPath(ctx, outerPts);
    ctx.strokeStyle = strokeColor; ctx.lineWidth = lw*5;
    ctx.globalAlpha = 0.18; ctx.lineJoin = 'round'; ctx.stroke();
    ctx.restore();
  }
 
  // Sharp outline — plain polygon, exact landmark positions
  ctx.save();
  ctx.beginPath(); polyPath(ctx, outerPts);
  ctx.strokeStyle = strokeColor; ctx.lineWidth = lw;
  ctx.lineJoin = 'round'; ctx.stroke();
  ctx.restore();
 
  // Inner lip line
  ctx.save();
  ctx.beginPath(); polyPath(ctx, innerPts);
  ctx.strokeStyle = strokeColor.replace(/[\d.]+\)$/, '0.4)');
  ctx.lineWidth = Math.max(1, lw*0.55); ctx.lineJoin = 'round'; ctx.stroke();
  ctx.restore();
 
  if (!filterMode) return;
 
  // Pulsing gold dots
  const pulse  = 0.5 + 0.5 * ((Math.sin(Date.now()/400)+1)/2);
  const valley = { x: lm[LM_CUPID_VALLEY].x  * W, y: lm[LM_CUPID_VALLEY].y  * H };
  const btmC   = { x: lm[LM_BOTTOM_CENTER].x * W, y: lm[LM_BOTTOM_CENTER].y * H };
  const dotR   = Math.max(4, Math.abs(btmC.y - valley.y) * 0.11);
 
  [{ pt:valley, a:pulse }, { pt:btmC, a:pulse*0.8 }].forEach(({ pt, a }) => {
    ctx.save();
    ctx.globalAlpha = a; ctx.shadowColor = '#ffe066'; ctx.shadowBlur = dotR*3.5;
    ctx.beginPath(); ctx.arc(pt.x, pt.y, dotR, 0, Math.PI*2);
    ctx.fillStyle = '#ffe066'; ctx.fill();
    ctx.restore();
  });
}
 
// ─────────────────────────────────────────
//  OTHER ZONE HELPERS
// ─────────────────────────────────────────
function drawBrows(ctx, lm, W, H, sc, fc, lw) {
  [[BROW_LEFT_TOP,BROW_LEFT_BOTTOM],[BROW_RIGHT_TOP,BROW_RIGHT_BOTTOM]].forEach(([top,bot]) => {
    ctx.beginPath();
    ctx.moveTo(lm[top[0]].x*W, lm[top[0]].y*H);
    top.slice(1).forEach(i => ctx.lineTo(lm[i].x*W, lm[i].y*H));
    [...bot].reverse().forEach(i => ctx.lineTo(lm[i].x*W, lm[i].y*H));
    ctx.closePath();
    if (fc) { ctx.fillStyle=fc; ctx.fill(); }
    ctx.strokeStyle=sc; ctx.lineWidth=lw; ctx.stroke();
  });
}
 
function drawBlush(ctx, lm, W, H, sc, fc, lw) {
  [BLUSH_LEFT,BLUSH_RIGHT].forEach(idx => {
    ctx.beginPath();
    ctx.moveTo(lm[idx[0]].x*W, lm[idx[0]].y*H);
    idx.slice(1).forEach(i => ctx.lineTo(lm[i].x*W, lm[i].y*H));
    ctx.closePath();
    if (fc) { ctx.fillStyle=fc; ctx.fill(); }
    ctx.strokeStyle=sc; ctx.lineWidth=lw; ctx.stroke();
  });
}
 
function drawContour(ctx, lm, W, H, sc, fc, lw) {
  [JAW_LEFT,JAW_RIGHT].forEach(idx => {
    ctx.beginPath();
    ctx.moveTo(lm[idx[0]].x*W, lm[idx[0]].y*H);
    idx.slice(1).forEach(i => ctx.lineTo(lm[i].x*W, lm[i].y*H));
    ctx.closePath();
    if (fc) { ctx.fillStyle=fc; ctx.fill(); }
    ctx.strokeStyle=sc; ctx.lineWidth=lw; ctx.stroke();
  });
  [CHEEK_HOLLOW_L,CHEEK_HOLLOW_R].forEach(idx => {
    ctx.beginPath();
    ctx.moveTo(lm[idx[0]].x*W, lm[idx[0]].y*H);
    idx.slice(1).forEach(i => ctx.lineTo(lm[i].x*W, lm[i].y*H));
    ctx.closePath();
    ctx.strokeStyle=sc; ctx.lineWidth=lw*0.8; ctx.stroke();
  });
}
 
// ─────────────────────────────────────────
//  SKIN TONE
// ─────────────────────────────────────────
function detectToneFromImage(image, lm, W, H) {
  try {
    // Sample at video's actual resolution for accuracy
    const vW = image.width  || W;
    const vH = image.height || H;
    const tmp = document.createElement('canvas'); tmp.width=vW; tmp.height=vH;
    const ctx = tmp.getContext('2d'); ctx.drawImage(image,0,0,vW,vH);
    const pts = [lm[234],lm[454],lm[1],lm[6],lm[199],lm[117],lm[346],lm[50]];
    let tR=0,tG=0,tB=0,n=0;
    pts.forEach(pt => {
      for (let dx=-1;dx<=1;dx++) for (let dy=-1;dy<=1;dy++) {
        const x=Math.round(pt.x*vW)+dx, y=Math.round(pt.y*vH)+dy;
        if (x>=0&&x<vW&&y>=0&&y<vH) {
          const d=ctx.getImageData(x,y,1,1).data; tR+=d[0]; tG+=d[1]; tB+=d[2]; n++;
        }
      }
    });
    if (!n) return 'medium_warm';
    const r=tR/n, g=tG/n, b=tB/n, br=r*.299+g*.587+b*.114;
    return `${br>160?'light':br>105?'medium':'dark'}_${(r-b)>18?'warm':'cool'}`;
  } catch(e) { return 'medium_warm'; }
}
 
function formatTone(k) {
  return { light_warm:'Light Warm', light_cool:'Light Cool', medium_warm:'Medium Warm',
           medium_cool:'Medium Cool', dark_warm:'Deep Warm', dark_cool:'Deep Cool' }[k] || k;
}
 
// ─────────────────────────────────────────
//  SHADE RECOMMENDATIONS
// ─────────────────────────────────────────
function showShades() {
  const toneKey = STATE.toneKey || 'medium_warm';
  const tone    = STATE.shades?.[toneKey];
  if (!tone) { console.error('No shades for', toneKey); return; }
  document.getElementById('shade-tone-label').textContent = `Skin tone: ${formatTone(toneKey)} · Soft & Natural`;
  const map   = { lips:'lips', eyebrows:'eyebrows', cheeks:'blush', contour:'contour' };
  const focal = map[STATE.focal] || STATE.focal;
  document.getElementById('focal-badge-label').textContent = STATE.focalData?.[STATE.focal]?.label || STATE.focal;
  const grid = document.getElementById('shade-grid'); grid.innerHTML = '';
  STEPS.forEach(step => {
    const shade = tone[step]; if (!shade) return;
    const isFocal = step === focal;
    const card = document.createElement('div');
    card.className = 'shade-card' + (isFocal ? ' focal-highlight' : '');
    card.innerHTML = `
      <div class="shade-swatch" style="background:${shade.hex}"></div>
      <div class="shade-step-label">${STEP_LABELS[step]}${isFocal?'<span class="focal-star"> ★</span>':''}</div>
      <div class="shade-name-txt">${shade.shade}</div>
      <div class="shade-brand-txt">${shade.brand||shade.product||''}</div>
      <div class="shade-slot-badge">Tray slot ${shade.slot}</div>`;
    grid.appendChild(card);
  });
  goTo('screen-shades');
}
 
// ─────────────────────────────────────────
//  MAKEUP STEP LOOP
// ─────────────────────────────────────────
async function startMakeupSteps() {
  STATE.currentStep = 0; STATE.stepResults = [];
  const sv = document.getElementById('step-video');
  try {
    STATE.stream = await navigator.mediaDevices.getUserMedia(
      { video: { width:{ideal:640}, height:{ideal:480}, facingMode:'user' } });
    sv.srcObject = STATE.stream;
    sv.onloadedmetadata = () => { startStepFaceMesh(); };
  } catch(e) { console.error('Step camera error:', e); }
  renderStep(0); goTo('screen-step');
}
 
function renderStep(index) {
  const step  = STEPS[index];
  const tone  = STATE.shades?.[STATE.toneKey||'medium_warm'];
  const shade = tone?.[step];
  const dr = document.getElementById('step-dot-row'); dr.innerHTML = '';
  STEPS.forEach((_,i) => {
    const d = document.createElement('div');
    d.className = 'step-dot'+(i<index?' done':i===index?' active':'');
    dr.appendChild(d);
  });
  document.getElementById('step-counter').textContent     = `Step ${index+1} of ${STEPS.length}`;
  document.getElementById('step-name').textContent        = STEP_LABELS[step];
  document.getElementById('step-instruction').textContent = STEP_INSTRUCTIONS[step];
  if (shade) {
    document.getElementById('ssc-swatch').style.background = shade.hex;
    document.getElementById('ssc-shade').textContent = shade.shade;
    document.getElementById('ssc-brand').textContent = shade.brand||shade.product||'';
    document.getElementById('ssc-slot').textContent  = `Tray slot ${shade.slot}`;
  }
  document.getElementById('feedback-area').style.display = 'none';
  document.getElementById('btn-check').style.display     = '';
  document.getElementById('btn-check').disabled          = false;
  document.getElementById('btn-check').onclick           = checkPlacement;
  document.getElementById('btn-next').style.display      = 'none';
  document.getElementById('btn-retry').style.display     = 'none';
  STATE.checkPending = false;
}
 
// ─────────────────────────────────────────
//  STEP FACE MESH
// ─────────────────────────────────────────
function startStepFaceMesh() {
  const video = document.getElementById('step-video');
  const fm = new FaceMesh({ locateFile: f => `https://cdn.jsdelivr.net/npm/@mediapipe/face_mesh/${f}` });
  fm.setOptions({ maxNumFaces:1, refineLandmarks:true, minDetectionConfidence:.6, minTrackingConfidence:.6 });
  fm.onResults(onStepResults); STATE.faceMesh = fm;
  const cam = new Camera(video, {
    onFrame: async () => { if (STATE.faceMesh) await STATE.faceMesh.send({ image:video }); },
    width:640, height:480,
  });
  STATE.camera = cam; cam.start();
}
 
function onStepResults(results) {
  const canvas = document.getElementById('step-overlay');
  const video  = document.getElementById('step-video');
  if (!canvas || !video) return;
 
  // FIX: sync canvas to video's DISPLAYED size on every frame
  const { W, H } = syncOverlay(canvas, video);
 
  const ctx = canvas.getContext('2d');
  ctx.clearRect(0, 0, W, H);
  if (!results.multiFaceLandmarks?.length) return;
 
  const lm  = results.multiFaceLandmarks[0];
  STATE.lastLandmarks = lm;
 
  const fMap = { lips:'lips', eyebrows:'eyebrows', cheeks:'blush', contour:'contour' };
  const cs   = STEPS[STATE.currentStep];
  const fs   = fMap[STATE.focal] || cs;
  const shade= STATE.shades?.[STATE.toneKey||'medium_warm']?.[cs];
  const hex  = shade?.hex || '#e87090';
  const sc   = hexToRgba(hex, 0.92);
  const fc   = hexToRgba(hex, 0.30);
 
  if      (cs==='lips')      drawLips    (ctx,lm,W,H,sc,fc,3.5,true);
  else if (cs==='blush')     drawBlush   (ctx,lm,W,H,sc,fc,4);
  else if (cs==='eyebrows')  drawBrows   (ctx,lm,W,H,sc,fc,4.5);
  else if (cs==='contour')   drawContour (ctx,lm,W,H,sc,fc,4);
 
  if (cs === fs) {
    const gc = hexToRgba(hex, 1.0);
    ctx.save(); ctx.shadowColor=hex; ctx.shadowBlur=18;
    if      (cs==='lips')     drawLips    (ctx,lm,W,H,gc,null,1.5,false);
    else if (cs==='blush')    drawBlush   (ctx,lm,W,H,gc,null,2);
    else if (cs==='eyebrows') drawBrows   (ctx,lm,W,H,gc,null,2.5);
    else if (cs==='contour')  drawContour (ctx,lm,W,H,gc,null,2);
    ctx.restore();
  }
}
 
// ─────────────────────────────────────────
//  PLACEMENT CHECK
// ─────────────────────────────────────────
function checkPlacement() {
  if (STATE.checkPending) return;
  STATE.checkPending = true;
  document.getElementById('btn-check').disabled = true;
  const vid  = document.getElementById('step-video');
  const step = STEPS[STATE.currentStep];
  const lm   = STATE.lastLandmarks;
  if (!lm) {
    const msg = 'Face not detected clearly. Make sure you are well-lit and centred.';
    STATE.stepResults.push({ step, passed:false, message:msg }); showFeedback(false,msg); return;
  }
  const r = analyzeZoneColor(vid, lm, step);
  STATE.stepResults.push({ step, passed:r.passed, message:r.message });
  showFeedback(r.passed, r.message);
}
 
function analyzeZoneColor(video, lm, step) {
  try {
    const W=video.videoWidth||640, H=video.videoHeight||480;
    const tmp=document.createElement('canvas'); tmp.width=W; tmp.height=H;
    const ctx=tmp.getContext('2d'); ctx.drawImage(video,0,0,W,H);
    let r=0,g=0,b=0,n=0;
    (SAMPLE_IDX[step]||[]).forEach(i => {
      const x=Math.round(lm[i].x*W), y=Math.round(lm[i].y*H);
      if (x>=1&&x<W-1&&y>=1&&y<H-1)
        for (let dx=-1;dx<=1;dx++) for (let dy=-1;dy<=1;dy++) {
          const d=ctx.getImageData(x+dx,y+dy,1,1).data; r+=d[0]; g+=d[1]; b+=d[2]; n++;
        }
    });
    if (!n) return { passed:true, message:goodMessages[step] };
    r/=n; g/=n; b/=n;
    const sk=toneToRGB(STATE.toneKey||'medium_warm');
    const dev=Math.abs(r-sk.r)+Math.abs(g-sk.g)+Math.abs(b-sk.b);
    const br=r*.299+g*.587+b*.114;
    const passed=br>35&&br<235&&dev>28&&(rgbSat(r,g,b)-rgbSat(sk.r,sk.g,sk.b))>0.025;
    return { passed, message: passed ? goodMessages[step] : tipMessages[step] };
  } catch(e) { return { passed:true, message:goodMessages[step] }; }
}
 
function rgbSat(r,g,b){const mx=Math.max(r,g,b)/255,mn=Math.min(r,g,b)/255; return mx===0?0:(mx-mn)/mx;}
function toneToRGB(k){
  return { light_warm:{r:225,g:192,b:167}, light_cool:{r:218,g:190,b:180},
           medium_warm:{r:190,g:150,b:120}, medium_cool:{r:178,g:152,b:144},
           dark_warm:{r:133,g:100,b:70}, dark_cool:{r:122,g:98,b:93} }[k]||{r:185,g:148,b:122};
}
 
const goodMessages={
  lips:'Great lip color! Your lips look well-defined and beautiful.',
  blush:'Beautiful blush placement! Your cheeks are glowing naturally.',
  eyebrows:'Your brows look well-defined and perfectly framed!',
  contour:'Great contour! Your jawline and cheekbones look sculpted.',
};
const tipMessages={
  lips:'Start at the gold dot on your cupid\'s bow and work outward to the corners, then fill in.',
  blush:'Apply a little more blush to the apples of your cheeks and blend upward.',
  eyebrows:'Fill in the brows more with short, upward strokes then check again.',
  contour:'Build up the contour a little more along the jawline and blend the edges.',
};
 
function showFeedback(passed, message) {
  const area=document.getElementById('feedback-area');
  area.style.display=''; area.className='feedback-area '+(passed?'good':'bad');
  document.getElementById('feedback-icon').textContent = passed?'✓':'✗';
  document.getElementById('feedback-msg').textContent  = message;
  document.getElementById('btn-check').style.display   = 'none';
  if (passed) {
    const isLast = STATE.currentStep>=STEPS.length-1;
    const btn    = document.getElementById('btn-next');
    btn.textContent = isLast?'See Final Summary →':'Next Step →';
    btn.style.display=''; btn.onclick=isLast?showSummary:nextStep;
  } else { document.getElementById('btn-retry').style.display=''; }
}
 
function nextStep()  { STATE.currentStep++; if(STATE.currentStep>=STEPS.length) showSummary(); else renderStep(STATE.currentStep); }
function retryStep() { STATE.stepResults.pop(); renderStep(STATE.currentStep); }
 
// ─────────────────────────────────────────
//  SUMMARY
// ─────────────────────────────────────────
function showSummary() {
  stopStream();
  const tone = STATE.shades?.[STATE.toneKey||'medium_warm'];
  const grid = document.getElementById('summary-grid'); grid.innerHTML='';
  let pass=0;
  STATE.stepResults.forEach(r => {
    if(r.passed) pass++;
    const shade=tone?.[r.step];
    const card=document.createElement('div'); card.className='summary-card';
    card.innerHTML=`<div class="summary-swatch" style="background:${shade?.hex||'#888'}"></div>
      <div><div class="summary-step-name">${STEP_LABELS[r.step]}</div>
      <div class="summary-result ${r.passed?'ok':'bad'}">${r.passed?'✓ Well done':'✗ Needs blending'}</div></div>`;
    grid.appendChild(card);
  });
  const t=STATE.stepResults.length;
  document.getElementById('summary-sub').textContent     = `${pass} of ${t} steps looked great`;
  document.getElementById('summary-overall').textContent = pass===t
    ? 'Flawless finish! Your Soft and Natural look is complete.'
    : pass>=t/2 ? 'Great effort! A little more blending and it will be perfect.'
    : 'Keep practicing! The guide is here whenever you need it.';
  goTo('screen-summary');
}
 
// ─────────────────────────────────────────
//  UTILITIES
// ─────────────────────────────────────────
function hexToRgba(hex, a) {
  if (!hex||hex.length<7) return `rgba(200,120,120,${a})`;
  return `rgba(${parseInt(hex.slice(1,3),16)},${parseInt(hex.slice(3,5),16)},${parseInt(hex.slice(5,7),16)},${a})`;
}
 
document.addEventListener('DOMContentLoaded', () => { loadData(); initParticles(); });