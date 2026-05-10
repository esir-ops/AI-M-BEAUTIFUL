const STATE = {
  focal:null, toneKey:null, shades:null, focalData:null,
  currentStep:0, stepResults:[], faceMesh:null, camera:null,
  stream:null, lastLandmarks:null, checkPending:false,
  lipSubStep:0, glassesWarned:false,
  smoothedLm:null,
  blushLm:null,
  blushFrameCount:0,
};

const STEPS       = ['lips','blush','eyebrows','contour'];
const STEP_LABELS = { lips:'Lips', blush:'Blush', eyebrows:'Eyebrows', contour:'Contour' };

const STEP_INSTRUCTIONS = {
  lips:     'Follow the glowing outline on your lips. Start at the gold dot on the V-shape at the top center, then work outward to each corner. Fill in the top, then repeat from the bottom center outward.',
  blush:    'Smile softly and sweep blush onto the apples of your cheeks, blending upward along the oval guide.',
  eyebrows: 'Fill in your brows following the guide. Use short, hair-like strokes for a natural finish.',
  contour:  'Apply contour below your cheekbones following the dashed guide. Start at the white dot near your ear and sweep inward toward your nose.',
};

const LIP_OUTER_LOOP = [61,185,40,39,37,0,267,269,270,409,291,375,321,405,314,17,84,181,91,146];
const LIP_INNER      = [78,191,80,81,82,13,312,311,310,415,308,324,318,402,317,14,87,178,88,95];
const LM_CUPID_VALLEY  = 0;
const LM_BOTTOM_CENTER = 17;
const LIP_OUTER_TOP = [61,185,40,39,37,0,267,269,270,409,291];
const LIP_OUTER_BOT = [291,375,321,405,314,17,84,181,91,146,61];
const LIP_FILL_TOP  = [61,185,40,39,37,0,267,269,270,409,291,308,415,310,311,312,13,82,81,80,191,78];
const LIP_FILL_BOT  = [291,375,321,405,314,17,84,181,91,146,61,78,95,88,178,87,14,317,402,318,324,308];
const LIP_SAMPLE_TOP = [37,0,267,82,13,312];
const LIP_SAMPLE_BOT = [17,84,314,87,14,317];

const LIP_SUBSTEP = [
  { label:'Top Lip',     badge:'Step 1 of 3', instruction:'Fill your TOP lip within the white outline. Start at the gold V-dot and stroke outward to each corner.' },
  { label:'Bottom Lip',  badge:'Step 2 of 3', instruction:'Top done! Now fill your BOTTOM lip. Start at the gold centre dot and stroke outward to each corner.' },
  { label:'Final Check', badge:'Step 3 of 3', instruction:'Both lips filled — hold still while the camera checks your overall application.' },
];

const BLUSH_CENTER_L = [205,50,116,123];
const BLUSH_CENTER_R = [425,280,345,352];

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
// ─────────────────────────────────────────
function syncOverlay(canvasEl, videoEl) {
  const rect = videoEl.getBoundingClientRect();
  const W = Math.round(rect.width)  || videoEl.videoWidth  || 640;
  const H = Math.round(rect.height) || videoEl.videoHeight || 480;
  if (canvasEl.width  !== W) canvasEl.width  = W;
  if (canvasEl.height !== H) canvasEl.height = H;
  const vW = videoEl.videoWidth  || 640;
  const vH = videoEl.videoHeight || 480;
  const scale = Math.max(W/vW, H/vH);
  const effW = vW*scale, effH = vH*scale;
  const ox = (effW-W)/2, oy = (effH-H)/2;
  return { W, H, effW, effH, ox, oy };
}

// ─────────────────────────────────────────
//  PATH HELPERS
// ─────────────────────────────────────────
function polyPath(ctx, pts) {
  if (!pts.length) return;
  ctx.moveTo(pts[0].x, pts[0].y);
  for (let i=1;i<pts.length;i++) ctx.lineTo(pts[i].x, pts[i].y);
  ctx.closePath();
}
function softPolyPath(ctx, pts) {
  const n=pts.length; if (n<2) return;
  const s={x:(pts[n-1].x+pts[0].x)/2, y:(pts[n-1].y+pts[0].y)/2};
  ctx.moveTo(s.x, s.y);
  for (let i=0;i<n;i++){const a=pts[i],b=pts[(i+1)%n]; ctx.quadraticCurveTo(a.x,a.y,(a.x+b.x)/2,(a.y+b.y)/2);}
  ctx.closePath();
}
function softArcPath(ctx, pts) {
  const n=pts.length; if (n<2) return;
  ctx.moveTo(pts[0].x, pts[0].y);
  for (let i=0;i<n-1;i++){const a=pts[i],b=pts[i+1]; ctx.quadraticCurveTo(a.x,a.y,(a.x+b.x)/2,(a.y+b.y)/2);}
  ctx.lineTo(pts[n-1].x, pts[n-1].y);
}
function lmPts(lm, indices, W, H) { return indices.map(i=>({x:lm[i].x*W, y:lm[i].y*H})); }

function detectFaceShape(lm) {
  try {
    const faceW  = Math.abs(lm[234].x - lm[454].x);
    const faceH  = Math.abs(lm[10].y  - lm[152].y);
    const jawW   = Math.abs(lm[172].x - lm[397].x);
    const foreW  = Math.abs(lm[103].x - lm[332].x);
    const cheekW = faceW || 0.001;
    const hwRatio   = faceH  / cheekW;
    const jawRatio  = jawW   / cheekW;
    const foreRatio = foreW  / cheekW;
    if (hwRatio   > 1.55)                          return 'oblong';
    if (foreRatio > 0.95 && jawRatio < 0.68)       return 'heart';
    if (foreRatio < 0.78 && jawRatio < 0.78)       return 'diamond';
    if (hwRatio   < 1.18 && jawRatio > 0.82)       return 'round';
    if (hwRatio   < 1.40 && jawRatio > 0.80)       return 'square';
    return 'oval';
  } catch(e) { return 'oval'; }
}


// ─────────────────────────────────────────
//  DATA LOADING
// ─────────────────────────────────────────
async function loadData() {
  try {
    const [s,f] = await Promise.all([
      fetch('data/shades.json').then(r=>r.json()),
      fetch('data/focal-points.json').then(r=>r.json()),
    ]);
    STATE.shades=s; STATE.focalData=f;
    console.log('Data loaded. Keys:', Object.keys(s));
  } catch(e) { console.error('Data load error:', e); }
}

// ─────────────────────────────────────────
//  SCREEN NAVIGATION
// ─────────────────────────────────────────
function goTo(id) {
  document.querySelectorAll('.screen').forEach(s=>s.classList.remove('active'));
  document.getElementById(id)?.classList.add('active');
  if (id==='screen-camera') {
    // Reset glasses reminder so it shows again on the next camera session
    STATE.glassesWarned=false;
    hideGlassesWarn();
    initCamera();
  } else if (id!=='screen-step') stopStream();
}

// ─────────────────────────────────────────
//  PARTICLES
// ─────────────────────────────────────────
function initParticles() {
  const canvas=document.getElementById('particles-bg'), ctx=canvas.getContext('2d');
  let W,H,P=[];
  function resize(){W=canvas.width=window.innerWidth; H=canvas.height=window.innerHeight;}
  resize(); window.addEventListener('resize',resize);
  for (let i=0;i<60;i++) P.push({x:Math.random()*window.innerWidth,y:Math.random()*window.innerHeight,r:Math.random()*1.4+0.3,dx:(Math.random()-.5)*.4,dy:(Math.random()-.5)*.4,o:Math.random()*.5+.1});
  (function draw(){
    ctx.clearRect(0,0,W,H);
    P.forEach(p=>{ctx.beginPath();ctx.arc(p.x,p.y,p.r,0,Math.PI*2);ctx.fillStyle=`rgba(201,149,106,${p.o})`;ctx.fill();p.x+=p.dx;p.y+=p.dy;if(p.x<0)p.x=W;if(p.x>W)p.x=0;if(p.y<0)p.y=H;if(p.y>H)p.y=0;});
    requestAnimationFrame(draw);
  })();
}

// ─────────────────────────────────────────
//  FOCAL SELECTION
// ─────────────────────────────────────────
function selectFocal(focal, el) {
  STATE.focal=focal;
  document.querySelectorAll('.focal-card').forEach(c=>c.classList.remove('selected'));
  el.classList.add('selected');
  document.getElementById('btn-to-camera').disabled=false;
}

// ─────────────────────────────────────────
//  CAMERA SETUP
// ─────────────────────────────────────────
async function initCamera() {
  const video=document.getElementById('video');
  const titleEl=document.getElementById('cam-title');
  const subEl=document.getElementById('cam-sub');
  titleEl.textContent='Requesting camera...';
  subEl.textContent='Allow camera permission when prompted';
  try {
    STATE.stream=await navigator.mediaDevices.getUserMedia({video:{width:{ideal:640},height:{ideal:480},facingMode:'user'}});
    video.srcObject=STATE.stream;
    video.onloadedmetadata=()=>{
      titleEl.textContent='Camera ready ✓';
      subEl.textContent='Click Detect My Face when ready';
      document.getElementById('btn-detect').disabled=false;
      startLightingCheck();
    };
  } catch(e){
    titleEl.textContent='Camera access denied';
    subEl.textContent='Please allow camera access in browser settings';
  }
}

function stopStream() {
  if (STATE.camera){try{STATE.camera.stop();}catch(e){} STATE.camera=null;}
  if (STATE.faceMesh){try{STATE.faceMesh.close();}catch(e){} STATE.faceMesh=null;}
  if (STATE.stream){STATE.stream.getTracks().forEach(t=>t.stop()); STATE.stream=null;}
}

// ─────────────────────────────────────────
//  LIGHTING CHECK
// ─────────────────────────────────────────
function startLightingCheck() {
  const video=document.getElementById('video');
  const warn=document.getElementById('light-warn');
  const tmp=document.createElement('canvas'); tmp.width=64; tmp.height=48;
  const tctx=tmp.getContext('2d');
  setInterval(()=>{
    if (!STATE.stream) return;
    try {
      tctx.drawImage(video,0,0,64,48);
      const d=tctx.getImageData(0,0,64,48).data;
      let br=0,rS=0,gS=0,bS=0;
      const N=d.length/4;
      for (let i=0;i<d.length;i+=4){br+=d[i]*.299+d[i+1]*.587+d[i+2]*.114;rS+=d[i];gS+=d[i+1];bS+=d[i+2];}
      const avgBr=br/N,rA=rS/N,gA=gS/N,bA=bS/N;
      const cast=Math.max(rA,gA,bA)-(rA+gA+bA)/3;
      let msg='';
      if      (avgBr<60)  msg='⚠ Too dark — move to a brighter area for accurate colour detection';
      else if (avgBr>205) msg='⚠ Too bright / overexposed — step back or reduce glare';
      else if (cast>30)   msg='⚠ Strong colour cast detected — use neutral white lighting';
      if (msg){warn.textContent=msg;warn.classList.remove('hide');}
      else    {warn.textContent='';warn.classList.add('hide');}
    } catch(e){}
  },1200);
}

