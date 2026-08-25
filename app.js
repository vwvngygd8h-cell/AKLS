(() => {
'use strict';

const $=id=>document.getElementById(id);
const els={
  video:$('video'),canvas:$('captureCanvas'),detectorCanvas:$('detectorCanvas'),stage:$('cameraStage'),
  overlay:$('plateOverlay'),placeholder:$('placeholder'),start:$('startBtn'),stop:$('stopBtn'),
  targets:$('targetPlates'),targetCount:$('targetCount'),activeTargets:$('activeTargets'),
  tolerant:$('tolerantMode'),wake:$('wakeLockToggle'),interval:$('scanInterval'),roi:$('roiMode'),
  confidence:$('ocrConfidence'),status:$('statusPill'),primary:$('scanPrimaryStatus'),
  lastOcr:$('lastOcr'),closest:$('closestTarget'),similarity:$('similarity'),ocrTime:$('ocrTime'),
  scanCount:$('scanCount'),hitCount:$('hitCount'),confirmCount:$('confirmCount'),
  banner:$('alertBanner'),bannerType:$('alertType'),bannerText:$('alertText'),
  log:$('hitLog'),clearLog:$('clearLogBtn'),testAlarm:$('testAlarmBtn'),error:$('errorBox'),
  setupView:$('setupView'),scanView:$('scanView'),logView:$('logView'),
  zoom:$('zoomSlider'),zoomValue:$('zoomValue'),zoomSupport:$('zoomSupport'),
  autoFocus:$('autoFocusBtn'),focusStatus:$('focusStatus'),
  manualFocusGroup:$('manualFocusGroup'),focus:$('focusSlider'),focusValue:$('focusValue')
};

const APP_VERSION='9.4.1';
const MODEL_URL='https://raw.githubusercontent.com/MikeLud/Blue-Iris-Custom-AI-Models/main/Custom-YOLOv8-11/plates.onnx';
const MODEL_SIZE=640;
const DETECT_CONF=.80;
const NMS_IOU=.70;
const DETECT_EVERY_MS=280;
const TRACK_TTL=850;
const YELLOW_CONFIRMATIONS=3;
const MAX_VISIBLE_PLATES=2;
const GREEN_CONFIRMATIONS=2;
const RED_CONFIRMATIONS=2;
const LOG_KEY='akls-v94-log';
const TARGET_KEY='plateTargetsV94';

let stream=null,cameraTrack=null,ocrWorker=null,detectorSession=null;
let running=false,detectBusy=false,ocrBusy=false,detectTimer=null,wakeLock=null,audioCtx=null;
let scans=0,hits=0,lastHitAt=0,pendingReload=false,nextTrackId=1,tracks=[],capabilities={};

const normalize=s=>(s||'').toUpperCase().replace(/Ä/g,'A').replace(/Ö/g,'O').replace(/Ü/g,'U').replace(/[^A-Z0-9]/g,'');
const pretty=s=>String(s||'').trim().toUpperCase().replace(/\s+/g,' ').replace(/\s*-\s*/g,'-');
const clamp=(n,a,b)=>Math.min(b,Math.max(a,n));

function targets(){
  const seen=new Set();
  return (els.targets.value||'').split(/\n|,|;/).map(v=>v.trim()).filter(Boolean)
    .map(raw=>({raw:pretty(raw),norm:normalize(raw)}))
    .filter(x=>x.norm.length>=3&&!seen.has(x.norm)&&seen.add(x.norm));
}
function updateTargetCount(){
  const n=targets().length;
  els.targetCount.textContent=`${n} Zielkennzeichen`;
  els.activeTargets.textContent=String(n);
  localStorage.setItem(TARGET_KEY,els.targets.value);
}
function setStatus(text,kind='idle'){
  els.status.textContent=text;
  els.status.className=`status-pill ${kind}`;
  els.primary.textContent=text;
}
function showError(msg=''){els.error.hidden=!msg;els.error.textContent=msg;}
function showView(id){
  [els.setupView,els.scanView,els.logView].forEach(v=>{v.hidden=v.id!==id;v.classList.toggle('active-view',v.id===id)});
  document.querySelectorAll('.tab-button').forEach(b=>b.classList.toggle('active',b.dataset.view===id));
  if(id==='logView')renderLog();
  window.scrollTo({top:0,behavior:'auto'});
}

const CONFUSIONS={'0':['O','Q','D'],'O':['0','Q'],'1':['I','L'],'I':['1','L'],'L':['1','I'],'2':['Z'],'Z':['2'],'5':['S'],'S':['5'],'6':['G'],'G':['6'],'8':['B'],'B':['8']};
function confusionCost(a,b){if(a===b)return 0;if(CONFUSIONS[a]?.includes(b)||CONFUSIONS[b]?.includes(a))return .35;return 1}
function weightedDistance(a,b){
  const d=Array.from({length:a.length+1},()=>new Float32Array(b.length+1));
  for(let i=0;i<=a.length;i++)d[i][0]=i;
  for(let j=0;j<=b.length;j++)d[0][j]=j;
  for(let i=1;i<=a.length;i++)for(let j=1;j<=b.length;j++)
    d[i][j]=Math.min(d[i-1][j]+1,d[i][j-1]+1,d[i-1][j-1]+confusionCost(a[i-1],b[j-1]));
  return d[a.length][b.length];
}
function bestTargetMatch(value){
  const v=normalize(value);let best=null;
  for(const t of targets()){
    const candidates=new Set([v]);
    if(v.length>=t.norm.length)for(let i=0;i<=v.length-t.norm.length;i++)candidates.add(v.slice(i,i+t.norm.length));
    for(const c of candidates){
      const distance=weightedDistance(c,t.norm);
      const similarity=Math.round(Math.max(0,1-distance/Math.max(c.length,t.norm.length,1))*100);
      if(!best||distance<best.distance||(distance===best.distance&&similarity>best.similarity))
        best={target:t,value:c,distance,similarity};
    }
  }
  return best;
}
function germanPlatePlausibility(s){
  const n=normalize(s);if(n.length<4||n.length>10)return 0;
  let score=0;
  if(/[A-Z]/.test(n)&&/\d/.test(n))score+=20;
  if(/^[A-Z]{2,5}\d{1,4}[EH]?$/.test(n))score+=35;
  if(/^[A-Z]{1,3}[A-Z]{1,2}\d{1,4}[EH]?$/.test(n))score+=15;
  return score;
}

function visibleSourceRect(){
  const vw=els.video.videoWidth,vh=els.video.videoHeight,sw=els.stage.clientWidth,sh=els.stage.clientHeight;
  if(!vw||!vh||!sw||!sh)return null;
  const sar=vw/vh,tar=sw/sh;
  if(sar>tar){const w=vh*tar;return{x:(vw-w)/2,y:0,w,h:vh,vw,vh}}
  const h=vw/tar;return{x:0,y:(vh-h)/2,w:vw,h,vw,vh}
}
function roiFractions(){
  switch(els.roi.value){
    case'wide':return{x:.01,y:.15,w:.98,h:.70};
    case'full':return{x:0,y:0,w:1,h:1};
    default:return{x:.03,y:.20,w:.94,h:.60};
  }
}
function detectorCrop(){
  const v=visibleSourceRect();if(!v)return null;
  const r=roiFractions();
  return{x:v.x+v.w*r.x,y:v.y+v.h*r.y,w:v.w*r.w,h:v.h*r.h};
}

function letterboxToTensor(crop){
  const c=els.detectorCanvas,ctx=c.getContext('2d',{willReadFrequently:true});
  ctx.clearRect(0,0,MODEL_SIZE,MODEL_SIZE);
  ctx.fillStyle='rgb(114,114,114)';ctx.fillRect(0,0,MODEL_SIZE,MODEL_SIZE);
  const scale=Math.min(MODEL_SIZE/crop.w,MODEL_SIZE/crop.h);
  const dw=crop.w*scale,dh=crop.h*scale;
  const padX=(MODEL_SIZE-dw)/2,padY=(MODEL_SIZE-dh)/2;
  ctx.drawImage(els.video,crop.x,crop.y,crop.w,crop.h,padX,padY,dw,dh);
  const rgba=ctx.getImageData(0,0,MODEL_SIZE,MODEL_SIZE).data;
  const plane=MODEL_SIZE*MODEL_SIZE;
  const data=new Float32Array(3*plane);
  for(let i=0,p=0;i<rgba.length;i+=4,p++){
    data[p]=rgba[i]/255;
    data[plane+p]=rgba[i+1]/255;
    data[2*plane+p]=rgba[i+2]/255;
  }
  return{tensor:new ort.Tensor('float32',data,[1,3,MODEL_SIZE,MODEL_SIZE]),scale,padX,padY,crop};
}
function sigmoid(x){return 1/(1+Math.exp(-x))}
function parseYolo(output,prep){
  const dims=output.dims,data=output.data;
  let count,attrs,transpose=false;
  if(dims.length===3&&dims[1]<=10){attrs=dims[1];count=dims[2];transpose=true}
  else if(dims.length===3){count=dims[1];attrs=dims[2]}
  else return[];
  if(attrs<5)return[];

  const read=(i,a)=>transpose?data[a*count+i]:data[i*attrs+a];
  const dets=[];
  for(let i=0;i<count;i++){
    const cx=read(i,0),cy=read(i,1),w=read(i,2),h=read(i,3);
    let conf=read(i,4);
    if(conf<0||conf>1)conf=sigmoid(conf);
    if(conf<DETECT_CONF)continue;
    const x1=(cx-w/2-prep.padX)/prep.scale;
    const y1=(cy-h/2-prep.padY)/prep.scale;
    const bw=w/prep.scale,bh=h/prep.scale;
    if(bw<20||bh<7)continue;

    const ratio=bw/Math.max(1,bh);
    const areaRatio=(bw*bh)/(prep.crop.w*prep.crop.h);

    // Standard-Kennzeichen sind horizontal und nehmen im normalen
    // Frontscheibenbild nur einen kleinen Teil der ROI ein.
    if(ratio<1.8||ratio>7.5)continue;
    if(areaRatio<0.00012||areaRatio>0.10)continue;
    if(bw>prep.crop.w*.72||bh>prep.crop.h*.30)continue;

    dets.push({
      x:clamp(prep.crop.x+x1,prep.crop.x,prep.crop.x+prep.crop.w-1),
      y:clamp(prep.crop.y+y1,prep.crop.y,prep.crop.y+prep.crop.h-1),
      w:clamp(bw,1,prep.crop.w),
      h:clamp(bh,1,prep.crop.h),
      conf
    });
  }
  dets.sort((a,b)=>b.conf-a.conf);
  const keep=[];
  for(const d of dets){
    if(keep.some(k=>iou(k,d)>NMS_IOU))continue;
    keep.push(d);
    if(keep.length>=MAX_VISIBLE_PLATES)break;
  }
  return keep;
}
function iou(a,b){
  const x1=Math.max(a.x,b.x),y1=Math.max(a.y,b.y),x2=Math.min(a.x+a.w,b.x+b.w),y2=Math.min(a.y+a.h,b.y+b.h);
  const inter=Math.max(0,x2-x1)*Math.max(0,y2-y1),union=a.w*a.h+b.w*b.h-inter;
  return union?inter/union:0;
}
function smooth(a,b){
  return{x:a.x*.35+b.x*.65,y:a.y*.35+b.y*.65,w:a.w*.35+b.w*.65,h:a.h*.35+b.h*.65}
}
function updateTracks(dets){
  const now=Date.now(),unmatched=new Set(dets.map((_,i)=>i));
  for(const t of tracks){
    let bi=-1,bs=0;
    dets.forEach((d,i)=>{if(!unmatched.has(i))return;const s=iou(t.box,d);if(s>bs){bs=s;bi=i}});
    if(bi>=0&&bs>.18){
      const d=dets[bi];
      t.box=smooth(t.box,d);
      t.conf=d.conf;
      t.lastSeen=now;
      t.confirmations=Math.min(10,(t.confirmations||1)+1);
      t.misses=0;
      unmatched.delete(bi);
    }else{
      t.misses=(t.misses||0)+1;
    }
  }

  for(const i of unmatched){
    const d=dets[i];
    tracks.push({
      id:nextTrackId++,box:{...d},conf:d.conf,lastSeen:now,
      state:'pending',label:'Kennzeichen erkannt',history:[],lastOcrAt:0,
      greenUntil:0,redUntil:0,confirmations:1,misses:0
    });
  }

  tracks=tracks.filter(t=>now-t.lastSeen<TRACK_TTL && (t.misses||0)<3);
  tracks.sort((a,b)=>(b.confirmations||0)-(a.confirmations||0)||b.conf-a.conf);
  if(tracks.length>MAX_VISIBLE_PLATES)tracks=tracks.slice(0,MAX_VISIBLE_PLATES);
  renderTracks();
}
function sourceToStage(b){
  const v=visibleSourceRect();if(!v)return null;
  const sw=els.stage.clientWidth,sh=els.stage.clientHeight;
  return{left:(b.x-v.x)/v.w*sw,top:(b.y-v.y)/v.h*sh,width:b.w/v.w*sw,height:b.h/v.h*sh}
}
function renderTracks(){
  const now=Date.now();
  tracks=tracks.filter(t=>now-t.lastSeen<TRACK_TTL);
  const ids=new Set(tracks.map(t=>String(t.id)));
  [...els.overlay.querySelectorAll('.plate-box')].forEach(d=>{if(!ids.has(d.dataset.id))d.remove()});
  for(const t of tracks){
    if(t.redUntil>now)t.state='red';
    else if(t.greenUntil>now)t.state='green';
    else if((t.confirmations||0)>=YELLOW_CONFIRMATIONS)t.state='yellow';
    else t.state='pending';

    if(t.state==='pending')continue;
    const p=sourceToStage(t.box);if(!p)continue;
    let d=els.overlay.querySelector(`.plate-box[data-id="${t.id}"]`);
    if(!d){d=document.createElement('div');d.dataset.id=String(t.id);d.innerHTML='<span class="plate-label"></span>';els.overlay.appendChild(d)}
    d.className=`plate-box ${t.state}`;
    d.style.left=`${clamp(p.left,0,els.stage.clientWidth-4)}px`;d.style.top=`${clamp(p.top,0,els.stage.clientHeight-4)}px`;
    d.style.width=`${clamp(p.width,24,els.stage.clientWidth)}px`;d.style.height=`${clamp(p.height,10,els.stage.clientHeight)}px`;
    d.querySelector('.plate-label').textContent=t.label||(t.state==='yellow'?'Kennzeichen erkannt':'');
  }
}

async function initDetector(){
  if(detectorSession)return;
  if(!window.ort)throw new Error('Kennzeichen-KI konnte nicht geladen werden.');
  setStatus('Kennzeichen-KI lädt …','busy');
  ort.env.wasm.numThreads=1;
  ort.env.wasm.simd=true;
  ort.env.wasm.wasmPaths='https://cdn.jsdelivr.net/npm/onnxruntime-web@1.20.1/dist/';
  detectorSession=await ort.InferenceSession.create(MODEL_URL,{executionProviders:['wasm'],graphOptimizationLevel:'all'});
}
async function initOcr(){
  if(ocrWorker)return;
  if(!window.Tesseract)throw new Error('OCR konnte nicht geladen werden.');
  setStatus('OCR lädt …','busy');
  ocrWorker=await Tesseract.createWorker('eng',1,{logger:m=>{
    if(m.status==='recognizing text'&&typeof m.progress==='number')setStatus(`OCR ${Math.round(m.progress*100)} %`,'busy')
  }});
  await ocrWorker.setParameters({tessedit_char_whitelist:'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789',tessedit_pageseg_mode:'7',preserve_interword_spaces:'0'});
}
async function detectOnce(){
  if(!running||detectBusy)return;
  detectBusy=true;
  try{
    const crop=detectorCrop();if(!crop)return;
    const prep=letterboxToTensor(crop);
    const inputName=detectorSession.inputNames[0];
    const out=await detectorSession.run({[inputName]:prep.tensor});
    const output=out[detectorSession.outputNames[0]];
    updateTracks(parseYolo(output,prep));
    scheduleOcr();
  }catch(e){
    console.warn('detector',e);
  }finally{
    detectBusy=false;
    if(running)detectTimer=setTimeout(detectOnce,DETECT_EVERY_MS);
  }
}

function plateCrop(track){
  const b=track.box,vw=els.video.videoWidth,vh=els.video.videoHeight;
  const px=b.w*.10,py=b.h*.30;
  const x=clamp(b.x-px,0,vw-1),y=clamp(b.y-py,0,vh-1),w=clamp(b.w+2*px,1,vw-x),h=clamp(b.h+2*py,1,vh-y);
  const scale=Math.min(3,1000/w);
  els.canvas.width=Math.max(1,Math.round(w*scale));els.canvas.height=Math.max(1,Math.round(h*scale));
  const ctx=els.canvas.getContext('2d',{willReadFrequently:true});
  ctx.filter='grayscale(1) contrast(1.65) brightness(1.08)';
  ctx.drawImage(els.video,x,y,w,h,0,0,els.canvas.width,els.canvas.height);ctx.filter='none';
  return els.canvas;
}
function consensus(t){
  const now=Date.now();t.history=t.history.filter(x=>now-x.time<2800).slice(-6);
  const groups=[];
  for(const h of t.history){
    let g=groups.find(x=>weightedDistance(x.text,h.text)<=.45);
    if(!g){g={text:h.text,count:0,conf:0};groups.push(g)}
    g.count++;g.conf+=h.conf;
  }
  groups.sort((a,b)=>b.count-a.count||b.conf-a.conf);
  return groups[0]||null;
}
function targetVote(t){
  const votes=new Map();
  for(const h of t.history.slice(-4)){
    const bm=bestTargetMatch(h.text);if(!bm)continue;
    const allowed=els.tolerant.checked?1.05:.40;
    if(bm.distance<=allowed){
      const e=votes.get(bm.target.norm)||{target:bm.target,count:0,similarity:0};
      e.count++;e.similarity=Math.max(e.similarity,bm.similarity);votes.set(bm.target.norm,e);
    }
  }
  return[...votes.values()].sort((a,b)=>b.count-a.count||b.similarity-a.similarity)[0]||null;
}
async function scheduleOcr(){
  if(!running||ocrBusy)return;
  const now=Date.now();
  const live=tracks.filter(t=>now-t.lastSeen<650 && (t.confirmations||0)>=YELLOW_CONFIRMATIONS).sort((a,b)=>(now-b.lastOcrAt)-(now-a.lastOcrAt)||b.conf-a.conf);
  const t=live[0];if(!t)return;
  ocrBusy=true;t.lastOcrAt=now;
  const started=performance.now();
  try{
    const result=await ocrWorker.recognize(plateCrop(t));
    scans++;els.scanCount.textContent=String(scans);els.ocrTime.textContent=`${Math.round(performance.now()-started)} ms`;
    const text=normalize(result.data.text),conf=Number(result.data.confidence)||0;
    if(text.length>=4&&text.length<=10&&conf>=Math.max(20,Number(els.confidence.value)-20)&&germanPlatePlausibility(text)>=20){
      t.history.push({text,conf,time:Date.now()});
      const c=consensus(t);
      if(c){
        els.lastOcr.textContent=c.text;els.confirmCount.textContent=String(c.count);
        const bm=bestTargetMatch(c.text);els.closest.textContent=bm?bm.target.raw:'—';els.similarity.textContent=bm?`${bm.similarity} %`:'—';
        if(c.count>=GREEN_CONFIRMATIONS){t.greenUntil=Date.now()+1800;t.label=c.text}
        const vote=targetVote(t);
        if(vote&&vote.count>=RED_CONFIRMATIONS){
          t.redUntil=Date.now()+3200;t.label=vote.target.raw;showBanner(vote.target.raw);setStatus('TREFFER','hit');
          const n=Date.now();if(n-lastHitAt>4500){lastHitAt=n;hits++;els.hitCount.textContent=String(hits);addLog('hit',vote.target.raw,`${vote.count}× bestätigt`);await alarm()}
        }else setStatus('Scan aktiv','active');
      }
    }else{els.confirmCount.textContent='0';setStatus('Scan aktiv','active')}
    renderTracks();
  }catch(e){console.warn('ocr',e)}
  finally{ocrBusy=false}
}

async function ensureAudio(){if(!audioCtx)audioCtx=new(window.AudioContext||window.webkitAudioContext)();if(audioCtx.state==='suspended')await audioCtx.resume()}
async function alarm(){
  await ensureAudio();const now=audioCtx.currentTime;
  [0,.34,.68].forEach(o=>{const osc=audioCtx.createOscillator(),g=audioCtx.createGain();osc.type='square';osc.frequency.value=1050;g.gain.setValueAtTime(.0001,now+o);g.gain.exponentialRampToValueAtTime(.45,now+o+.015);g.gain.exponentialRampToValueAtTime(.0001,now+o+.22);osc.connect(g).connect(audioCtx.destination);osc.start(now+o);osc.stop(now+o+.25)});
  if(navigator.vibrate)navigator.vibrate([220,100,220,100,450])
}
function showBanner(plate){
  els.banner.hidden=false;els.bannerType.textContent='TREFFER!';els.bannerText.textContent=plate;
  clearTimeout(showBanner.t);showBanner.t=setTimeout(()=>{els.banner.hidden=true;if(running)setStatus('Scan aktiv','active')},3200)
}
async function requestWake(){if(!els.wake.checked||!navigator.wakeLock)return;try{wakeLock=await navigator.wakeLock.request('screen')}catch(_){}}
async function releaseWake(){try{await wakeLock?.release()}catch(_){}wakeLock=null}

async function configureCameraControls(){
  capabilities=cameraTrack?.getCapabilities?.()||{};
  const settings=cameraTrack?.getSettings?.()||{};
  if(capabilities.zoom){
    els.zoom.disabled=false;els.zoom.min=capabilities.zoom.min??1;els.zoom.max=capabilities.zoom.max??4;els.zoom.step=capabilities.zoom.step??.1;els.zoom.value=settings.zoom??capabilities.zoom.min??1;
    els.zoomValue.textContent=`${Number(els.zoom.value).toFixed(1).replace('.',',')}×`;els.zoomSupport.textContent='Kamera-Zoom verfügbar.';
  }else{els.zoom.disabled=true;els.zoomSupport.textContent='Safari meldet keinen Hardware-Zoom.'}
  const modes=capabilities.focusMode||[];
  if(Array.isArray(modes)&&modes.includes('continuous')){
    els.autoFocus.disabled=false;els.focusStatus.textContent='Kontinuierlicher Autofokus verfügbar.';
    try{await cameraTrack.applyConstraints({advanced:[{focusMode:'continuous'}]})}catch(_){}
  }else{els.autoFocus.disabled=true;els.focusStatus.textContent='Safari steuert den Autofokus.'}
  if(capabilities.focusDistance){
    els.manualFocusGroup.hidden=false;els.focus.min=capabilities.focusDistance.min??0;els.focus.max=capabilities.focusDistance.max??1;els.focus.step=capabilities.focusDistance.step??.01;els.focus.value=settings.focusDistance??0;
    els.focusValue.textContent=Number(els.focus.value).toFixed(2).replace('.',',');
  }else els.manualFocusGroup.hidden=true;
}
async function setZoom(v){if(!cameraTrack||!capabilities.zoom)return;try{await cameraTrack.applyConstraints({advanced:[{zoom:Number(v)}]});els.zoomValue.textContent=`${Number(v).toFixed(1).replace('.',',')}×`}catch(e){console.warn(e)}}
async function setAutoFocus(){if(!cameraTrack)return;try{await cameraTrack.applyConstraints({advanced:[{focusMode:'continuous'}]});els.focusStatus.textContent='Autofokus aktiv.'}catch(_){els.focusStatus.textContent='Safari steuert den Autofokus.'}}
async function setManualFocus(v){if(!cameraTrack||!capabilities.focusDistance)return;try{await cameraTrack.applyConstraints({advanced:[{focusMode:'manual',focusDistance:Number(v)}]});els.focusValue.textContent=Number(v).toFixed(2).replace('.',',')}catch(e){console.warn(e)}}

async function start(){
  showError();if(!targets().length){showError('Bitte mindestens ein Zielkennzeichen eintragen.');return}
  try{
    await ensureAudio();
    await Promise.all([initDetector(),initOcr()]);
    setStatus('Kamera startet …','busy');
    stream=await navigator.mediaDevices.getUserMedia({video:{facingMode:{ideal:'environment'},width:{ideal:1920},height:{ideal:1080}},audio:false});
    cameraTrack=stream.getVideoTracks()[0];els.video.srcObject=stream;
    if(els.video.readyState<1||!els.video.videoWidth)await new Promise((resolve,reject)=>{const to=setTimeout(()=>reject(new Error('Kamerabild wurde nicht bereitgestellt.')),6000);els.video.addEventListener('loadedmetadata',()=>{clearTimeout(to);resolve()},{once:true})});
    els.video.muted=true;els.video.playsInline=true;els.video.setAttribute('playsinline','');els.video.setAttribute('webkit-playsinline','');await els.video.play();
    running=true;tracks=[];els.video.hidden=false;els.video.style.display='block';els.video.style.visibility='visible';els.video.style.opacity='1';els.placeholder.hidden=true;els.placeholder.style.display='none';els.stage.classList.add('camera-live');
    els.start.disabled=true;els.stop.disabled=false;showView('scanView');setStatus('Scan aktiv','active');await configureCameraControls();await requestWake();detectOnce();
  }catch(e){showError(`Start fehlgeschlagen: ${e.message||e}`);setStatus('Fehler','hit');await stop(false);showView('setupView')}
}
async function stop(back=true){
  running=false;clearTimeout(detectTimer);detectTimer=null;detectBusy=ocrBusy=false;
  stream?.getTracks().forEach(t=>t.stop());stream=null;cameraTrack=null;els.video.srcObject=null;
  els.stage.classList.remove('camera-live');els.placeholder.hidden=false;els.placeholder.style.display='';els.start.disabled=false;els.stop.disabled=true;els.zoom.disabled=true;els.autoFocus.disabled=true;
  tracks=[];els.overlay.innerHTML='';els.banner.hidden=true;await releaseWake();setStatus('Bereit','idle');if(back)showView('setupView');if(pendingReload)location.reload()
}
function logs(){try{return JSON.parse(localStorage.getItem(LOG_KEY)||'[]')}catch(_){return[]}}
function addLog(kind,plate,note){const l=logs();l.unshift({kind,plate,note,time:Date.now()});localStorage.setItem(LOG_KEY,JSON.stringify(l.slice(0,100)))}
function renderLog(){const l=logs();els.log.innerHTML=l.length?l.map(x=>`<div class="log-item ${x.kind}"><div><div class="kind">${x.kind==='hit'?'TREFFER':'ERKANNT'}</div><strong>${escapeHtml(x.plate)}</strong><small>${escapeHtml(x.note)}</small></div><small>${new Date(x.time).toLocaleString('de-DE')}</small></div>`).join(''):'<div class="empty-log">Noch keine Ereignisse.</div>'}
function escapeHtml(s){return String(s).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#039;'}[c]))}

els.targets.addEventListener('input',updateTargetCount);
els.start.addEventListener('click',start);els.stop.addEventListener('click',()=>stop(true));
els.zoom?.addEventListener('input',()=>setZoom(els.zoom.value));els.autoFocus?.addEventListener('click',setAutoFocus);els.focus?.addEventListener('input',()=>setManualFocus(els.focus.value));
els.testAlarm.addEventListener('click',async()=>{const t=targets()[0];if(!t)return;showView('scanView');showBanner(t.raw);setStatus('TREFFER','hit');await alarm();setTimeout(()=>{if(!running){setStatus('Bereit','idle');showView('setupView')}},2200)});
els.clearLog.addEventListener('click',()=>{localStorage.removeItem(LOG_KEY);renderLog()});
document.querySelectorAll('.tab-button').forEach(b=>b.addEventListener('click',()=>showView(b.dataset.view)));
document.addEventListener('visibilitychange',async()=>{if(document.visibilityState==='visible'&&running)await requestWake()});

async function initServiceWorker(){
  if(!('serviceWorker'in navigator))return;let reloading=false;
  navigator.serviceWorker.addEventListener('controllerchange',()=>{if(reloading)return;if(running){pendingReload=true;return}reloading=true;location.reload()});
  try{const reg=await navigator.serviceWorker.register('./sw.js?v=941',{updateViaCache:'none'});setTimeout(()=>reg.update().catch(()=>{}),1500);setInterval(()=>reg.update().catch(()=>{}),120000)}catch(e){console.warn(e)}
}
const saved=localStorage.getItem(TARGET_KEY)||localStorage.getItem('plateTargetsV93')||localStorage.getItem('plateTargetsV9')||localStorage.getItem('plateTargetsV8')||localStorage.getItem('plateTargets');
if(saved)els.targets.value=saved;
updateTargetCount();renderLog();initServiceWorker();
})();