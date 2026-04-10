// ── STATE ──
const STATE = {
  focal:        null,
  toneKey:      null,
  shades:       null,
  focalData:    null,
  currentStep:  0,
  stepResults:  [],
  faceMesh:     null,
  camera:       null,
  stream:       null,
  lastLandmarks:null,
  checkPending: false,
};
 
const STEPS       = ['lips', 'blush', 'eyebrows', 'contour'];
const STEP_LABELS = { lips:'Lips', blush:'Blush', eyebrows:'Eyebrows', contour:'Contour' };
 
const STEP_INSTRUCTIONS = {
  lips:     '① Start at your cupid\'s bow (the V-shape at the top center). ② Follow the arrows outward to each corner. ③ Fill in the top lip. ④ Do the same from the bottom center outward, then fill.',
  blush:    'Smile softly and sweep blush onto the apples of your cheeks, blending upward along the oval guide.',
  eyebrows: 'Fill in your brows following the guide. Use short, hair-like strokes for a natural finish.',
  contour:  'Apply contour below your cheekbones and along your jawline using the outline as your guide.',
};
 
// ── LANDMARK INDEX SETS ──
 
// Outer lip boundary — upper then lower, forms one closed shape
const LIP_UPPER_OUTER = [61, 185, 40, 39, 37, 0, 267, 269, 270, 409, 291];
const LIP_LOWER_OUTER = [291, 375, 321, 405, 314, 17, 84, 181, 91, 146, 61];
 
// Inner lip opening
const LIP_INNER = [78, 191, 80, 81, 82, 13, 312, 311, 310, 415, 308,
                   324, 318, 402, 317, 14, 87, 178, 88, 95, 78];
 
// Key lip landmarks for guide markers
const LM_CUPID_VALLEY  = 0;    // dip in centre of upper lip (where X goes)
const LM_CUPID_PEAK_L  = 37;   // left peak of cupid's bow
const LM_CUPID_PEAK_R  = 267;  // right peak of cupid's bow
const LM_CORNER_L      = 61;   // left mouth corner
const LM_CORNER_R      = 291;  // right mouth corner
const LM_BOTTOM_CENTER = 17;   // centre of lower outer lip
 
// Blush zones
const BLUSH_LEFT  = [116,123,147,213,192,214,212,202,204,194,32,31,228,229,230,231,232,233,128,121,120,119,118,117];
const BLUSH_RIGHT = [345,352,376,433,411,434,432,422,424,414,262,261,448,449,450,451,452,453,357,350,349,348,347,346];
 
// Eyebrow paths
const BROW_LEFT_TOP     = [70, 63, 105, 66, 107];
const BROW_LEFT_BOTTOM  = [46, 53, 52, 65, 55];
const BROW_RIGHT_TOP    = [300, 293, 334, 296, 336];
const BROW_RIGHT_BOTTOM = [276, 283, 282, 295, 285];
 
// Contour
const JAW_LEFT       = [234, 93, 132, 58, 172, 136, 150, 149, 176, 148, 152];
const JAW_RIGHT      = [454, 323, 361, 288, 397, 365, 379, 378, 400, 377, 152];
const CHEEK_HOLLOW_L = [123, 50, 36, 203, 142, 126, 209, 49, 129, 64];
const CHEEK_HOLLOW_R = [352, 280, 266, 423, 371, 355, 429, 279, 358, 294];
 
// Sample points for placement detection
const SAMPLE_IDX = {
  lips:     [13, 14, 0, 17, 61, 291, 40, 270],
  blush:    [123, 352, 116, 345, 50, 280, 205, 425],
  eyebrows: [70, 300, 66, 296, 63, 293, 105, 334],
  contour:  [172, 397, 136, 365, 58, 288, 152, 148],
};
 
// ─────────────────────────────────────────
//  DATA LOADING
// ─────────────────────────────────────────
async function loadData() {
  try {
    const [shadesRes, focalRes] = await Promise.all([
      fetch('data/shades.json').then(r => r.json()),
      fetch('data/focal-points.json').then(r => r.json()),
    ]);
    STATE.shades    = shadesRes;
    STATE.focalData = focalRes;
    console.log('Data loaded. Tone keys:', Object.keys(shadesRes));
  } catch(e) {
    console.error('Data load error:', e);
  }
}
 
// ─────────────────────────────────────────
//  SCREEN NAVIGATION
// ─────────────────────────────────────────
function goTo(id) {
  document.querySelectorAll('.screen').forEach(s => s.classList.remove('active'));
  const target = document.getElementById(id);
  if (target) target.classList.add('active');
  if (id === 'screen-camera') initCamera();
  else if (id !== 'screen-step') stopStream();
}
 