function checkStepLighting(video) {
  try {
    let warn=document.getElementById('step-light-warn');
    if (!warn){
      warn=document.createElement('div'); warn.id='step-light-warn';
      Object.assign(warn.style,{position:'absolute',top:'8px',left:'50%',transform:'translateX(-50%)',background:'rgba(180,60,0,0.82)',color:'#fff',fontSize:'12px',padding:'5px 14px',borderRadius:'20px',zIndex:'99',pointerEvents:'none',textAlign:'center',maxWidth:'90%',display:'none',whiteSpace:'nowrap'});
      const wrap=document.getElementById('step-overlay')?.parentElement||document.getElementById('step-video')?.parentElement||document.body;
      wrap.style.position=wrap.style.position||'relative';
      wrap.appendChild(warn);
    }
    const tmp=document.createElement('canvas'); tmp.width=32; tmp.height=24;
    const tctx=tmp.getContext('2d'); tctx.drawImage(video,0,0,32,24);
    const d=tctx.getImageData(0,0,32,24).data;
    let br=0,rS=0,gS=0,bS=0; const N=d.length/4;
    for (let i=0;i<d.length;i+=4){br+=d[i]*.299+d[i+1]*.587+d[i+2]*.114;rS+=d[i];gS+=d[i+1];bS+=d[i+2];}
    const avgBr=br/N, cast=Math.max(rS/N,gS/N,bS/N)-(rS/N+gS/N+bS/N)/3;
    let msg='';
    if      (avgBr<60)  msg='⚠ Too dark — better lighting helps the AI detect your makeup accurately';
    else if (avgBr>205) msg='⚠ Too bright — reduce glare so colours are detected correctly';
    else if (cast>30)   msg='⚠ Colour cast — switch to neutral white light for best results';
    warn.textContent=msg; warn.style.display=msg?'block':'none';
  } catch(e){}
}

// ─────────────────────────────────────────
//  ACCESSORIES DETECTION
//  Pixel-based: runs every 50 frames.
//  Glasses  → lens area brighter than cheek.
//  Mask     → mouth area desaturated + hue-shifted vs forehead.
// ─────────────────────────────────────────
function checkAccessories(image, lm) {
  try {
    const vW=image.width||640, vH=image.height||480;
    const tmp=document.createElement('canvas'); tmp.width=vW; tmp.height=vH;
    const tctx=tmp.getContext('2d'); tctx.drawImage(image,0,0,vW,vH);
    function px(idxs){
      let r=0,g=0,b=0,n=0;
      idxs.forEach(i=>{
        if(i>=lm.length) return;
        const x=Math.round(lm[i].x*vW), y=Math.round(lm[i].y*vH);
        if(x>=2&&x<vW-2&&y>=2&&y<vH-2){const d=tctx.getImageData(x,y,1,1).data;r+=d[0];g+=d[1];b+=d[2];n++;}
      });
      return n>0?{r:r/n,g:g/n,b:b/n,br:function(){return this.r*.299+this.g*.587+this.b*.114;}}:null;
    }
    const fh=px([10,9,151,107,336]); if(!fh) return [];
    const fhBr=fh.br();
    const found=[];

    // ── Glasses detection ─────────────────────────────────────────
    // Dark frames make the temple arms and nose bridge noticeably
    // darker than surrounding skin. Reflective lenses make the eye
    // area brighter. Either signature scores a point; ≥2 = glasses.
    const cheek=px([116,345,50,280]);
    const ckBr=cheek?cheek.br():fhBr;
    let glassesScore=0;

    // Bridge/nose-pad area: often shows dark frame element
    const bridge=px([6,168,8]);
    if(bridge && Math.abs(bridge.br()-fhBr)>26) glassesScore++;

    // Left temple arm (between left ear and left eye)
    const lTemple=px([127,162,21]);
    if(lTemple && lTemple.br()<ckBr-20) glassesScore++;

    // Right temple arm
    const rTemple=px([356,389,251]);
    if(rTemple && rTemple.br()<ckBr-20) glassesScore++;

    // Lens zone: brighter (reflection) or darker (tinted/frame shadow) than forehead
    const lensZone=px([159,386]);
    if(lensZone && Math.abs(lensZone.br()-fhBr)>32) glassesScore++;

    if(glassesScore>=2) found.push('glasses');

    // ── Mask detection ────────────────────────────────────────────
    // A mask covers the mouth/chin area — any strong color shift
    // from forehead skin signals a foreign covering.
    const mouth=px([0,17,61,291,13,14,152,148,176]);
    if(mouth){
      const mDev=Math.abs(mouth.r-fh.r)+Math.abs(mouth.g-fh.g)+Math.abs(mouth.b-fh.b);
      const mSat=rgbSat(mouth.r,mouth.g,mouth.b);
      if(mDev>55||(mSat<0.08&&mDev>32)) found.push('mask');
    }
    return found;
  } catch(e){return [];}
}

function showGlassesWarn(msg) {
  if(STATE.accDismissedAt && Date.now()-STATE.accDismissedAt<12000) return;
  const el=document.getElementById('glasses-warn');
  if(!el) return;
  const sp=el.querySelector('span');
  if(sp&&msg) sp.textContent=msg;
  el.classList.remove('hide');
}
function hideGlassesWarn() {
  const el=document.getElementById('glasses-warn');
  if(el) el.classList.add('hide');
  if(STATE) STATE.accDismissedAt=Date.now();
}

// ─────────────────────────────────────────
//  MEDIAPIPE — DETECTION SCREEN
// ─────────────────────────────────────────
function startDetection() {
  document.getElementById('cam-title').textContent='Scanning your face...';
  document.getElementById('cam-sub').textContent='Keep still and look straight ahead';
  document.getElementById('btn-detect').disabled=true;
  const video=document.getElementById('video');
  if (!STATE.faceMesh){
    STATE.faceMesh=new FaceMesh({locateFile:f=>`https://cdn.jsdelivr.net/npm/@mediapipe/face_mesh/${f}`});
    STATE.faceMesh.setOptions({maxNumFaces:1,refineLandmarks:true,minDetectionConfidence:.6,minTrackingConfidence:.6});
  }
  STATE.faceMesh.onResults(onDetectResults);
  STATE.camera=new Camera(video,{onFrame:async()=>{if(STATE.faceMesh)await STATE.faceMesh.send({image:video});},width:640,height:480});
  STATE.camera.start();
}

function onDetectResults(results) {
  const canvas=document.getElementById('overlay');
  const video=document.getElementById('video');
  const {W,H,effW,effH,ox,oy}=syncOverlay(canvas,video);
  const ctx=canvas.getContext('2d');
  ctx.clearRect(0,0,W,H);
  const pFace=document.getElementById('pill-face');
  const pLM=document.getElementById('pill-lm');
  const pTone=document.getElementById('pill-tone');
  if (results.multiFaceLandmarks?.length>0){
    const lm=results.multiFaceLandmarks[0];
    STATE.lastLandmarks=lm;
    pFace.textContent='Face: Detected ✓'; pFace.classList.add('ok');
    pLM.textContent='Landmarks: 468 ✓';   pLM.classList.add('ok');
    ctx.save(); ctx.translate(-ox,-oy);
    ctx.fillStyle='rgba(201,149,106,0.22)';
    lm.forEach(pt=>{ctx.beginPath();ctx.arc(pt.x*effW,pt.y*effH,1.4,0,Math.PI*2);ctx.fill();});
    drawLips   (ctx,lm,effW,effH,'rgba(220,130,120,0.78)','rgba(220,130,120,0.18)',2,false);
    drawBrows  (ctx,lm,effW,effH,'rgba(180,130,80,0.7)','rgba(160,110,60,0.15)',3);
    drawBlush  (ctx,lm,effW,effH,'rgba(230,150,140,0.55)','rgba(230,150,140,0.10)',2);
    drawContour(ctx,lm,effW,effH,'rgba(190,140,80,0.6)','rgba(170,120,60,0.22)',2.5);
    ctx.restore();
    // Accessory detection: runs every 50 frames (~1.7 s at 30 fps)
    STATE.detectFrame=(STATE.detectFrame||0)+1;
    if(STATE.detectFrame%50===1){
      const acc=checkAccessories(results.image,lm);
      if(acc.length>0){
        const items=acc.includes('glasses')&&acc.includes('mask')?'glasses and face mask'
                   :acc.includes('glasses')?'glasses':'face mask';
        showGlassesWarn(`👓 Remove your ${items} for the most accurate AI analysis`);
      } else {
        const el=document.getElementById('glasses-warn');
        if(el&&!el.classList.contains('hide')) el.classList.add('hide');
      }
    }
    if (!STATE.toneKey){
      const tone=detectToneFromImage(results.image,lm,W,H);
      if (tone){
        STATE.toneKey=tone;
        pTone.textContent=`Tone: ${formatTone(tone)} ✓`; pTone.classList.add('ok');
        document.getElementById('cam-title').textContent='Analysis complete!';
        document.getElementById('cam-sub').textContent='Tap below to see your shade recommendations';
        const btn=document.getElementById('btn-detect');
        btn.textContent='See My Recommendations →'; btn.disabled=false; btn.onclick=showShades;
      }
    }
  } else {
    pFace.textContent='Face not found — step closer'; pFace.classList.remove('ok');
    pLM.textContent='Landmarks: —'; pLM.classList.remove('ok');
  }
}

// ─────────────────────────────────────────
//  WHITE GUIDE — plain open arc
// ─────────────────────────────────────────
function drawWhiteGuide(ctx, pts, lw) {
  ctx.save();
  ctx.beginPath(); softArcPath(ctx,pts);
  ctx.strokeStyle='rgba(255,255,255,0.90)'; ctx.lineWidth=lw*1.2;
  ctx.lineJoin='round'; ctx.lineCap='round'; ctx.stroke();
  ctx.restore();
}

// ─────────────────────────────────────────
//  DRAW LIPS
// ─────────────────────────────────────────
function drawLips(ctx, lm, W, H, strokeColor, fillColor, lw, filterMode, subStep) {
  const outerPts=lmPts(lm,LIP_OUTER_LOOP,W,H);
  const innerPts=lmPts(lm,LIP_INNER,W,H);
  const topPts  =lmPts(lm,LIP_OUTER_TOP,W,H);
  const botPts  =lmPts(lm,LIP_OUTER_BOT,W,H);
  const topFill =lmPts(lm,LIP_FILL_TOP,W,H);
  const botFill =lmPts(lm,LIP_FILL_BOT,W,H);

  if (!filterMode) {
    ctx.save(); ctx.beginPath(); softPolyPath(ctx,outerPts); ctx.fillStyle=strokeColor.replace(/[\d.]+\)$/,'0.15)'); ctx.fill(); ctx.restore();
    ctx.save(); ctx.beginPath(); softPolyPath(ctx,outerPts); ctx.strokeStyle=strokeColor; ctx.lineWidth=lw; ctx.shadowColor=strokeColor; ctx.shadowBlur=lw*3; ctx.lineJoin='round'; ctx.stroke(); ctx.restore();
    ctx.save(); ctx.beginPath(); softPolyPath(ctx,innerPts); ctx.strokeStyle=strokeColor.replace(/[\d.]+\)$/,'0.35)'); ctx.lineWidth=Math.max(1,lw*0.5); ctx.lineJoin='round'; ctx.stroke(); ctx.restore();
    return;
  }

  const hasSubStep=subStep!==undefined;

  if (hasSubStep && subStep===0) {
    ctx.save(); ctx.beginPath(); softPolyPath(ctx,topFill); ctx.fillStyle=strokeColor.replace(/[\d.]+\)$/,'0.22)'); ctx.fill(); ctx.restore();
    ctx.save(); ctx.beginPath(); softPolyPath(ctx,botFill); ctx.fillStyle='rgba(180,180,180,0.08)'; ctx.fill(); ctx.restore();
    ctx.save(); ctx.beginPath(); softArcPath(ctx,botPts); ctx.strokeStyle='rgba(200,200,200,0.25)'; ctx.lineWidth=lw*0.8; ctx.setLineDash([3,4]); ctx.lineJoin='round'; ctx.lineCap='round'; ctx.stroke(); ctx.setLineDash([]); ctx.restore();
    drawWhiteGuide(ctx,topPts,lw);
  }

  if (hasSubStep && subStep===1) {
    ctx.save(); ctx.beginPath(); softPolyPath(ctx,topFill); ctx.fillStyle=strokeColor.replace(/[\d.]+\)$/,'0.35)'); ctx.fill(); ctx.restore();
    ctx.save(); ctx.beginPath(); softArcPath(ctx,topPts); ctx.strokeStyle=strokeColor.replace(/[\d.]+\)$/,'0.70)'); ctx.lineWidth=lw*1.2; ctx.lineJoin='round'; ctx.lineCap='round'; ctx.stroke(); ctx.restore();
    ctx.save(); ctx.beginPath(); softPolyPath(ctx,botFill); ctx.fillStyle=strokeColor.replace(/[\d.]+\)$/,'0.22)'); ctx.fill(); ctx.restore();
    drawWhiteGuide(ctx,botPts,lw);
  }

  if (!hasSubStep || subStep===2) {
    ctx.save(); ctx.beginPath(); softPolyPath(ctx,outerPts); ctx.fillStyle=strokeColor.replace(/[\d.]+\)$/,'0.22)'); ctx.fill(); ctx.restore();
    ctx.save(); ctx.beginPath(); softPolyPath(ctx,outerPts); ctx.strokeStyle='rgba(0,0,0,0.40)'; ctx.lineWidth=lw*2+3; ctx.lineJoin='round'; ctx.stroke(); ctx.restore();
    ctx.save(); ctx.beginPath(); softPolyPath(ctx,outerPts); ctx.strokeStyle=strokeColor; ctx.lineWidth=lw*1.6; ctx.shadowColor=strokeColor; ctx.shadowBlur=lw*2; ctx.lineJoin='round'; ctx.stroke(); ctx.restore();
    ctx.save(); ctx.beginPath(); softPolyPath(ctx,innerPts); ctx.strokeStyle=strokeColor.replace(/[\d.]+\)$/,'0.55)'); ctx.lineWidth=Math.max(1,lw*0.7); ctx.lineJoin='round'; ctx.stroke(); ctx.restore();
  }

  const dotR=Math.max(3,Math.abs(lm[LM_BOTTOM_CENTER].y*H-lm[LM_CUPID_VALLEY].y*H)*0.07);
  const dotDefs=[];
  if (!hasSubStep||subStep===0) dotDefs.push({idx:LM_CUPID_VALLEY,scale:1.0},{idx:61,scale:0.75},{idx:291,scale:0.75});
  if (!hasSubStep||subStep===1) dotDefs.push({idx:LM_BOTTOM_CENTER,scale:1.0},...(hasSubStep?[]:[{idx:61,scale:0.65},{idx:291,scale:0.65}]));
  if (hasSubStep&&subStep===2) dotDefs.push({idx:LM_CUPID_VALLEY,scale:0.85},{idx:LM_BOTTOM_CENTER,scale:0.85});
  dotDefs.forEach(({idx,scale})=>{
    const pt={x:lm[idx].x*W,y:lm[idx].y*H};
    ctx.save(); ctx.beginPath(); ctx.arc(pt.x,pt.y,dotR*scale,0,Math.PI*2); ctx.fillStyle='#ffe066'; ctx.fill(); ctx.restore();
  });
}

// ─────────────────────────────────────────
//  DRAW BROWS — beginner-friendly guide
//  Soft fill + dashed outline + 6 upward
//  hair strokes + gold start dot + tail
//  arrow showing stroke direction.
// ─────────────────────────────────────────
function drawBrows(ctx, lm, W, H, sc, fc, lw) {
  [[BROW_LEFT_TOP,BROW_LEFT_BOTTOM],[BROW_RIGHT_TOP,BROW_RIGHT_BOTTOM]].forEach(([top,bot])=>{
    const topPts = top.map(i=>({x:lm[i].x*W, y:lm[i].y*H}));
    const botPts = bot.map(i=>({x:lm[i].x*W, y:lm[i].y*H}));
    const allPts = [...topPts, ...[...botPts].reverse()];

    const midT = topPts[Math.floor(topPts.length/2)];
    const midB = botPts[Math.floor(botPts.length/2)];
    const browH = Math.hypot(midT.x-midB.x, midT.y-midB.y);

    // 1. Soft blurred fill — shows WHERE to apply colour
    if (fc) {
      ctx.save();
      ctx.filter='blur(2.5px)';
      ctx.beginPath(); softPolyPath(ctx,allPts);
      ctx.fillStyle=fc; ctx.fill();
      ctx.restore();
    }

    // 2. Dashed outline — boundary to stay within
    ctx.save();
    ctx.beginPath(); softPolyPath(ctx,allPts);
    ctx.strokeStyle=sc; ctx.lineWidth=lw*0.8; ctx.lineJoin='round';
    ctx.setLineDash([lw*2.5,lw*1.5]); ctx.stroke(); ctx.setLineDash([]);
    ctx.restore();

    // 3. Short upward hair strokes — shows HOW to fill
    const N=6;
    for (let s=0;s<N;s++){
      const t=(s+0.5)/N;
      const ti=Math.min(Math.round(t*(topPts.length-1)),topPts.length-1);
      const bi=Math.min(Math.round(t*(botPts.length-1)),botPts.length-1);
      const mx=(topPts[ti].x+botPts[bi].x)/2;
      const my=(topPts[ti].y+botPts[bi].y)/2;
      const ta=Math.min(ti+1,topPts.length-1), tb=Math.max(ti-1,0);
      const browAngle=Math.atan2(topPts[ta].y-topPts[tb].y, topPts[ta].x-topPts[tb].x);
      const hairAngle=browAngle-Math.PI/2;
      const sLen=Math.max(browH*1.4, lw*3);
      ctx.save();
      ctx.translate(mx,my); ctx.rotate(hairAngle);
      ctx.beginPath(); ctx.moveTo(0,-sLen*0.62); ctx.lineTo(0,sLen*0.38);
      ctx.strokeStyle=sc; ctx.lineWidth=lw*0.48;
      ctx.lineCap='round'; ctx.globalAlpha=0.65; ctx.stroke();
      ctx.restore();
    }

    // 4. Gold start dot at inner corner
    ctx.save();
    ctx.beginPath();
    ctx.arc(topPts[0].x,topPts[0].y,Math.max(2.5,lw*0.95),0,Math.PI*2);
    ctx.fillStyle='#ffe066'; ctx.fill();
    ctx.restore();

    // 5. Arrow at tail showing direction
    const n=topPts.length;
    if (n>=2){
      const tail=topPts[n-1], prev=topPts[n-2];
      const ang=Math.atan2(tail.y-prev.y, tail.x-prev.x);
      const ah=lw*2.2;
      ctx.save();
      ctx.translate(tail.x,tail.y); ctx.rotate(ang);
      ctx.beginPath();
      ctx.moveTo(-ah,-ah*0.55); ctx.lineTo(0,0); ctx.lineTo(-ah,ah*0.55);
      ctx.strokeStyle=sc; ctx.lineWidth=lw*0.7;
      ctx.lineCap='round'; ctx.lineJoin='round'; ctx.stroke();
      ctx.restore();
    }
  });
}

// ─────────────────────────────────────────
//  DRAW BLUSH — diagonal sweep guide
// ─────────────────────────────────────────
function drawBlush(ctx, lm, W, H, sc, fc, lw, coverage) {
  const faceW = Math.abs(lm[234].x - lm[454].x) * W;
  const faceH = Math.abs(lm[10].y  - lm[152].y) * H;
  const faceRef = Math.max(faceW, faceH * 0.80);

  const noseRatio = (lm[1].x - lm[234].x) / ((lm[454].x - lm[234].x) || 0.001);

  const visL = Math.min(1, Math.max(0, (noseRatio - 0.15) / 0.22));
  const visR = Math.min(1, Math.max(0, (0.85 - noseRatio) / 0.22));

  const rx = faceRef * 0.155;
  const ry = faceRef * 0.072;

  const nosePx = lm[1].x * W;
  const nosePy = lm[1].y * H;

  const zones = [
    { temple: 234, vis: visL },
    { temple: 454, vis: visR },
  ];

  zones.forEach(({ temple, vis }) => {
    if (vis <= 0.02) return;

    const templePx = lm[temple].x * W;
    const templePy = lm[temple].y * H;
    const cx = nosePx + 0.60 * (templePx - nosePx);
    const cy = nosePy + 0.60 * (templePy - nosePy) + faceRef * 0.035;

    const angle = Math.atan2(lm[temple].y - lm[1].y, lm[temple].x - lm[1].x);

    const rxV = rx;
    const ryV = ry * Math.max(0.55, vis);

    const arrowStart = -rxV * 0.42;
    const arrowEnd   =  rxV * 0.52;
    const ah         = lw * 2.5;

    ctx.save();
    ctx.globalAlpha = vis;
    ctx.translate(cx, cy);
    ctx.rotate(angle);

    if (fc) {
      ctx.save();
      ctx.scale(1, ryV / rxV);
      const grad = ctx.createRadialGradient(-rxV*0.15, 0, 0, 0, 0, rxV);
      grad.addColorStop(0, sc.replace(/[\d.]+\)$/, '0.22)'));
      grad.addColorStop(1, sc.replace(/[\d.]+\)$/, '0)'));
      ctx.beginPath(); ctx.arc(0, 0, rxV, 0, Math.PI*2);
      ctx.fillStyle = grad; ctx.fill();
      ctx.restore();
    }

    ctx.save();
    ctx.beginPath(); ctx.ellipse(0, 0, rxV, ryV, 0, 0, Math.PI*2);
    ctx.strokeStyle = 'rgba(255,255,255,0.90)';
    ctx.lineWidth   = lw * 1.2;
    ctx.setLineDash([lw*3, lw*2]);
    ctx.lineJoin    = 'round';
    ctx.stroke();
    ctx.setLineDash([]);
    ctx.restore();

    ctx.save();
    ctx.strokeStyle = 'rgba(255,255,255,0.72)';
    ctx.lineWidth   = lw * 0.9;
    ctx.lineCap     = 'round';
    ctx.lineJoin    = 'round';
    ctx.beginPath();
    ctx.moveTo(arrowStart, 0);
    ctx.lineTo(arrowEnd, 0);
    ctx.stroke();
    ctx.beginPath();
    ctx.moveTo(arrowEnd - ah, -ah * 0.6);
    ctx.lineTo(arrowEnd, 0);
    ctx.lineTo(arrowEnd - ah,  ah * 0.6);
    ctx.stroke();
    ctx.restore();

    ctx.save();
    ctx.beginPath();
    ctx.arc(arrowStart + lw*1.5, 0, Math.max(2.5, lw*0.95), 0, Math.PI*2);
    ctx.fillStyle = 'rgba(255,255,255,0.88)';
    ctx.fill();
    ctx.restore();

    ctx.restore();
  });
}