// ─────────────────────────────────────────
//  PARTICLES
// ─────────────────────────────────────────
function initParticles() {
  const canvas = document.getElementById('particles-bg');
  const ctx    = canvas.getContext('2d');
  let W, H, particles = [];
 
  function resize() {
    W = canvas.width  = window.innerWidth;
    H = canvas.height = window.innerHeight;
  }
  resize();
  window.addEventListener('resize', resize);
 
  for (let i = 0; i < 60; i++) {
    particles.push({
      x:  Math.random() * window.innerWidth,
      y:  Math.random() * window.innerHeight,
      r:  Math.random() * 1.4 + 0.3,
      dx: (Math.random() - .5) * .4,
      dy: (Math.random() - .5) * .4,
      o:  Math.random() * .5 + .1,
    });
  }
 
  function draw() {
    ctx.clearRect(0, 0, W, H);
    particles.forEach(p => {
      ctx.beginPath();
      ctx.arc(p.x, p.y, p.r, 0, Math.PI * 2);
      ctx.fillStyle = `rgba(201,149,106,${p.o})`;
      ctx.fill();
      p.x += p.dx; p.y += p.dy;
      if (p.x < 0) p.x = W; if (p.x > W) p.x = 0;
      if (p.y < 0) p.y = H; if (p.y > H) p.y = 0;
    });
    requestAnimationFrame(draw);
  }
  draw();
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
    STATE.stream = await navigator.mediaDevices.getUserMedia({
      video: { width: { ideal: 640 }, height: { ideal: 480 }, facingMode: 'user' }
    });
    video.srcObject = STATE.stream;
    video.onloadedmetadata = () => {
      syncCanvas('overlay', video);
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
  if (STATE.stream) {
    STATE.stream.getTracks().forEach(t => t.stop());
    STATE.stream = null;
  }
  if (STATE.faceMesh) {
    try { STATE.faceMesh.close(); } catch(e) {}
    STATE.faceMesh = null;
  }
  STATE.camera = null;
}
 
// FIX: always use videoWidth/videoHeight — never getBoundingClientRect
function syncCanvas(canvasId, videoEl) {
  const canvas = document.getElementById(canvasId);
  if (!canvas || !videoEl) return;
  canvas.width  = videoEl.videoWidth  || 640;
  canvas.height = videoEl.videoHeight || 480;
}
 
// ─────────────────────────────────────────
//  LIGHTING CHECK
// ─────────────────────────────────────────
function startLightingCheck() {
  const video = document.getElementById('video');
  const warn  = document.getElementById('light-warn');
  const tmp   = document.createElement('canvas');
  tmp.width = 64; tmp.height = 48;
  const tctx  = tmp.getContext('2d');
 
  setInterval(() => {
    if (!STATE.stream) return;
    try {
      tctx.drawImage(video, 0, 0, 64, 48);
      const d = tctx.getImageData(0, 0, 64, 48).data;
      let br = 0;
      for (let i = 0; i < d.length; i += 4)
        br += d[i] * .299 + d[i+1] * .587 + d[i+2] * .114;
      br /= (d.length / 4);
      warn.classList.toggle('hide', br >= 55);
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
    STATE.faceMesh = new FaceMesh({
      locateFile: f => `https://cdn.jsdelivr.net/npm/@mediapipe/face_mesh/${f}`
    });
    STATE.faceMesh.setOptions({
      maxNumFaces: 1,
      refineLandmarks: true,
      minDetectionConfidence: .6,
      minTrackingConfidence: .6,
    });
  }
 
  STATE.faceMesh.onResults(onDetectResults);
 
  STATE.camera = new Camera(video, {
    onFrame: async () => {
      if (STATE.faceMesh) await STATE.faceMesh.send({ image: video });
    },
    width: 640, height: 480,
  });
  STATE.camera.start();
}
 
function onDetectResults(results) {
  const canvas = document.getElementById('overlay');
  const video  = document.getElementById('video');
 
  // FIX: size from video dimensions, not layout rect
  canvas.width  = video.videoWidth  || 640;
  canvas.height = video.videoHeight || 480;
 
  const ctx = canvas.getContext('2d');
  ctx.clearRect(0, 0, canvas.width, canvas.height);
 
  const pFace = document.getElementById('pill-face');
  const pLM   = document.getElementById('pill-lm');
  const pTone = document.getElementById('pill-tone');
 
  if (results.multiFaceLandmarks?.length > 0) {
    const lm = results.multiFaceLandmarks[0];
    STATE.lastLandmarks = lm;
 
    pFace.textContent = 'Face: Detected ✓'; pFace.classList.add('ok');
    pLM.textContent   = 'Landmarks: 468 ✓'; pLM.classList.add('ok');
 
    const W = canvas.width, H = canvas.height;
 
    ctx.fillStyle = 'rgba(201,149,106,0.22)';
    lm.forEach(pt => {
      ctx.beginPath();
      ctx.arc(pt.x * W, pt.y * H, 1.4, 0, Math.PI * 2);
      ctx.fill();
    });
 
    // Detection preview — all zones, no guide markers
    drawLips(ctx, lm, W, H, 'rgba(220,130,120,0.65)', 'rgba(220,130,120,0.15)', 2.5, false);
    drawBrows(ctx, lm, W, H, 'rgba(180,130,80,0.7)', 'rgba(160,110,60,0.15)', 3);
    drawBlush(ctx, lm, W, H, 'rgba(230,150,140,0.55)', 'rgba(230,150,140,0.10)', 2);
    drawContour(ctx, lm, W, H, 'rgba(190,140,80,0.6)', 'rgba(170,120,60,0.10)', 2.5);
 
    // FIX: use results.image — safe, no canvas taint risk
    if (!STATE.toneKey) {
      const tone = detectToneFromImage(results.image, lm, W, H);
      if (tone) {
        STATE.toneKey = tone;
        console.log('Detected tone key:', tone);
        pTone.textContent = `Tone: ${formatTone(tone)} ✓`;
        pTone.classList.add('ok');
 
        document.getElementById('cam-title').textContent = 'Analysis complete!';
        document.getElementById('cam-sub').textContent   = 'Tap below to see your shade recommendations';
 
        const btn = document.getElementById('btn-detect');
        btn.textContent = 'See My Recommendations →';
        btn.disabled    = false;
        btn.onclick     = showShades;
      }
    }
  } else {
    pFace.textContent = 'Face not found — step closer';
    pFace.classList.remove('ok');
    pLM.textContent   = 'Landmarks: —';
    pLM.classList.remove('ok');
  }
}
 
// ─────────────────────────────────────────
//  DRAWING UTILITY HELPERS
// ─────────────────────────────────────────
 
// Smooth quadratic Bézier through an array of landmark indices (closed loop)
function smoothClosedPath(ctx, lm, indices, W, H) {
  if (indices.length < 2) return;
  const pts   = indices.map(i => ({ x: lm[i].x * W, y: lm[i].y * H }));
  const start = midpt(pts[pts.length - 1], pts[0]);
  ctx.moveTo(start.x, start.y);
  for (let i = 0; i < pts.length; i++) {
    const cur  = pts[i];
    const next = pts[(i + 1) % pts.length];
    const mid  = midpt(cur, next);
    ctx.quadraticCurveTo(cur.x, cur.y, mid.x, mid.y);
  }
  ctx.closePath();
}
 
function midpt(a, b) {
  return { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
}
 
// Draw an arrow from (x1,y1) to (x2,y2)
function drawArrow(ctx, x1, y1, x2, y2, color, lw) {
  const headLen = Math.max(7, lw * 3);
  const angle   = Math.atan2(y2 - y1, x2 - x1);
  const stopX   = x2 - headLen * 0.7 * Math.cos(angle);
  const stopY   = y2 - headLen * 0.7 * Math.sin(angle);
 
  ctx.save();
  ctx.strokeStyle = color;
  ctx.fillStyle   = color;
  ctx.lineWidth   = lw;
  ctx.lineCap     = 'round';
 
  ctx.beginPath();
  ctx.moveTo(x1, y1);
  ctx.lineTo(stopX, stopY);
  ctx.stroke();
 
  ctx.beginPath();
  ctx.moveTo(x2, y2);
  ctx.lineTo(x2 - headLen * Math.cos(angle - Math.PI / 6),
             y2 - headLen * Math.sin(angle - Math.PI / 6));
  ctx.lineTo(x2 - headLen * Math.cos(angle + Math.PI / 6),
             y2 - headLen * Math.sin(angle + Math.PI / 6));
  ctx.closePath();
  ctx.fill();
  ctx.restore();
}
 
// Numbered circle badge
function drawBadge(ctx, x, y, label, bgColor, textColor, radius) {
  ctx.save();
  ctx.beginPath();
  ctx.arc(x, y, radius, 0, Math.PI * 2);
  ctx.fillStyle = bgColor;
  ctx.fill();
  ctx.font         = `bold ${Math.round(radius * 1.3)}px sans-serif`;
  ctx.fillStyle    = textColor;
  ctx.textAlign    = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(label, x, y + 1);
  ctx.restore();
}
 
// Text pill label with dark backing for readability on any skin tone
function drawLabel(ctx, x, y, text, fgColor) {
  ctx.save();
  ctx.font         = 'bold 11px sans-serif';
  ctx.textAlign    = 'center';
  ctx.textBaseline = 'middle';
  const w = ctx.measureText(text).width + 10;
  const h = 16;
  ctx.fillStyle = 'rgba(0,0,0,0.55)';
  // pill background
  ctx.beginPath();
  ctx.moveTo(x - w / 2 + 4, y - h / 2);
  ctx.lineTo(x + w / 2 - 4, y - h / 2);
  ctx.quadraticCurveTo(x + w / 2, y - h / 2, x + w / 2, y - h / 2 + 4);
  ctx.lineTo(x + w / 2, y + h / 2 - 4);
  ctx.quadraticCurveTo(x + w / 2, y + h / 2, x + w / 2 - 4, y + h / 2);
  ctx.lineTo(x - w / 2 + 4, y + h / 2);
  ctx.quadraticCurveTo(x - w / 2, y + h / 2, x - w / 2, y + h / 2 - 4);
  ctx.lineTo(x - w / 2, y - h / 2 + 4);
  ctx.quadraticCurveTo(x - w / 2, y - h / 2, x - w / 2 + 4, y - h / 2);
  ctx.closePath();
  ctx.fill();
  ctx.fillStyle = fgColor;
  ctx.fillText(text, x, y);
  ctx.restore();
}
 
// ─────────────────────────────────────────
//  DRAW LIPS — smooth curves + beginner guide
//
//  showGuide = false  → clean outline only (detection screen)
//  showGuide = true   → adds X at cupid's bow, arrows, step numbers,
//                        pulsing start dot, "fill in" label (step screen)
// ─────────────────────────────────────────
function drawLips(ctx, lm, W, H, strokeColor, fillColor, lw, showGuide) {
 
  // ── Outer lip shape — smooth closed curve ──
  ctx.beginPath();
  smoothClosedPath(ctx, lm,
    [...LIP_UPPER_OUTER, ...LIP_LOWER_OUTER.slice(1, -1)],
    W, H);
  if (fillColor) { ctx.fillStyle = fillColor; ctx.fill(); }
  ctx.strokeStyle = strokeColor;
  ctx.lineWidth   = lw;
  ctx.stroke();
 
  // ── Inner lip outline — smooth, slightly lighter ──
  ctx.beginPath();
  smoothClosedPath(ctx, lm, LIP_INNER, W, H);
  ctx.strokeStyle = strokeColor.replace(/[\d.]+\)$/, '0.45)');
  ctx.lineWidth   = lw * 0.65;
  ctx.stroke();
 
  if (!showGuide) return;
 
  // ── BEGINNER GUIDE OVERLAY ──
 
  // Key coordinates
  const valley = { x: lm[LM_CUPID_VALLEY].x  * W, y: lm[LM_CUPID_VALLEY].y  * H };
  const cornL  = { x: lm[LM_CORNER_L].x      * W, y: lm[LM_CORNER_L].y      * H };
  const cornR  = { x: lm[LM_CORNER_R].x      * W, y: lm[LM_CORNER_R].y      * H };
  const btmC   = { x: lm[LM_BOTTOM_CENTER].x * W, y: lm[LM_BOTTOM_CENTER].y * H };
 
  const lipHeight  = Math.abs(btmC.y - valley.y);
  const labelOffY  = Math.max(10, lipHeight * 0.22);
 
  // Pulsing alpha (0.6 – 1.0) — since this is called every frame, Date.now() works great
  const pulse      = 0.6 + 0.4 * ((Math.sin(Date.now() / 350) + 1) / 2);
  const arrowColor = `rgba(255,255,255,${(0.8 * pulse).toFixed(2)})`;
  const dotColor   = 'rgba(255,255,255,0.95)';
  const arrowLW    = Math.max(1.5, lw * 0.5);
  const xSize      = Math.max(6, lipHeight * 0.18);
  const badgeR     = Math.max(8, lipHeight * 0.22);
 
  // ── "X" at cupid's bow valley (pro tip: draw an X to mark starting point) ──
  ctx.save();
  ctx.strokeStyle = dotColor;
  ctx.lineWidth   = Math.max(1.5, lw * 0.8);
  ctx.lineCap     = 'round';
  ctx.globalAlpha = pulse;
  ctx.beginPath();
  ctx.moveTo(valley.x - xSize, valley.y - xSize);
  ctx.lineTo(valley.x + xSize, valley.y + xSize);
  ctx.moveTo(valley.x + xSize, valley.y - xSize);
  ctx.lineTo(valley.x - xSize, valley.y + xSize);
  ctx.stroke();
  ctx.restore();
 
  // ── Pulsing start dot above valley ──
  ctx.save();
  ctx.globalAlpha = pulse;
  ctx.shadowColor = '#fff';
  ctx.shadowBlur  = 10;
  ctx.beginPath();
  ctx.arc(valley.x, valley.y - labelOffY * 1.6, 5, 0, Math.PI * 2);
  ctx.fillStyle = dotColor;
  ctx.fill();
  ctx.restore();
 
  // ── "① Start here" label above cupid's bow ──
  drawLabel(ctx, valley.x, valley.y - labelOffY * 3.0, '① Start here', '#fff');
 
  // ── Arrows: cupid's bow valley → left and right corners ──
  const arrowOff = xSize * 1.6;
  drawArrow(ctx,
    valley.x - arrowOff, valley.y,
    cornL.x + (valley.x - cornL.x) * 0.1, cornL.y,
    arrowColor, arrowLW);
  drawArrow(ctx,
    valley.x + arrowOff, valley.y,
    cornR.x + (valley.x - cornR.x) * 0.1, cornR.y,
    arrowColor, arrowLW);
 
  // ── "②" badge on each corner ──
  drawBadge(ctx, cornL.x, cornL.y, '②', strokeColor, '#fff', badgeR);
  drawBadge(ctx, cornR.x, cornR.y, '②', strokeColor, '#fff', badgeR);
 
  // ── "④ Fill in" label in the centre of the lip ──
  const lipMidY = (valley.y + btmC.y) / 2;
  drawLabel(ctx, valley.x, lipMidY, '④ Fill in', '#fff');
 
  // ── Bottom lip pulsing dot + label ──
  ctx.save();
  ctx.globalAlpha = pulse * 0.85;
  ctx.shadowColor = '#fff';
  ctx.shadowBlur  = 7;
  ctx.beginPath();
  ctx.arc(btmC.x, btmC.y + labelOffY * 1.4, 4, 0, Math.PI * 2);
  ctx.fillStyle = dotColor;
  ctx.fill();
  ctx.restore();
 
  drawLabel(ctx, btmC.x, btmC.y + labelOffY * 2.9, '③ Then bottom lip', '#fff');
 
  // Arrows: bottom center → left and right corners
  drawArrow(ctx,
    btmC.x - arrowOff * 0.7, btmC.y,
    cornL.x + (btmC.x - cornL.x) * 0.1, cornL.y,
    arrowColor, arrowLW);
  drawArrow(ctx,
    btmC.x + arrowOff * 0.7, btmC.y,
    cornR.x + (btmC.x - cornR.x) * 0.1, cornR.y,
    arrowColor, arrowLW);
}
 
// ─────────────────────────────────────────
//  OTHER ZONE DRAW HELPERS
// ─────────────────────────────────────────
 
function drawBrows(ctx, lm, W, H, strokeColor, fillColor, lw) {
  [
    [BROW_LEFT_TOP,  BROW_LEFT_BOTTOM],
    [BROW_RIGHT_TOP, BROW_RIGHT_BOTTOM],
  ].forEach(([top, bottom]) => {
    ctx.beginPath();
    ctx.moveTo(lm[top[0]].x * W, lm[top[0]].y * H);
    top.slice(1).forEach(i => ctx.lineTo(lm[i].x * W, lm[i].y * H));
    [...bottom].reverse().forEach(i => ctx.lineTo(lm[i].x * W, lm[i].y * H));
    ctx.closePath();
    if (fillColor) { ctx.fillStyle = fillColor; ctx.fill(); }
    ctx.strokeStyle = strokeColor; ctx.lineWidth = lw; ctx.stroke();
  });
}
 
function drawBlush(ctx, lm, W, H, strokeColor, fillColor, lw) {
  [BLUSH_LEFT, BLUSH_RIGHT].forEach(indices => {
    ctx.beginPath();
    ctx.moveTo(lm[indices[0]].x * W, lm[indices[0]].y * H);
    indices.slice(1).forEach(i => ctx.lineTo(lm[i].x * W, lm[i].y * H));
    ctx.closePath();
    if (fillColor) { ctx.fillStyle = fillColor; ctx.fill(); }
    ctx.strokeStyle = strokeColor; ctx.lineWidth = lw; ctx.stroke();
  });
}
 
function drawContour(ctx, lm, W, H, strokeColor, fillColor, lw) {
  [JAW_LEFT, JAW_RIGHT].forEach(indices => {
    ctx.beginPath();
    ctx.moveTo(lm[indices[0]].x * W, lm[indices[0]].y * H);
    indices.slice(1).forEach(i => ctx.lineTo(lm[i].x * W, lm[i].y * H));
    ctx.closePath();
    if (fillColor) { ctx.fillStyle = fillColor; ctx.fill(); }
    ctx.strokeStyle = strokeColor; ctx.lineWidth = lw; ctx.stroke();
  });
  [CHEEK_HOLLOW_L, CHEEK_HOLLOW_R].forEach(indices => {
    ctx.beginPath();
    ctx.moveTo(lm[indices[0]].x * W, lm[indices[0]].y * H);
    indices.slice(1).forEach(i => ctx.lineTo(lm[i].x * W, lm[i].y * H));
    ctx.closePath();
    ctx.strokeStyle = strokeColor; ctx.lineWidth = lw * 0.8; ctx.stroke();
  });
}
 
// ─────────────────────────────────────────
//  SKIN TONE — FIX: uses results.image (no canvas taint)
// ─────────────────────────────────────────
function detectToneFromImage(image, lm, W, H) {
  try {
    const tmp = document.createElement('canvas');
    tmp.width = W; tmp.height = H;
    const ctx = tmp.getContext('2d');
    ctx.drawImage(image, 0, 0, W, H);
 
    const samplePoints = [
      lm[234], lm[454], lm[1],  lm[6],
      lm[199], lm[117], lm[346], lm[50],
    ];
 
    let totalR = 0, totalG = 0, totalB = 0, count = 0;
    samplePoints.forEach(pt => {
      for (let dx = -1; dx <= 1; dx++) {
        for (let dy = -1; dy <= 1; dy++) {
          const x = Math.round(pt.x * W) + dx;
          const y = Math.round(pt.y * H) + dy;
          if (x >= 0 && x < W && y >= 0 && y < H) {
            const d = ctx.getImageData(x, y, 1, 1).data;
            totalR += d[0]; totalG += d[1]; totalB += d[2];
            count++;
          }
        }
      }
    });
 
    if (count === 0) return 'medium_warm';
 
    const r = totalR / count;
    const g = totalG / count;
    const b = totalB / count;
 
    console.log(`Skin RGB: r=${r.toFixed(0)}, g=${g.toFixed(0)}, b=${b.toFixed(0)}`);
 
    const brightness = r * 0.299 + g * 0.587 + b * 0.114;
    const lightness  = brightness > 160 ? 'light' : brightness > 105 ? 'medium' : 'dark';
    const undertone  = (r - b) > 18 ? 'warm' : 'cool';
    const result     = `${lightness}_${undertone}`;
 
    console.log(`Tone: brightness=${brightness.toFixed(0)}, key=${result}`);
    return result;
 
  } catch(e) {
    console.error('Tone detection error:', e);
    return 'medium_warm';
  }
}
 
function formatTone(key) {
  return {
    light_warm:'Light Warm', light_cool:'Light Cool',
    medium_warm:'Medium Warm', medium_cool:'Medium Cool',
    dark_warm:'Deep Warm', dark_cool:'Deep Cool',
  }[key] || key;
}
 
// ─────────────────────────────────────────
//  SHADE RECOMMENDATIONS
// ─────────────────────────────────────────
function showShades() {
  const toneKey = STATE.toneKey || 'medium_warm';
  const tone    = STATE.shades?.[toneKey];
 
  if (!tone) {
    console.error('No shades for tone key:', toneKey, 'Available:', Object.keys(STATE.shades || {}));
    return;
  }
 
  document.getElementById('shade-tone-label').textContent =
    `Skin tone: ${formatTone(toneKey)} · Soft & Natural`;
 
  const focalToStep  = { lips:'lips', eyebrows:'eyebrows', cheeks:'blush', contour:'contour' };
  const focalMapStep = focalToStep[STATE.focal] || STATE.focal;
 
  document.getElementById('focal-badge-label').textContent =
    STATE.focalData?.[STATE.focal]?.label || STATE.focal;
 
  const grid = document.getElementById('shade-grid');
  grid.innerHTML = '';
 
  STEPS.forEach(step => {
    const shade = tone[step];
    if (!shade) { console.warn(`No shade for "${step}" in "${toneKey}"`); return; }
 
    const isFocal = step === focalMapStep;
    const card    = document.createElement('div');
    card.className = 'shade-card' + (isFocal ? ' focal-highlight' : '');
    card.innerHTML = `
      <div class="shade-swatch" style="background:${shade.hex}"></div>
      <div class="shade-step-label">${STEP_LABELS[step]}${isFocal ? '<span class="focal-star"> ★</span>' : ''}</div>
      <div class="shade-name-txt">${shade.shade}</div>
      <div class="shade-brand-txt">${shade.brand || shade.product || ''}</div>
      <div class="shade-slot-badge">Tray slot ${shade.slot}</div>
    `;
    grid.appendChild(card);
  });
 
  goTo('screen-shades');
}
 
// ─────────────────────────────────────────
//  MAKEUP STEP LOOP
// ─────────────────────────────────────────
async function startMakeupSteps() {
  STATE.currentStep = 0;
  STATE.stepResults = [];
 
  const stepVideo = document.getElementById('step-video');
  try {
    STATE.stream = await navigator.mediaDevices.getUserMedia({
      video: { width: { ideal: 640 }, height: { ideal: 480 }, facingMode: 'user' }
    });
    stepVideo.srcObject = STATE.stream;
    stepVideo.onloadedmetadata = () => {
      syncCanvas('step-overlay', stepVideo);
      startStepFaceMesh();
    };
  } catch(e) {
    console.error('Step camera error:', e);
  }
 
  renderStep(0);
  goTo('screen-step');
}
 
function renderStep(index) {
  const step    = STEPS[index];
  const toneKey = STATE.toneKey || 'medium_warm';
  const tone    = STATE.shades?.[toneKey];
  const shade   = tone?.[step];
 
  const dotRow = document.getElementById('step-dot-row');
  dotRow.innerHTML = '';
  STEPS.forEach((s, i) => {
    const dot = document.createElement('div');
    dot.className = 'step-dot' + (i < index ? ' done' : i === index ? ' active' : '');
    dotRow.appendChild(dot);
  });
 
  document.getElementById('step-counter').textContent     = `Step ${index+1} of ${STEPS.length}`;
  document.getElementById('step-name').textContent        = STEP_LABELS[step];
  document.getElementById('step-instruction').textContent = STEP_INSTRUCTIONS[step];
 
  if (shade) {
    document.getElementById('ssc-swatch').style.background = shade.hex;
    document.getElementById('ssc-shade').textContent = shade.shade;
    document.getElementById('ssc-brand').textContent = shade.brand || shade.product || '';
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
 
  const fm = new FaceMesh({
    locateFile: f => `https://cdn.jsdelivr.net/npm/@mediapipe/face_mesh/${f}`
  });
  fm.setOptions({
    maxNumFaces: 1,
    refineLandmarks: true,
    minDetectionConfidence: .6,
    minTrackingConfidence: .6,
  });
  fm.onResults(onStepResults);
  STATE.faceMesh = fm;
 
  const cam = new Camera(video, {
    onFrame: async () => {
      if (STATE.faceMesh) await STATE.faceMesh.send({ image: video });
    },
    width: 640, height: 480,
  });
  STATE.camera = cam;
  cam.start();
}
 
function onStepResults(results) {
  const canvas = document.getElementById('step-overlay');
  const video  = document.getElementById('step-video');
  if (!canvas || !video) return;
 
  // FIX: size from video dimensions, not layout
  const W = video.videoWidth  || 640;
  const H = video.videoHeight || 480;
  if (canvas.width !== W || canvas.height !== H) {
    canvas.width  = W;
    canvas.height = H;
  }
 
  const ctx = canvas.getContext('2d');
  ctx.clearRect(0, 0, W, H);
 
  if (!results.multiFaceLandmarks?.length) return;
 
  const lm = results.multiFaceLandmarks[0];
  STATE.lastLandmarks = lm;
 
  const focalToStep = { lips:'lips', eyebrows:'eyebrows', cheeks:'blush', contour:'contour' };
  const currentStep = STEPS[STATE.currentStep];
  const focalStep   = focalToStep[STATE.focal] || currentStep;
 
  const toneKey = STATE.toneKey || 'medium_warm';
  const tone    = STATE.shades?.[toneKey];
  const shade   = tone?.[currentStep];
  const hex     = shade?.hex || '#e87090';
 
  const strokeColor = hexToRgba(hex, 0.92);
  const fillColor   = hexToRgba(hex, 0.30);   // stronger fill so zone is obvious to beginners
 
  if (currentStep === 'lips') {
    // showGuide=true — full beginner overlay with arrows, X, labels
    drawLips(ctx, lm, W, H, strokeColor, fillColor, 4, true);
  } else if (currentStep === 'blush') {
    drawBlush(ctx, lm, W, H, strokeColor, fillColor, 4);
  } else if (currentStep === 'eyebrows') {
    drawBrows(ctx, lm, W, H, strokeColor, fillColor, 4.5);
  } else if (currentStep === 'contour') {
    drawContour(ctx, lm, W, H, strokeColor, fillColor, 4);
  }
 
  // Extra glow ring when this step is the focal point
  if (currentStep === focalStep) {
    const glowColor = hexToRgba(hex, 1.0);
    ctx.save();
    ctx.shadowColor = hex;
    ctx.shadowBlur  = 18;
    if (currentStep === 'lips') {
      drawLips(ctx, lm, W, H, glowColor, null, 2, false);
    } else if (currentStep === 'blush') {
      drawBlush(ctx, lm, W, H, glowColor, null, 2);
    } else if (currentStep === 'eyebrows') {
      drawBrows(ctx, lm, W, H, glowColor, null, 2.5);
    } else if (currentStep === 'contour') {
      drawContour(ctx, lm, W, H, glowColor, null, 2);
    }
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
 
  const stepVid = document.getElementById('step-video');
  const step    = STEPS[STATE.currentStep];
  const lm      = STATE.lastLandmarks;
 
  if (!lm) {
    const msg = 'Face not detected clearly. Make sure you are well-lit and centered.';
    STATE.stepResults.push({ step, passed: false, message: msg });
    showFeedback(false, msg);
    return;
  }
 
  const result = analyzeZoneColor(stepVid, lm, step);
  STATE.stepResults.push({ step, passed: result.passed, message: result.message });
  showFeedback(result.passed, result.message);
}
 
function analyzeZoneColor(video, lm, step) {
  try {
    const W = video.videoWidth  || 640;
    const H = video.videoHeight || 480;
    const tmp = document.createElement('canvas');
    tmp.width = W; tmp.height = H;
    const ctx = tmp.getContext('2d');
    ctx.drawImage(video, 0, 0, W, H);
 
    const idxList = SAMPLE_IDX[step] || [];
    let r = 0, g = 0, b = 0, n = 0;
 
    idxList.forEach(i => {
      const x = Math.round(lm[i].x * W);
      const y = Math.round(lm[i].y * H);
      if (x >= 1 && x < W-1 && y >= 1 && y < H-1) {
        for (let dx = -1; dx <= 1; dx++) {
          for (let dy = -1; dy <= 1; dy++) {
            const d = ctx.getImageData(x+dx, y+dy, 1, 1).data;
            r += d[0]; g += d[1]; b += d[2]; n++;
          }
        }
      }
    });
 
    if (n === 0) return { passed: true, message: goodMessages[step] };
 
    r /= n; g /= n; b /= n;
 
    const skinRGB     = toneToRGB(STATE.toneKey || 'medium_warm');
    const totalDev    = Math.abs(r - skinRGB.r) + Math.abs(g - skinRGB.g) + Math.abs(b - skinRGB.b);
    const sampledSat  = rgbSaturation(r, g, b);
    const skinSat     = rgbSaturation(skinRGB.r, skinRGB.g, skinRGB.b);
    const satIncrease = sampledSat - skinSat;
    const bright      = r * .299 + g * .587 + b * .114;
    const reliable    = bright > 35 && bright < 235;
    const passed      = reliable && totalDev > 28 && satIncrease > 0.025;
 
    return { passed, message: passed ? goodMessages[step] : tipMessages[step] };
  } catch(e) {
    return { passed: true, message: goodMessages[step] };
  }
}
 
function rgbSaturation(r, g, b) {
  const max = Math.max(r, g, b) / 255;
  const min = Math.min(r, g, b) / 255;
  return max === 0 ? 0 : (max - min) / max;
}
 
function toneToRGB(key) {
  return {
    light_warm:  { r:225, g:192, b:167 },
    light_cool:  { r:218, g:190, b:180 },
    medium_warm: { r:190, g:150, b:120 },
    medium_cool: { r:178, g:152, b:144 },
    dark_warm:   { r:133, g:100, b:70  },
    dark_cool:   { r:122, g:98,  b:93  },
  }[key] || { r:185, g:148, b:122 };
}
 
const goodMessages = {
  lips:     'Great lip color! Your lips look well-defined and beautiful.',
  blush:    'Beautiful blush placement! Your cheeks are glowing naturally.',
  eyebrows: 'Your brows look well-defined and perfectly framed!',
  contour:  'Great contour! Your jawline and cheekbones look sculpted.',
};
 
const tipMessages = {
  lips:     'Follow the X at the cupid\'s bow and work outward to the corners, then fill in.',
  blush:    'Apply a little more blush to the apples of your cheeks and blend upward.',
  eyebrows: 'Fill in the brows more with short, upward strokes then check again.',
  contour:  'Build up the contour a little more along the jawline and blend the edges.',
};
 
function showFeedback(passed, message) {
  const area = document.getElementById('feedback-area');
  const icon = document.getElementById('feedback-icon');
  const msg  = document.getElementById('feedback-msg');
 
  area.style.display = '';
  area.className     = 'feedback-area ' + (passed ? 'good' : 'bad');
  icon.textContent   = passed ? '✓' : '✗';
  msg.textContent    = message;
 
  document.getElementById('btn-check').style.display = 'none';
 
  if (passed) {
    const isLast  = STATE.currentStep >= STEPS.length - 1;
    const btnNext = document.getElementById('btn-next');
    btnNext.textContent   = isLast ? 'See Final Summary →' : 'Next Step →';
    btnNext.style.display = '';
    btnNext.onclick       = isLast ? showSummary : nextStep;
  } else {
    document.getElementById('btn-retry').style.display = '';
  }
}
 
// ─────────────────────────────────────────
//  STEP NAVIGATION
// ─────────────────────────────────────────
function nextStep() {
  STATE.currentStep++;
  if (STATE.currentStep >= STEPS.length) showSummary();
  else renderStep(STATE.currentStep);
}
 
function retryStep() {
  STATE.stepResults.pop();
  renderStep(STATE.currentStep);
}
 
// ─────────────────────────────────────────
//  SUMMARY
// ─────────────────────────────────────────
function showSummary() {
  stopStream();
 
  const toneKey = STATE.toneKey || 'medium_warm';
  const tone    = STATE.shades?.[toneKey];
  const grid    = document.getElementById('summary-grid');
  grid.innerHTML = '';
 
  let passCount = 0;
 
  STATE.stepResults.forEach(r => {
    if (r.passed) passCount++;
    const shade = tone?.[r.step];
    const card  = document.createElement('div');
    card.className = 'summary-card';
    card.innerHTML = `
      <div class="summary-swatch" style="background:${shade?.hex || '#888'}"></div>
      <div>
        <div class="summary-step-name">${STEP_LABELS[r.step]}</div>
        <div class="summary-result ${r.passed ? 'ok' : 'bad'}">
          ${r.passed ? '✓ Well done' : '✗ Needs blending'}
        </div>
      </div>
    `;
    grid.appendChild(card);
  });
 
  const total   = STATE.stepResults.length;
  const overall = passCount === total
    ? 'Flawless finish! Your Soft and Natural look is complete.'
    : passCount >= total / 2
    ? 'Great effort! A little more blending and it will be perfect.'
    : 'Keep practicing! The guide is here whenever you need it.';
 
  document.getElementById('summary-sub').textContent     = `${passCount} of ${total} steps looked great`;
  document.getElementById('summary-overall').textContent = overall;
 
  goTo('screen-summary');
}
 
// ─────────────────────────────────────────
//  UTILITIES
// ─────────────────────────────────────────
function hexToRgba(hex, alpha) {
  if (!hex || hex.length < 7) return `rgba(200,120,120,${alpha})`;
  const r = parseInt(hex.slice(1, 3), 16);
  const g = parseInt(hex.slice(3, 5), 16);
  const b = parseInt(hex.slice(5, 7), 16);
  return `rgba(${r},${g},${b},${alpha})`;
}
 
// ─────────────────────────────────────────
//  INIT
// ─────────────────────────────────────────
document.addEventListener('DOMContentLoaded', () => {
  loadData();
  initParticles();
});