// ─────────────────────────────────────────
//  NOSE CONTOUR GUIDE
//  Two slim dashed lines along the sides
//  of the nose bridge — universal for all
//  face shapes.
// ─────────────────────────────────────────
function drawNoseContourGuide(ctx, lm, W, H, sc, fc, lw) {
  const bridge = { x:lm[168].x*W, y:lm[168].y*H };
  const tip    = { x:lm[4].x*W,   y:lm[4].y*H   };
  const alarL  = { x:lm[49].x*W,  y:lm[49].y*H  };
  const alarR  = { x:lm[279].x*W, y:lm[279].y*H };
  const nH     = Math.abs(tip.y - bridge.y);
  const off    = nH * 0.10;

  [
   { p0:{x:bridge.x-off, y:bridge.y+nH*0.08}, ctrl:{x:alarL.x-off*0.4, y:bridge.y+nH*0.50}, p2:{x:alarL.x, y:alarL.y} },
    { p0:{x:bridge.x+off, y:bridge.y+nH*0.08}, ctrl:{x:alarR.x+off*0.4, y:bridge.y+nH*0.50}, p2:{x:alarR.x, y:alarR.y} },
  ].forEach(({p0,ctrl,p2})=>{
    if (fc) {
      ctx.save(); ctx.filter='blur(2px)';
      ctx.beginPath(); ctx.moveTo(p0.x,p0.y); ctx.quadraticCurveTo(ctrl.x,ctrl.y,p2.x,p2.y);
      ctx.strokeStyle=fc; ctx.lineWidth=lw*4; ctx.lineCap='round'; ctx.stroke();
      ctx.restore();
    }

    ctx.save();
    ctx.beginPath(); ctx.moveTo(p0.x,p0.y); ctx.quadraticCurveTo(ctrl.x,ctrl.y,p2.x,p2.y);
    ctx.strokeStyle=sc; ctx.lineWidth=lw*0.85; ctx.lineCap='round';
    ctx.setLineDash([lw*2,lw*1.5]); ctx.stroke(); ctx.setLineDash([]);
    ctx.restore();
  });
}

// ─────────────────────────────────────────
//  DRAW CONTOUR — face-shape aware guide
//  Shows nose contour (universal) plus
//  cheek / jaw sweep paths tailored to the
//  detected face shape.
//  Shapes: oval · round · oblong · heart ·
//          diamond · square
// ─────────────────────────────────────────
function drawContour(ctx, lm, W, H, sc, fc, lw) {
  const shape = detectFaceShape(lm);
  const faceH = Math.abs(lm[10].y  - lm[152].y) * H;
  const faceW = Math.abs(lm[234].x - lm[454].x) * W;

  function P(i){ return {x:lm[i].x*W, y:lm[i].y*H}; }

  // Reusable quadratic bezier sweep with blurred hint + dashed stroke + arrow + dot
  function sweepStroke(p0, ctrl, p2) {
    if (fc) {
      ctx.save(); ctx.filter='blur(4px)';
      ctx.beginPath(); ctx.moveTo(p0.x,p0.y); ctx.quadraticCurveTo(ctrl.x,ctrl.y,p2.x,p2.y);
      ctx.strokeStyle=fc; ctx.lineWidth=lw*9; ctx.lineCap='round'; ctx.stroke();
      ctx.restore();
    }
    ctx.save();
    ctx.beginPath(); ctx.moveTo(p0.x,p0.y); ctx.quadraticCurveTo(ctrl.x,ctrl.y,p2.x,p2.y);
    ctx.strokeStyle=sc; ctx.lineWidth=lw*1.4; ctx.lineCap='round';
    ctx.setLineDash([lw*4,lw*2.5]); ctx.stroke(); ctx.setLineDash([]);
    ctx.restore();

    const ah=lw*2.8, ang=Math.atan2(p2.y-ctrl.y, p2.x-ctrl.x);
    ctx.save(); ctx.translate(p2.x,p2.y); ctx.rotate(ang);
    ctx.beginPath(); ctx.moveTo(-ah,-ah*0.52); ctx.lineTo(0,0); ctx.lineTo(-ah,ah*0.52);
    ctx.strokeStyle=sc; ctx.lineWidth=lw*0.9; ctx.lineCap='round'; ctx.lineJoin='round'; ctx.stroke();
    ctx.restore();
    ctx.save(); ctx.beginPath(); ctx.arc(p0.x,p0.y,Math.max(2.5,lw*0.95),0,Math.PI*2);
    ctx.fillStyle='rgba(255,255,255,0.92)'; ctx.fill(); ctx.restore();
  }

  // ① Nose sides — always shown
  drawNoseContourGuide(ctx, lm, W, H, sc, fc, lw);

  // ② Cheek / jaw strokes — per face shape
  if (shape==='oval') {
    // Classic cheekbone hollow sweep: ear → upper-cheek → hollow
    [{s:234,c:116,e:132},{s:454,c:345,e:361}].forEach(({s,c,e})=>{
      const p0=P(s), ctrl=P(c), pe=P(e);
      sweepStroke(p0, ctrl, {x:p0.x+0.65*(pe.x-p0.x), y:p0.y+0.65*(pe.y-p0.y)+faceH*0.01});
    });
  }

  if (shape==='round') {
    // Long sweep temple → cheek-mid → lower jaw to slim sides
    [{s:234,c:116,e:172},{s:454,c:345,e:397}].forEach(({s,c,e})=>{
      sweepStroke(P(s), P(c), P(e));
    });
  }

  if (shape==='oblong') {
    // Cheek sweep + short forehead-corner marks to add visual width
    [{s:234,c:116,e:132},{s:454,c:345,e:361}].forEach(({s,c,e})=>{
      const p0=P(s), ctrl=P(c), pe=P(e);
      sweepStroke(p0, ctrl, {x:p0.x+0.65*(pe.x-p0.x), y:p0.y+0.65*(pe.y-p0.y)+faceH*0.01});
    });
    [{i:103,dir:1},{i:332,dir:-1}].forEach(({i,dir})=>{
      const sp=P(i);
      sweepStroke(sp, {x:sp.x+dir*faceW*0.06,y:sp.y+faceH*0.03}, {x:sp.x+dir*faceW*0.13,y:sp.y+faceH*0.06});
    });
  }

  if (shape==='heart') {
    // Jaw sides: from cheek outward down toward chin to widen jaw visually
    [{s:234,c:172,e:150},{s:454,c:397,e:379}].forEach(({s,c,e})=>{
      sweepStroke(P(s), P(c), P(e));
    });
  }

  if (shape==='diamond') {
    // Forehead sides (down) + lower jaw sides to balance wide cheekbones
    [{s:103,c:234,e:116},{s:332,c:454,e:345}].forEach(({s,c,e})=>{
      sweepStroke(P(s), P(c), P(e));
    });
    [{s:116,c:172,e:150},{s:345,c:397,e:379}].forEach(({s,c,e})=>{
      sweepStroke(P(s), P(c), P(e));
    });
  }

  if (shape==='square') {
    // Like oval but extended to jaw corner to soften angular jaw
    [{s:234,c:116,e:172},{s:454,c:345,e:397}].forEach(({s,c,e})=>{
      sweepStroke(P(s), P(c), P(e));
    });
  }
}

// ─────────────────────────────────────────
//  SKIN TONE
// ─────────────────────────────────────────
function detectToneFromImage(image, lm, W, H) {
  try {
    const vW=image.width||W, vH=image.height||H;
    const tmp=document.createElement('canvas'); tmp.width=vW; tmp.height=vH;
    const ctx=tmp.getContext('2d'); ctx.drawImage(image,0,0,vW,vH);
    const pts=[lm[234],lm[454],lm[1],lm[6],lm[199],lm[117],lm[346],lm[50]];
    let tR=0,tG=0,tB=0,n=0;
    pts.forEach(pt=>{
      for(let dx=-1;dx<=1;dx++) for(let dy=-1;dy<=1;dy++){
        const x=Math.round(pt.x*vW)+dx, y=Math.round(pt.y*vH)+dy;
        if(x>=0&&x<vW&&y>=0&&y<vH){const d=ctx.getImageData(x,y,1,1).data;tR+=d[0];tG+=d[1];tB+=d[2];n++;}
      }
    });
    if (!n) return 'medium_warm';
    const r=tR/n,g=tG/n,b=tB/n,br=r*.299+g*.587+b*.114;
    return `${br>160?'light':br>105?'medium':'dark'}_${(r-b)>18?'warm':'cool'}`;
  } catch(e){return 'medium_warm';}
}
function formatTone(k){return{light_warm:'Light Warm',light_cool:'Light Cool',medium_warm:'Medium Warm',medium_cool:'Medium Cool',dark_warm:'Deep Warm',dark_cool:'Deep Cool'}[k]||k;}

// ─────────────────────────────────────────
//  SHADE RECOMMENDATIONS
// ─────────────────────────────────────────
function showShades() {
  const toneKey=STATE.toneKey||'medium_warm';
  const tone=STATE.shades?.[toneKey];
  if (!tone){console.error('No shades for',toneKey);return;}
  document.getElementById('shade-tone-label').textContent=`Skin tone: ${formatTone(toneKey)} · Soft & Natural`;
  const map={lips:'lips',eyebrows:'eyebrows',cheeks:'blush',contour:'contour'};
  const focal=map[STATE.focal]||STATE.focal;
  document.getElementById('focal-badge-label').textContent=STATE.focalData?.[STATE.focal]?.label||STATE.focal;
  const grid=document.getElementById('shade-grid'); grid.innerHTML='';
  STEPS.forEach(step=>{
    const shade=tone[step]; if (!shade) return;
    const isFocal=step===focal;
    const card=document.createElement('div');
    card.className='shade-card'+(isFocal?' focal-highlight':'');
    card.innerHTML=`<div class="shade-swatch" style="background:${shade.hex}"></div><div class="shade-step-label">${STEP_LABELS[step]}${isFocal?'<span class="focal-star"> ★</span>':''}</div><div class="shade-name-txt">${shade.shade}</div><div class="shade-brand-txt">${shade.brand||shade.product||''}</div><div class="shade-slot-badge">Slot ${shade.slot}</div>`;
    grid.appendChild(card);
  });
  goTo('screen-shades');
  prewarmTryOnMesh();
}

// ─────────────────────────────────────────
//  MAKEUP STEP LOOP
// ─────────────────────────────────────────
async function startMakeupSteps() {
  stopTryOn();
  stopStream();
  STATE.currentStep=0; STATE.stepResults=[]; STATE.lipSubStep=0;
  renderStep(0); goTo('screen-step');
  const sv=document.getElementById('step-video');
  try {
    STATE.stream=await navigator.mediaDevices.getUserMedia({video:{width:{ideal:640},height:{ideal:480},facingMode:'user'}});
    sv.srcObject=STATE.stream;
    if (sv.readyState>=1) startStepFaceMesh();
    else sv.onloadedmetadata=()=>startStepFaceMesh();
  } catch(e){console.error('Step camera error:',e);}
}

function renderStep(index) {
  const step=STEPS[index];
  const tone=STATE.shades?.[STATE.toneKey||'medium_warm'];
  const shade=tone?.[step];
  const dr=document.getElementById('step-dot-row'); dr.innerHTML='';
  STEPS.forEach((_,i)=>{const d=document.createElement('div');d.className='step-dot'+(i<index?' done':i===index?' active':'');dr.appendChild(d);});

  if (step==='lips'){
    const sub=LIP_SUBSTEP[STATE.lipSubStep]||LIP_SUBSTEP[0];
    document.getElementById('step-counter').textContent=`Step ${index+1} of ${STEPS.length}  ·  ${sub.badge}`;
    document.getElementById('step-name').textContent=`Lips · ${sub.label}`;
    document.getElementById('step-instruction').textContent=sub.instruction;
  } else {
    document.getElementById('step-counter').textContent=`Step ${index+1} of ${STEPS.length}`;
    document.getElementById('step-name').textContent=STEP_LABELS[step];
    document.getElementById('step-instruction').textContent=STEP_INSTRUCTIONS[step];
  }

  if (shade){
    document.getElementById('ssc-swatch').style.background=shade.hex;
    document.getElementById('ssc-shade').textContent=shade.shade;
    document.getElementById('ssc-brand').textContent=shade.brand||shade.product||'';
    document.getElementById('ssc-slot').textContent=`Tray slot ${shade.slot}`;
  }
  document.getElementById('feedback-area').style.display='none';
  document.getElementById('btn-check').style.display='';
  document.getElementById('btn-check').disabled=false;
  document.getElementById('btn-check').onclick=checkPlacement;
  document.getElementById('btn-next').style.display='none';
  document.getElementById('btn-retry').style.display='none';
  STATE.checkPending=false;

  STATE.blushLm         = null;
  STATE.blushFrameCount = 0;

  let skipBtn=document.getElementById('btn-skip');
  if (!skipBtn){
    skipBtn=document.createElement('button'); skipBtn.id='btn-skip'; skipBtn.textContent='Skip step →';
    Object.assign(skipBtn.style,{marginTop:'8px',padding:'6px 18px',fontSize:'12px',background:'transparent',color:'rgba(255,255,255,0.45)',border:'1px solid rgba(255,255,255,0.20)',borderRadius:'20px',cursor:'pointer',display:'block',width:'100%',letterSpacing:'0.04em'});
    skipBtn.onmouseenter=()=>skipBtn.style.color='rgba(255,255,255,0.80)';
    skipBtn.onmouseleave=()=>skipBtn.style.color='rgba(255,255,255,0.45)';
    const retryBtn=document.getElementById('btn-retry');
    retryBtn?.parentElement?.insertBefore(skipBtn,retryBtn.nextSibling);
  }
  skipBtn.style.display='block';
  skipBtn.onclick=skipStep;
}

// ─────────────────────────────────────────
//  STEP FACE MESH
// ─────────────────────────────────────────
function startStepFaceMesh() {
  requestAnimationFrame(()=>requestAnimationFrame(()=>{
    const video=document.getElementById('step-video');
    const fm=new FaceMesh({locateFile:f=>`https://cdn.jsdelivr.net/npm/@mediapipe/face_mesh/${f}`});
    fm.setOptions({maxNumFaces:1,refineLandmarks:true,minDetectionConfidence:.6,minTrackingConfidence:.6});
    fm.onResults(onStepResults); STATE.faceMesh=fm;
    const cam=new Camera(video,{onFrame:async()=>{if(STATE.faceMesh)await STATE.faceMesh.send({image:video});},width:640,height:480});
    STATE.camera=cam; cam.start();
  }));
}

function onStepResults(results) {
  const canvas=document.getElementById('step-overlay');
  const video=document.getElementById('step-video');
  if (!canvas||!video) return;
  const {W,H,effW,effH,ox,oy}=syncOverlay(canvas,video);
  const ctx=canvas.getContext('2d');
  ctx.clearRect(0,0,W,H);
  if (!results.multiFaceLandmarks?.length) return;

  const lm=results.multiFaceLandmarks[0];
  STATE.lastLandmarks=lm;

  let headDelta = 1;
  if (!STATE.smoothedLm||STATE.smoothedLm.length!==lm.length){
    STATE.smoothedLm=lm.map(p=>({x:p.x,y:p.y}));
  } else {
    let maxDelta=0;
    [1,234,454,10,152].forEach(i=>{const dx=lm[i].x-STATE.smoothedLm[i].x,dy=lm[i].y-STATE.smoothedLm[i].y;maxDelta=Math.max(maxDelta,Math.sqrt(dx*dx+dy*dy));});
    headDelta = maxDelta;
    // Cap at 0.75 — prevents guide from snapping on fast head moves
    const ALPHA = maxDelta>0.050 ? 0.75 : maxDelta>0.020 ? 0.58 : maxDelta>0.008 ? 0.40 : 0.20;
    STATE.smoothedLm=STATE.smoothedLm.map((s,i)=>({x:s.x+ALPHA*(lm[i].x-s.x),y:s.y+ALPHA*(lm[i].y-s.y)}));
  }
  const dlm=STATE.smoothedLm;

  const isFrontalStep = lm[1].x > 0.20 && lm[1].x < 0.80;

  const fMap={lips:'lips',eyebrows:'eyebrows',cheeks:'blush',contour:'contour'};
  const cs=STEPS[STATE.currentStep];
  const fs=fMap[STATE.focal]||cs;
  const shade=STATE.shades?.[STATE.toneKey||'medium_warm']?.[cs];
  const hex=shade?.hex||'#e87090';
  const sc=hexToRgba(hex,0.92);
  const fc=hexToRgba(hex,0.30);

  if (cs==='blush') {
    const BLUSH_IDX = [1, 10, 152, 205, 50, 116, 123, 425, 280, 345, 352, 234, 454];
    if (!STATE.blushLm) {
      STATE.blushLm = dlm.map(p => ({x:p.x, y:p.y}));
    } else {
      STATE.blushFrameCount++;
      const warmUp = STATE.blushFrameCount < 20;
      const A = warmUp             ? 0.55
              : headDelta > 0.040  ? 1.00
              : headDelta > 0.001  ? 0.09 + (headDelta / 0.040) * 0.85
              :                      0.08;
      BLUSH_IDX.forEach(i => {
        STATE.blushLm[i].x += A * (dlm[i].x - STATE.blushLm[i].x);
        STATE.blushLm[i].y += A * (dlm[i].y - STATE.blushLm[i].y);
      });
      dlm.forEach((p,i) => {
        if (!BLUSH_IDX.includes(i)) { STATE.blushLm[i].x = p.x; STATE.blushLm[i].y = p.y; }
      });
    }
  }

  const blm = (cs==='blush' && STATE.blushLm) ? STATE.blushLm : dlm;

  ctx.save(); ctx.translate(-ox,-oy);

  if (isFrontalStep) {
    const blushCov=cs==='blush'?getBlushCoverage(document.getElementById('step-video'),blm):undefined;

    if      (cs==='lips')     drawLips   (ctx,dlm,effW,effH,sc,fc,3.5,true,STATE.lipSubStep);
    else if (cs==='blush')    drawBlush  (ctx,dlm,effW,effH,sc,fc,4,blushCov);
    else if (cs==='eyebrows') drawBrows  (ctx,dlm,effW,effH,sc,fc,4.5);
    else if (cs==='contour')  drawContour(ctx,dlm,effW,effH,sc,fc,4);

    if (cs===fs&&cs!=='lips'){
      const gc=hexToRgba(hex,1.0);
      ctx.save(); ctx.shadowColor=hex; ctx.shadowBlur=18;
      if      (cs==='blush')    drawBlush  (ctx,dlm,effW,effH,gc,null,2,blushCov);
      else if (cs==='eyebrows') drawBrows  (ctx,dlm,effW,effH,gc,null,2.5);
      else if (cs==='contour')  drawContour(ctx,dlm,effW,effH,gc,null,2);
      ctx.restore();
    }
  } else {
    // Face turned — show gentle prompt only
    ctx.save();
    ctx.font='bold 13px Jost,sans-serif';
    ctx.fillStyle='rgba(255,255,255,0.70)';
    ctx.textAlign='center';
    ctx.fillText('Face the camera for guide overlay', W/2+ox, H*0.08+oy);
    ctx.restore();
  }
  ctx.restore();
  checkStepLighting(video);
}

// ─────────────────────────────────────────
//  PLACEMENT CHECK
// ─────────────────────────────────────────
async function checkPlacement() {
  if (STATE.checkPending) return;
  STATE.checkPending=true;
  document.getElementById('btn-check').disabled=true;
  const vid=document.getElementById('step-video');
  const step=STEPS[STATE.currentStep];
  const lm=STATE.lastLandmarks;
  if (!lm){showFeedback(false,'Face not detected clearly. Make sure you are well-lit and centred.');return;}

  if (step==='lips'){
    const r=await analyzeLipSubStepAsync(vid,lm,STATE.lipSubStep);
    if (!r.passed) showFeedback(false,r.message);
    else if (r.warning) showShadeWarning(r.message,r);
    else advanceLipSubStep(r);
    return;
  }

  const r=analyzeZoneColor(vid,lm,step);
  STATE.stepResults.push({step,passed:r.passed,message:r.message});
  showFeedback(r.passed,r.message);
}

function advanceLipSubStep(r) {
  const step=STEPS[STATE.currentStep];
  const next=STATE.lipSubStep+1;
  if (next>=LIP_SUBSTEP.length){
    STATE.lipSubStep=0;
    STATE.stepResults.push({step,passed:true,message:r.message});
    showFeedback(true,r.message);
  } else {
    STATE.lipSubStep=next;
    document.getElementById('step-name').textContent=`Lips · ${LIP_SUBSTEP[next].label}`;
    document.getElementById('step-instruction').textContent=LIP_SUBSTEP[next].instruction;
    document.getElementById('step-counter').textContent=`Step 1 of ${STEPS.length}  ·  ${LIP_SUBSTEP[next].badge}`;
    const area=document.getElementById('feedback-area');
    area.style.display=''; area.className='feedback-area good';
    document.getElementById('feedback-icon').textContent='✓';
    document.getElementById('feedback-msg').textContent=r.message;
    document.getElementById('btn-check').style.display='none';
    document.getElementById('btn-retry').style.display='none';
    document.getElementById('btn-next').style.display='none';
    const skipBtn=document.getElementById('btn-skip'); if(skipBtn)skipBtn.style.display='none';
    setTimeout(()=>{
      area.style.display='none';
      document.getElementById('btn-check').style.display='';
      document.getElementById('btn-check').disabled=false;
      document.getElementById('btn-check').onclick=checkPlacement;
      STATE.checkPending=false;
    },1800);
  }
}

function showShadeWarning(message, r) {
  const area=document.getElementById('feedback-area');
  area.style.display=''; area.className='feedback-area bad';
  document.getElementById('feedback-icon').textContent='⚠';
  document.getElementById('feedback-msg').textContent=message;
  document.getElementById('btn-check').style.display='none';
  const retryBtn=document.getElementById('btn-retry');
  retryBtn.textContent='Try recommended shade'; retryBtn.style.display='';
  retryBtn.onclick=()=>{area.style.display='none';retryBtn.style.display='none';document.getElementById('btn-next').style.display='none';document.getElementById('btn-check').style.display='';document.getElementById('btn-check').disabled=false;document.getElementById('btn-check').onclick=checkPlacement;STATE.checkPending=false;};
  const nextBtn=document.getElementById('btn-next');
  nextBtn.textContent='Proceed anyway →'; nextBtn.style.display='';
  nextBtn.onclick=()=>advanceLipSubStep(r);
  STATE.checkPending=false;
}

// ─────────────────────────────────────────
//  ASYNC MULTI-FRAME LIP ANALYSIS
// ─────────────────────────────────────────
async function analyzeLipSubStepAsync(video, lm, subStep) {
  const sampleIdx=subStep===0?LIP_SAMPLE_TOP:subStep===1?LIP_SAMPLE_BOT:[...LIP_SAMPLE_TOP,...LIP_SAMPLE_BOT];
  const FRAMES=4, DELAY=80;
  const snapshots=[];
  for (let f=0;f<FRAMES;f++){
    if(f>0) await new Promise(res=>setTimeout(res,DELAY));
    const W=video.videoWidth||640, H=video.videoHeight||480;
    const tmp=document.createElement('canvas'); tmp.width=W; tmp.height=H;
    const tctx=tmp.getContext('2d'); tctx.drawImage(video,0,0,W,H);
    snapshots.push({tctx,W,H});
  }
  function sampleAveraged(indices){
    let r=0,g=0,b=0,n=0;
    snapshots.forEach(({tctx,W,H})=>{
      indices.forEach(i=>{
        const x=Math.round(lm[i].x*W),y=Math.round(lm[i].y*H);
        if(x>=1&&x<W-1&&y>=1&&y<H-1) for(let dx=-1;dx<=1;dx++) for(let dy=-1;dy<=1;dy++){const d=tctx.getImageData(x+dx,y+dy,1,1).data;r+=d[0];g+=d[1];b+=d[2];n++;}
      });
    });
    return n>0?{r:r/n,g:g/n,b:b/n}:null;
  }
  const zone=sampleAveraged(sampleIdx);
  if (!zone) return {passed:true,message:goodMessages['lips']};
  const {r,g,b}=zone;
  const br=r*0.299+g*0.587+b*0.114;
  const cheek=sampleAveraged([50,280,205,425,36,266]);
  const ck=cheek??toneToRGB(STATE.toneKey||'medium_warm');
  const forehead=sampleAveraged([10,9,151,107,336]);
  const fh=forehead??ck;
  const dev=Math.abs(r-ck.r)+Math.abs(g-ck.g)+Math.abs(b-ck.b);
  const devFH=Math.abs(r-fh.r)+Math.abs(g-fh.g)+Math.abs(b-fh.b);
  const satIncrease=rgbSat(r,g,b)-rgbSat(ck.r,ck.g,ck.b);
  const absoluteSat=rgbSat(r,g,b);
  const redShift=(r-g)-(ck.r-ck.g);
  const pinkShift=(r-b)-(ck.r-ck.b);
  const detected=br>20&&br<252&&absoluteSat>0.22&&dev>42&&devFH>50&&satIncrease>0.09&&(redShift>20||pinkShift>22);
  if (!detected){
    let msg;
    if(absoluteSat<0.18||devFH<=50) msg='No lipstick detected — lips look natural. Apply colour fully within the outline and hold still.';
    else if(dev<=42) msg='Colour too similar to your skin tone. Try the recommended shade for a clearer result.';
    else if(satIncrease<=0.09) msg='Application too sheer. Build up coverage within the outline and try again.';
    else msg='Lipstick not detected yet. Make sure the area is well-lit, fill within the outline, and hold still.';
    return {passed:false,message:msg};
  }
  const {tctx:lastCtx,W:lastW,H:lastH}=snapshots[snapshots.length-1];
  const ptSats=sampleIdx.map(i=>{
    const x=Math.round(lm[i].x*lastW),y=Math.round(lm[i].y*lastH);
    if(x<1||x>=lastW-1||y<1||y>=lastH-1) return null;
    let pr=0,pg=0,pb=0,pn=0;
    for(let dx=-1;dx<=1;dx++) for(let dy=-1;dy<=1;dy++){const d=lastCtx.getImageData(x+dx,y+dy,1,1).data;pr+=d[0];pg+=d[1];pb+=d[2];pn++;}
    return pn>0?rgbSat(pr/pn,pg/pn,pb/pn):null;
  }).filter(v=>v!==null);
  if(ptSats.length>2){const spread=Math.max(...ptSats)-Math.min(...ptSats);if(spread>0.20)return{passed:false,message:'Application uneven — some areas look bare or smudged. Blend more evenly right to the outline edges, then check again.'};}
  const recShade=STATE.shades?.[STATE.toneKey||'medium_warm']?.lips;
  const shadeHex=recShade?.hex;
  if(!shadeHex||shadeHex.length<7) return{passed:true,warning:false,message:'Lipstick applied and recognized! Great coverage.'};
  const sr=parseInt(shadeHex.slice(1,3),16),sg=parseInt(shadeHex.slice(3,5),16),sb=parseInt(shadeHex.slice(5,7),16);
  const recBr=sr*0.299+sg*0.587+sb*0.114;
  const shadeDist=Math.abs(r-sr)+Math.abs(g-sg)+Math.abs(b-sb);
  const brightDiff=br-recBr;
  if(shadeDist<=55) return{passed:true,warning:false,message:'Lipstick applied and recognized — shade matches your recommendation! Looks beautiful.'};
  let shadeMsg;
  if(brightDiff>35) shadeMsg='Too light — your lipstick is lighter than the recommended shade. Try a deeper application or a darker product.';
  else if(brightDiff<-35) shadeMsg='Too dark — your lipstick is darker than the recommended shade. Try a lighter application or a brighter product.';
  else shadeMsg="Wrong shade — the colour doesn't match the recommendation. Try the suggested shade for the best result.";
  return{passed:true,warning:true,message:shadeMsg};
}

// ─────────────────────────────────────────
//  ZONE COLOR ANALYSIS
// ─────────────────────────────────────────
function analyzeZoneColor(video, lm, step, sampleOverride) {
  try {
    const W=video.videoWidth||640, H=video.videoHeight||480;
    const tmp=document.createElement('canvas'); tmp.width=W; tmp.height=H;
    const tctx=tmp.getContext('2d'); tctx.drawImage(video,0,0,W,H);
    function sampleLandmarks(indices){
      let r=0,g=0,b=0,n=0;
      indices.forEach(i=>{const x=Math.round(lm[i].x*W),y=Math.round(lm[i].y*H);if(x>=1&&x<W-1&&y>=1&&y<H-1)for(let dx=-1;dx<=1;dx++)for(let dy=-1;dy<=1;dy++){const d=tctx.getImageData(x+dx,y+dy,1,1).data;r+=d[0];g+=d[1];b+=d[2];n++;}});
      return n>0?{r:r/n,g:g/n,b:b/n}:null;
    }
    const zone=sampleLandmarks(sampleOverride||SAMPLE_IDX[step]||[]);
    if (!zone) return{passed:true,message:goodMessages[step]};
    const {r,g,b}=zone;
    const br=r*.299+g*.587+b*.114;

    if (step==='lips'){
      const cheek=sampleLandmarks([50,280,205,425,36,266]);
      const ck=cheek??toneToRGB(STATE.toneKey||'medium_warm');
      const dev=Math.abs(r-ck.r)+Math.abs(g-ck.g)+Math.abs(b-ck.b);
      const satIncrease=rgbSat(r,g,b)-rgbSat(ck.r,ck.g,ck.b);
      const absoluteSat=rgbSat(r,g,b);
      const redShift=(r-g)-(ck.r-ck.g);
      const pinkShift=(r-b)-(ck.r-ck.b);
      const detected=br>20&&br<252&&absoluteSat>0.22&&dev>42&&satIncrease>0.09&&(redShift>20||pinkShift>22);
      if (!detected){
        let msg;
        if(absoluteSat<0.18) msg='No lipstick detected — lips look natural. Apply colour fully within the outline and hold still.';
        else if(dev<=42) msg='Colour too similar to your skin tone. Try the recommended shade for a clearer result.';
        else if(satIncrease<=0.09) msg='Application too sheer. Build up coverage within the outline and try again.';
        else msg='Lipstick not detected yet. Make sure the area is well-lit, fill within the outline, and hold still.';
        return{passed:false,message:msg};
      }
      const samplePts=sampleOverride||SAMPLE_IDX[step]||[];
      const ptSats=samplePts.map(i=>{const x=Math.round(lm[i].x*W),y=Math.round(lm[i].y*H);if(x<1||x>=W-1||y<1||y>=H-1)return null;let pr=0,pg=0,pb=0,pn=0;for(let dx=-1;dx<=1;dx++)for(let dy=-1;dy<=1;dy++){const d=tctx.getImageData(x+dx,y+dy,1,1).data;pr+=d[0];pg+=d[1];pb+=d[2];pn++;}return pn>0?rgbSat(pr/pn,pg/pn,pb/pn):null;}).filter(v=>v!==null);
      if(ptSats.length>2){const spread=Math.max(...ptSats)-Math.min(...ptSats);if(spread>0.20)return{passed:false,message:'Application uneven — some areas look bare or smudged. Blend more evenly right to the outline edges, then check again.'};}
      const recShade=STATE.shades?.[STATE.toneKey||'medium_warm']?.lips;
      const shadeHex=recShade?.hex;
      if(!shadeHex||shadeHex.length<7)return{passed:true,warning:false,message:'Lipstick applied and recognized! Great coverage.'};
      const sr=parseInt(shadeHex.slice(1,3),16),sg=parseInt(shadeHex.slice(3,5),16),sb=parseInt(shadeHex.slice(5,7),16);
      const recBr=sr*0.299+sg*0.587+sb*0.114;
      const shadeDist=Math.abs(r-sr)+Math.abs(g-sg)+Math.abs(b-sb);
      const brightDiff=br-recBr;
      if(shadeDist<=55)return{passed:true,warning:false,message:'Lipstick applied and recognized — shade matches your recommendation! Looks beautiful.'};
      let shadeMsg;
      if(brightDiff>35) shadeMsg='Too light — your lipstick is lighter than the recommended shade. Try a deeper application or a darker product.';
      else if(brightDiff<-35) shadeMsg='Too dark — your lipstick is darker than the recommended shade. Try a lighter application or a brighter product.';
      else shadeMsg="Wrong shade — the colour doesn't match the recommendation. Try the suggested shade for the best result.";
      return{passed:true,warning:true,message:shadeMsg};
    }

    if (step==='blush'){
      const skinRef=sampleLandmarks([10,9,151,107,336]);
      const sk=skinRef??toneToRGB(STATE.toneKey||'medium_warm');
      const dev=Math.abs(r-sk.r)+Math.abs(g-sk.g)+Math.abs(b-sk.b);
      const satIncrease=rgbSat(r,g,b)-rgbSat(sk.r,sk.g,sk.b);
      const pinkShift=(r-b)-(sk.r-sk.b);
      const warmShift=(r-g)-(sk.r-sk.g);
      const absSat=rgbSat(r,g,b);
      // All conditions must hold — guards against lighting variation and natural flush
      const detected=br>35&&br<235&&dev>42&&satIncrease>0.10&&absSat>0.30&&(pinkShift>26||warmShift>26);
      if (!detected){
        let msg;
       if(dev<=42||absSat<=0.30) msg='No blush detected — apply colour to the apples of your cheeks within the guide.';
        else if(satIncrease<=0.10) msg='Blush too sheer — build up a little more colour and blend within the outline.';
        else msg='Colour not reading as blush — try a pinker or rosier shade and blend upward along the guide.';
        return{passed:false,message:msg};
      }
      return{passed:true,message:goodMessages.blush};
    }

    if (step==='contour'){
      // Sample forehead as skin reference (not a hardcoded tone lookup)
      const skinRef=sampleLandmarks([10,9,151,107,336]);
      const sk=skinRef??toneToRGB(STATE.toneKey||'medium_warm');
      const skBr=sk.r*.299+sk.g*.587+sk.b*.114;
      const dev=Math.abs(r-sk.r)+Math.abs(g-sk.g)+Math.abs(b-sk.b);
      const darkShift=skBr-br; // contour must darken the zone relative to forehead
      const satIncrease=rgbSat(r,g,b)-rgbSat(sk.r,sk.g,sk.b);
      // Requires the zone to be noticeably darker (shadow product) AND more saturated (brown tone)
      const passed=br>20&&br<230&&dev>50&&darkShift>18&&satIncrease>0.06;
      return{passed,message:passed?goodMessages.contour:tipMessages.contour};
    }

    if (step==='eyebrows'){
      const skinRef=sampleLandmarks([10,9,151]);
      const sk=skinRef??toneToRGB(STATE.toneKey||'medium_warm');
      const skBr=sk.r*.299+sk.g*.587+sk.b*.114;
      const dev=Math.abs(r-sk.r)+Math.abs(g-sk.g)+Math.abs(b-sk.b);
      const darkShift=skBr-br; // eyebrows must darken the brow zone
      const passed=br>15&&br<230&&dev>48&&darkShift>22;
      return{passed,message:passed?goodMessages.eyebrows:tipMessages.eyebrows};
    }

    const sk=toneToRGB(STATE.toneKey||'medium_warm');
    const dev=Math.abs(r-sk.r)+Math.abs(g-sk.g)+Math.abs(b-sk.b);
    const passed=br>35&&br<235&&dev>48&&(rgbSat(r,g,b)-rgbSat(sk.r,sk.g,sk.b))>0.06;
    return{passed,message:passed?goodMessages[step]:tipMessages[step]};
  } catch(e){return{passed:true,message:goodMessages[step]};}
}

function rgbSat(r,g,b){const mx=Math.max(r,g,b)/255,mn=Math.min(r,g,b)/255;return mx===0?0:(mx-mn)/mx;}

function getBlushCoverage(video, lm) {
  try {
    const vW=video.videoWidth||640,vH=video.videoHeight||480;
    const tmp=document.createElement('canvas'); tmp.width=vW; tmp.height=vH;
    const tctx=tmp.getContext('2d'); tctx.drawImage(video,0,0,vW,vH);
    const pts=[123,352,116,345,50,280,205,425];
    let sat=0,n=0;
    pts.forEach(i=>{const x=Math.round(lm[i].x*vW),y=Math.round(lm[i].y*vH);if(x>=1&&x<vW-1&&y>=1&&y<vH-1){const d=tctx.getImageData(x,y,1,1).data;sat+=rgbSat(d[0],d[1],d[2]);n++;}});
    return Math.min(1,Math.max(0,(n>0?sat/n:0)-0.09)/0.15);
  } catch(e){return 0;}
}

function toneToRGB(k){return{light_warm:{r:225,g:192,b:167},light_cool:{r:218,g:190,b:180},medium_warm:{r:190,g:150,b:120},medium_cool:{r:178,g:152,b:144},dark_warm:{r:133,g:100,b:70},dark_cool:{r:122,g:98,b:93}}[k]||{r:185,g:148,b:122};}

const goodMessages={lips:'Great lip color! Your lips look well-defined and beautiful.',blush:'Beautiful blush placement! Your cheeks are glowing naturally.',eyebrows:'Your brows look well-defined and perfectly framed!',contour:'Great contour! Your cheekbones look beautifully sculpted.'};
const tipMessages={lips:'Lipstick not detected yet. Make sure the area is well-lit, fill within the outline, and hold still for a moment.',blush:'Apply a little more blush to the apples of your cheeks and blend upward.',eyebrows:'Fill in the brows more with short, upward strokes then check again.',contour:'Build up the contour a little more along the cheekbone hollow and blend the edges.'};

function showFeedback(passed, message) {
  const area=document.getElementById('feedback-area');
  area.style.display=''; area.className='feedback-area '+(passed?'good':'bad');
  document.getElementById('feedback-icon').textContent=passed?'✓':'✗';
  document.getElementById('feedback-msg').textContent=message;
  document.getElementById('btn-check').style.display='none';
  const skipBtn=document.getElementById('btn-skip'); if(skipBtn)skipBtn.style.display='none';
  if (passed){
    const retryBtn=document.getElementById('btn-retry');
    retryBtn.style.display='none'; retryBtn.textContent='Retry'; retryBtn.onclick=retryStep;
    const isLast=STATE.currentStep>=STEPS.length-1;
    const nextBtn=document.getElementById('btn-next');
    nextBtn.textContent=isLast?'See Final Summary →':'Next Step →';
    nextBtn.style.display=''; nextBtn.onclick=isLast?showSummary:nextStep;
  } else {
    const nextBtn=document.getElementById('btn-next');
    nextBtn.style.display='none'; nextBtn.textContent='Next Step →'; nextBtn.onclick=nextStep;
    const retryBtn=document.getElementById('btn-retry');
    retryBtn.textContent='Retry'; retryBtn.onclick=retryStep; retryBtn.style.display='';
  }
}

function nextStep()  { STATE.currentStep++; if(STATE.currentStep>=STEPS.length)showSummary(); else renderStep(STATE.currentStep); }
function retryStep() { renderStep(STATE.currentStep); }
function skipStep()  {
  const step=STEPS[STATE.currentStep];
  if(step==='lips') STATE.lipSubStep=0;
  STATE.stepResults.push({step,passed:false,message:'Skipped'});
  const skipBtn=document.getElementById('btn-skip'); if(skipBtn)skipBtn.style.display='none';
  STATE.currentStep++;
  if(STATE.currentStep>=STEPS.length)showSummary();
  else renderStep(STATE.currentStep);
}

// ─────────────────────────────────────────
//  SUMMARY
// ─────────────────────────────────────────
function showSummary() {
  stopStream();
  const tone=STATE.shades?.[STATE.toneKey||'medium_warm'];
  const grid=document.getElementById('summary-grid'); grid.innerHTML='';
  let pass=0;
  STATE.stepResults.forEach(r=>{
    if(r.passed)pass++;
    const shade=tone?.[r.step];
    const card=document.createElement('div'); card.className='summary-card';
    card.innerHTML=`<div class="summary-swatch" style="background:${shade?.hex||'#888'}"></div><div><div class="summary-step-name">${STEP_LABELS[r.step]}</div><div class="summary-result ${r.passed?'ok':'bad'}">${r.passed?'✓ Well done':'✗ Needs blending'}</div></div>`;
    grid.appendChild(card);
  });
  const t=STATE.stepResults.length;
  document.getElementById('summary-sub').textContent=`${pass} of ${t} steps looked great`;
  document.getElementById('summary-overall').textContent=pass===t?'Flawless finish! Your Soft and Natural look is complete.':pass>=t/2?'Great effort! A little more blending and it will be perfect.':'Keep practicing! The guide is here whenever you need it.';
  goTo('screen-summary');
}

// ─────────────────────────────────────────
//  UTILITIES
// ─────────────────────────────────────────
function hexToRgba(hex,a){if(!hex||hex.length<7)return`rgba(200,120,120,${a})`;return`rgba(${parseInt(hex.slice(1,3),16)},${parseInt(hex.slice(3,5),16)},${parseInt(hex.slice(5,7),16)},${a})`;}

document.addEventListener('DOMContentLoaded',()=>{loadData();initParticles();});

// ─────────────────────────────────────────
//  VIRTUAL TRY-ON
// ─────────────────────────────────────────
let _toMesh=null, _toStream=null, _toRaf=null, _toLastLm=null, _toStepOnly=null;

// Pre-warms FaceMesh so the wasm model downloads while the user reads
// the shades screen — eliminates lag on first TRY IT ON tap.
function prewarmTryOnMesh() {
  if (_toMesh) return;
  _toMesh=new FaceMesh({locateFile:f=>`https://cdn.jsdelivr.net/npm/@mediapipe/face_mesh/${f}`});
  _toMesh.setOptions({maxNumFaces:1,refineLandmarks:true,minDetectionConfidence:.6,minTrackingConfidence:.6});
  _toMesh.onResults(onTryOnResults);
  try {
    const b=document.createElement('canvas'); b.width=1; b.height=1;
    _toMesh.send({image:b}).catch(()=>{});
  } catch(e){}
}

function startStepTryOn() {
  // Tear down any running try-on session
  if(_toRaf)   { cancelAnimationFrame(_toRaf); _toRaf=null; }
  if(_toMesh)  { try{_toMesh.close();}catch(e){} _toMesh=null; }
  if(_toStream){ _toStream.getTracks().forEach(t=>t.stop()); _toStream=null; }
  const _tv=document.getElementById('tryon-video');
  if(_tv) _tv.srcObject=null;
  _toLastLm=null;
  const _tl=document.getElementById('tryon-loading');
  if(_tl) _tl.style.display='flex';

  // Set the step-only filter BEFORE startTryOn creates the render loop
  const step  = STEPS[STATE.currentStep];
  _toStepOnly = step;

  const label     = STEP_LABELS[step] || step;
  const titleEl   = document.getElementById('tryon-modal-title');
  const captionEl = document.getElementById('tryon-modal-caption');
  if(titleEl)   titleEl.textContent   = `✦ ${label} Preview`;
  if(captionEl) captionEl.textContent = `${label.toUpperCase()} PREVIEW  ·  YOUR RECOMMENDED SHADE`;
  startTryOn();
}

function startTryOn() {
  const modal=document.getElementById('tryon-modal');
  modal.style.display='flex';
  const video=document.getElementById('tryon-video');
  const loading=document.getElementById('tryon-loading');
  if(_toStream) return; // already live

  // Reuse pre-warmed mesh if available (no lag); create fresh if not
  if(!_toMesh){
    _toMesh=new FaceMesh({locateFile:f=>`https://cdn.jsdelivr.net/npm/@mediapipe/face_mesh/${f}`});
    _toMesh.setOptions({maxNumFaces:1,refineLandmarks:true,minDetectionConfidence:.6,minTrackingConfidence:.6});
    _toMesh.onResults(onTryOnResults);
  }

  navigator.mediaDevices.getUserMedia({video:{width:{ideal:640},height:{ideal:480},facingMode:'user'}})
  .then(stream=>{
    _toStream=stream;
    video.srcObject=stream;
    return video.play();
  })
  .then(()=>{
    if(loading) loading.style.display='none';
    const canvas=document.getElementById('tryon-canvas');
    let sending=false, fc=0;
    function loop(){
      if(!_toStream||!_toMesh){ _toRaf=null; return; }
      _toRaf=requestAnimationFrame(loop);
      if(!canvas||!video.videoWidth||video.readyState<2) return;
      const vW=video.videoWidth, vH=video.videoHeight;
      if(canvas.width!==vW) canvas.width=vW;
      if(canvas.height!==vH) canvas.height=vH;
      const ctx=canvas.getContext('2d');
      ctx.drawImage(video,0,0,vW,vH);
      if(_toLastLm) drawVirtualMakeup(ctx,_toLastLm,vW,vH);
      if(!sending && fc++%3===0){
        sending=true;
        _toMesh.send({image:video}).finally(()=>{ sending=false; });
      }
    }
    loop();
  })
  .catch(e=>{ console.error('Try-on camera error:',e); if(loading) loading.textContent='Camera unavailable'; });
}

function stopTryOn() {
  document.getElementById('tryon-modal').style.display='none';
  if(_toRaf){cancelAnimationFrame(_toRaf); _toRaf=null;}
  if(_toMesh){try{_toMesh.close();}catch(e){} _toMesh=null;}
  if(_toStream){_toStream.getTracks().forEach(t=>t.stop()); _toStream=null;}
  const video=document.getElementById('tryon-video');
  if(video) video.srcObject=null;
  _toLastLm=null;
  _toStepOnly=null;
  const titleEl   = document.getElementById('tryon-modal-title');
  const captionEl = document.getElementById('tryon-modal-caption');
  if(titleEl)   titleEl.textContent   = '✦ Try It On';
  if(captionEl) captionEl.innerHTML   = 'VIRTUAL TRY-ON &nbsp;·&nbsp; YOUR RECOMMENDED SHADES';
  const loading=document.getElementById('tryon-loading');
  if(loading) loading.style.display='flex';
}

function onTryOnResults(results) {
  _toLastLm=results.multiFaceLandmarks?.[0]||null;
}

// ─────────────────────────────────────────
//  VIRTUAL MAKEUP RENDERER
//  Render order (back→front): contour →
//  blush → eyebrows → lips
// ─────────────────────────────────────────
function drawVirtualMakeup(ctx, lm, W, H) {
  const tone=STATE.shades?.[STATE.toneKey||'medium_warm'];
  if(!tone) return;

  function rgb(hex){
    if(!hex||hex.length<7) return {r:200,g:120,b:120};
    return {r:parseInt(hex.slice(1,3),16),g:parseInt(hex.slice(3,5),16),b:parseInt(hex.slice(5,7),16)};
  }

  const FOCAL_MULT = {
    lips:     { lips:1.00, blush:0.38, eyebrows:0.50, contour:0.55 },
    eyebrows: { lips:0.38, blush:0.32, eyebrows:1.00, contour:0.60 },
    cheeks:   { lips:0.38, blush:1.00, eyebrows:0.50, contour:0.55 },
    contour:  { lips:0.38, blush:0.32, eyebrows:0.50, contour:1.00 },
  };
  const focalMult = FOCAL_MULT[STATE.focal] || FOCAL_MULT.lips;
  const mult = _toStepOnly
    ? { lips:0, blush:0, eyebrows:0, contour:0, [_toStepOnly]: focalMult[_toStepOnly] }
    : focalMult;

  const faceW=Math.abs(lm[234].x-lm[454].x)*W;
  const faceH=Math.abs(lm[10].y -lm[152].y)*H;
  const faceRef=Math.max(faceW,faceH*0.80);
  const nosePx=lm[1].x*W, nosePy=lm[1].y*H;

  // ── Contour: cheek hollows + jaw sides + nose sides ──────────
  // Uses pure radial-gradient blobs (no ctx.filter — reliable cross-browser).
  if(tone.contour?.hex && mult.contour>0.05){
    const {r,g,b}=rgb(tone.contour.hex);
    const a=mult.contour;
    ctx.save();
    ctx.globalCompositeOperation='source-over';

    // Zone 1 — Cheek hollows: soft circular gradient blobs
    [234,454].forEach(temple=>{
      const tx=lm[temple].x*W, ty=lm[temple].y*H;
      const cx=nosePx+0.58*(tx-nosePx);
      const cy=nosePy+0.60*(ty-nosePy)+faceRef*0.04;
      const gradR=faceRef*0.28;
      const grad=ctx.createRadialGradient(cx,cy,0, cx,cy,gradR);
      grad.addColorStop(0,    `rgba(${r},${g},${b},${(0.80*a).toFixed(3)})`);
      grad.addColorStop(0.28, `rgba(${r},${g},${b},${(0.62*a).toFixed(3)})`);
      grad.addColorStop(0.55, `rgba(${r},${g},${b},${(0.30*a).toFixed(3)})`);
      grad.addColorStop(0.82, `rgba(${r},${g},${b},${(0.08*a).toFixed(3)})`);
      grad.addColorStop(1,    `rgba(${r},${g},${b},0)`);
      ctx.fillStyle=grad;
      ctx.beginPath(); ctx.arc(cx,cy,gradR,0,Math.PI*2); ctx.fill();
    });

    // Zone 2 — Jaw sides: diffuse oval blobs
    [[58,172,136,150,149],[288,397,365,379,378]].forEach(idxArr=>{
      const pts=idxArr.map(i=>({x:lm[i].x*W,y:lm[i].y*H}));
      const cx=pts.reduce((s,p)=>s+p.x,0)/pts.length;
      const cy=pts.reduce((s,p)=>s+p.y,0)/pts.length;
      const gradR=faceW*0.17;
      const grad=ctx.createRadialGradient(cx,cy,0, cx,cy,gradR);
      grad.addColorStop(0,    `rgba(${r},${g},${b},${(0.38*a).toFixed(3)})`);
      grad.addColorStop(0.50, `rgba(${r},${g},${b},${(0.18*a).toFixed(3)})`);
      grad.addColorStop(0.80, `rgba(${r},${g},${b},${(0.05*a).toFixed(3)})`);
      grad.addColorStop(1,    `rgba(${r},${g},${b},0)`);
      ctx.fillStyle=grad;
      ctx.beginPath(); ctx.ellipse(cx,cy,faceW*0.15,faceRef*0.075,0,0,Math.PI*2); ctx.fill();
    });

    // Zone 3 — Nose sides: slim shadow strips
    ctx.filter='blur(6px)';
    ctx.globalAlpha=0.45*a;
    ctx.fillStyle=`rgb(${r},${g},${b})`;
    const bridgePt={x:lm[6].x*W, y:lm[6].y*H};
    const tipPt   ={x:lm[4].x*W, y:lm[4].y*H};
    const alarL   ={x:lm[49].x*W,y:lm[49].y*H};
    const alarR   ={x:lm[279].x*W,y:lm[279].y*H};
    const nW=Math.abs(alarR.x-alarL.x);
    const nH=Math.abs(tipPt.y-bridgePt.y);
    const midY=(bridgePt.y+tipPt.y)/2;
    [{cx:alarL.x-nW*0.07,cy:midY},{cx:alarR.x+nW*0.07,cy:midY}].forEach(({cx,cy})=>{
      const grad=ctx.createRadialGradient(cx,cy,0, cx,cy,nW*0.14);
      grad.addColorStop(0,    `rgba(${r},${g},${b},${(0.46*a).toFixed(3)})`);
      grad.addColorStop(0.55, `rgba(${r},${g},${b},${(0.18*a).toFixed(3)})`);
      grad.addColorStop(1,    `rgba(${r},${g},${b},0)`);
      ctx.fillStyle=grad;
      ctx.beginPath(); ctx.ellipse(cx,cy,nW*0.11,nH*0.52,0,0,Math.PI*2); ctx.fill();
    });

    ctx.restore();
  }

  // ── Blush: tilted ellipse along the cheekbone ─────────────────
  if(tone.blush?.hex && mult.blush>0.05){
    const {r,g,b}=rgb(tone.blush.hex);
    const baseAlpha=mult.blush;
    ctx.save();
    ctx.globalCompositeOperation='source-over';
    [234,454].forEach(temple=>{
      const tx=lm[temple].x*W, ty=lm[temple].y*H;
      const angle=Math.atan2(ty-nosePy, tx-nosePx);
      const cx=nosePx+0.62*(tx-nosePx);
      const cy=nosePy+0.62*(ty-nosePy)+faceRef*0.04;
      const rMaj=faceRef*0.26;
      const rMin=faceRef*0.15;
      ctx.save();
      ctx.translate(cx,cy); ctx.rotate(angle);
      const grad=ctx.createRadialGradient(0,0,0, 0,0,rMaj);
      grad.addColorStop(0,   `rgba(${r},${g},${b},${(0.52*baseAlpha).toFixed(3)})`);
      grad.addColorStop(0.5, `rgba(${r},${g},${b},${(0.26*baseAlpha).toFixed(3)})`);
      grad.addColorStop(1,   `rgba(${r},${g},${b},0)`);
      ctx.fillStyle=grad;
      ctx.scale(1, rMin/rMaj);
      ctx.beginPath(); ctx.arc(0,0,rMaj,0,Math.PI*2); ctx.fill();
      ctx.restore();
    });
    ctx.restore();
  }

  // ── Eyebrows: multiply fill — darkens existing hair naturally ──
  if(tone.eyebrows?.hex && mult.eyebrows>0.05){
    const {r,g,b}=rgb(tone.eyebrows.hex);
    ctx.save();
    ctx.globalCompositeOperation='multiply';
    ctx.filter='blur(1.6px)';
    ctx.globalAlpha=0.88*mult.eyebrows;
    ctx.fillStyle=`rgb(${r},${g},${b})`;
    [[BROW_LEFT_TOP,BROW_LEFT_BOTTOM],[BROW_RIGHT_TOP,BROW_RIGHT_BOTTOM]].forEach(([top,bot])=>{
      ctx.beginPath();
      ctx.moveTo(lm[top[0]].x*W,lm[top[0]].y*H);
      top.slice(1).forEach(i=>ctx.lineTo(lm[i].x*W,lm[i].y*H));
      [...bot].reverse().forEach(i=>ctx.lineTo(lm[i].x*W,lm[i].y*H));
      ctx.closePath(); ctx.fill();
    });
    ctx.restore();
  }

  // ── Lips: full outer shape with inner punch-out ────────────────
  if(tone.lips?.hex && mult.lips>0.05){
    const {r,g,b}=rgb(tone.lips.hex);
    const lc=document.createElement('canvas'); lc.width=W; lc.height=H;
    const lx=lc.getContext('2d');
    lx.filter='blur(1.2px)';
    lx.fillStyle=`rgb(${r},${g},${b})`;
    const outerPts=lmPts(lm,LIP_OUTER_LOOP,W,H);
    lx.beginPath(); softPolyPath(lx,outerPts); lx.fill();
    lx.globalCompositeOperation='destination-out';
    lx.filter='blur(0.8px)';
    const innerPts=lmPts(lm,LIP_INNER,W,H);
    lx.beginPath(); softPolyPath(lx,innerPts); lx.fill();
    lx.globalCompositeOperation='source-over';
    lx.filter='blur(2.5px)';
    lx.globalAlpha=0.20;
    lx.fillStyle='rgba(255,255,255,1)';
    const shinePts=lmPts(lm,[37,0,267,82,13,312],W,H);
    lx.beginPath(); softPolyPath(lx,shinePts); lx.fill();
    ctx.save();
    ctx.globalCompositeOperation='multiply';
    ctx.globalAlpha=0.90*mult.lips;
    ctx.drawImage(lc,0,0);
    ctx.restore();
  }
}