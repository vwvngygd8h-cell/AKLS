(() => {
'use strict';

const $ = id => document.getElementById(id);
const els = {
  video:$('video'), canvas:$('captureCanvas'), stage:$('cameraStage'), overlay:$('plateOverlay'),
  placeholder:$('placeholder'), start:$('startBtn'), stop:$('stopBtn'),
  targets:$('targetPlates'), targetCount:$('targetCount'), activeTargets:$('activeTargets'),
  tolerant:$('tolerantMode'), wake:$('wakeLockToggle'), interval:$('scanInterval'), roi:$('roiMode'),
  confidence:$('ocrConfidence'), status:$('statusPill'), primary:$('scanPrimaryStatus'),
  lastOcr:$('lastOcr'), closest:$('closestTarget'), similarity:$('similarity'), ocrTime:$('ocrTime'),
  scanCount:$('scanCount'), hitCount:$('hitCount'), confirmCount:$('confirmCount'),
  banner:$('alertBanner'), bannerType:$('alertType'), bannerText:$('alertText'),
  log:$('hitLog'), clearLog:$('clearLogBtn'), testAlarm:$('testAlarmBtn'), error:$('errorBox'),
  setupView:$('setupView'), scanView:$('scanView'), logView:$('logView'),
  zoom:$('zoomSlider'), zoomValue:$('zoomValue'), zoomSupport:$('zoomSupport'),
  autoFocus:$('autoFocusBtn'), focusStatus:$('focusStatus'),
  manualFocusGroup:$('manualFocusGroup'), focus:$('focusSlider'), focusValue:$('focusValue')
};

const APP_VERSION='9.3.2';
const LOG_KEY='akls-v93-log';
const TARGET_KEY='plateTargetsV93';
const TRACK_TTL=2200;
const GREEN_CONFIRMATIONS=2;
const RED_CONFIRMATIONS=2;

let stream=null, track=null, worker=null, running=false, busy=false, timer=null;
let wakeLock=null, audioCtx=null, scans=0, hits=0, lastHitAt=0, pendingReload=false;
let tracks=[], nextTrackId=1, capabilities={};

const normalize=s=>(s||'').toUpperCase()
  .replace(/Ä/g,'A').replace(/Ö/g,'O').replace(/Ü/g,'U')
  .replace(/[^A-Z0-9]/g,'');

const pretty=s=>String(s||'').trim().toUpperCase().replace(/\s+/g,' ').replace(/\s*-\s*/g,'-');
const clamp=(n,a,b)=>Math.min(b,Math.max(a,n));

function targets(){
  const seen=new Set();
  return (els.targets.value||'').split(/\n|,|;/).map(v=>v.trim()).filter(Boolean)
    .map(raw=>({raw:pretty(raw),norm:normalize(raw)}))
    .filter(x=>x.norm.length>=3 && !seen.has(x.norm) && seen.add(x.norm));
}

const CONFUSIONS={
  '0':['O','Q','D'],'O':['0','Q'],'1':['I','L'],'I':['1','L'],'L':['1','I'],
  '2':['Z'],'Z':['2'],'5':['S'],'S':['5'],'6':['G'],'G':['6'],'8':['B'],'B':['8']
};

function confusionCost(a,b){
  if(a===b)return 0;
  if(CONFUSIONS[a]?.includes(b)||CONFUSIONS[b]?.includes(a))return .35;
  return 1;
}

function weightedDistance(a,b){
  const d=Array.from({length:a.length+1},()=>new Float32Array(b.length+1));
  for(let i=0;i<=a.length;i++)d[i][0]=i;
  for(let j=0;j<=b.length;j++)d[0][j]=j;
  for(let i=1;i<=a.length;i++){
    for(let j=1;j<=b.length;j++){
      d[i][j]=Math.min(d[i-1][j]+1,d[i][j-1]+1,d[i-1][j-1]+confusionCost(a[i-1],b[j-1]));
    }
  }
  return d[a.length][b.length];
}

function bestTargetMatch(value){
  const v=normalize(value); let best=null;
  for(const t of targets()){
    const candidates=new Set([v]);
    if(v.length>=t.norm.length){
      for(let i=0;i<=v.length-t.norm.length;i++)candidates.add(v.slice(i,i+t.norm.length));
    }
    for(const c of candidates){
      const distance=weightedDistance(c,t.norm);
      const similarity=Math.round(Math.max(0,1-distance/Math.max(c.length,t.norm.length,1))*100);
      if(!best||distance<best.distance||(distance===best.distance&&similarity>best.similarity)){
        best={target:t,value:c,distance,similarity};
      }
    }
  }
  return best;
}

function germanPlatePlausibility(s){
  const n=normalize(s);
  if(n.length<3||n.length>10)return 0;
  let score=0;
  if(/[A-Z]/.test(n)&&/\d/.test(n))score+=18;
  if(/^[A-Z]{2,5}\d{1,4}[EH]?$/.test(n))score+=32;
  if(/^[A-Z]{1,3}[A-Z]{1,2}\d{1,4}[EH]?$/.test(n))score+=18;
  if(/^[A-Z]{1,5}\d{1,4}[A-Z]?$/.test(n))score+=10;
  return score;
}

function setStatus(text,kind='idle'){
  els.status.textContent=text;
  els.status.className=`status-pill ${kind}`;
  els.primary.textContent=text;
}

function showView(id){
  [els.setupView,els.scanView,els.logView].forEach(v=>{
    v.hidden=v.id!==id; v.classList.toggle('active-view',v.id===id);
  });
  document.querySelectorAll('.tab-button').forEach(b=>b.classList.toggle('active',b.dataset.view===id));
  if(id==='logView')renderLog();
  window.scrollTo({top:0,behavior:'auto'});
}

function updateTargetCount(){
  const n=targets().length;
  els.targetCount.textContent=`${n} Zielkennzeichen`;
  els.activeTargets.textContent=String(n);
  localStorage.setItem(TARGET_KEY,els.targets.value);
}

function showError(msg=''){els.error.hidden=!msg;els.error.textContent=msg;}

function roiFractions(){
  switch(els.roi.value){
    case 'wide': return {x:.02,y:.18,w:.96,h:.64};
    case 'full': return {x:0,y:0,w:1,h:1};
    default: return {x:.06,y:.28,w:.88,h:.44};
  }
}

function getVisibleSourceRect(){
  const vw=els.video.videoWidth,vh=els.video.videoHeight,sw=els.stage.clientWidth,sh=els.stage.clientHeight;
  if(!vw||!vh||!sw||!sh)return null;
  const sourceAR=vw/vh,stageAR=sw/sh;
  if(sourceAR>stageAR){const w=vh*stageAR;return{x:(vw-w)/2,y:0,w,h:vh,vw,vh};}
  const h=vw/stageAR;return{x:0,y:(vh-h)/2,w:vw,h,vw,vh};
}

function cropRoi(){
  const v=getVisibleSourceRect(); if(!v)return null;
  const r=roiFractions();
  const x=v.x+v.w*r.x,y=v.y+v.h*r.y,w=v.w*r.w,h=v.h*r.h;
  const maxW=1400,scale=Math.min(1.35,maxW/w);
  els.canvas.width=Math.max(1,Math.round(w*scale));
  els.canvas.height=Math.max(1,Math.round(h*scale));
  const ctx=els.canvas.getContext('2d',{willReadFrequently:true});
  ctx.filter='grayscale(1) contrast(1.45) brightness(1.05)';
  ctx.drawImage(els.video,x,y,w,h,0,0,els.canvas.width,els.canvas.height);
  ctx.filter='none';
  return {canvas:els.canvas,source:{x,y,w,h},scaleX:w/els.canvas.width,scaleY:h/els.canvas.height};
}

function sourceBoxToStage(box){
  const v=getVisibleSourceRect(); if(!v)return null;
  const sw=els.stage.clientWidth,sh=els.stage.clientHeight;
  return {
    left:(box.x-v.x)/v.w*sw,
    top:(box.y-v.y)/v.h*sh,
    width:box.w/v.w*sw,
    height:box.h/v.h*sh
  };
}

function boxIou(a,b){
  const x1=Math.max(a.x,b.x),y1=Math.max(a.y,b.y);
  const x2=Math.min(a.x+a.w,b.x+b.w),y2=Math.min(a.y+a.h,b.y+b.h);
  const inter=Math.max(0,x2-x1)*Math.max(0,y2-y1);
  const union=a.w*a.h+b.w*b.h-inter;
  return union?inter/union:0;
}

function cleanTracks(){
  const now=Date.now();
  tracks=tracks.filter(t=>now-t.lastSeen<TRACK_TTL);
}

function updateTrack(candidate){
  const now=Date.now();
  let best=null,bestScore=0;
  for(const t of tracks){
    const spatial=boxIou(t.box,candidate.box);
    const textScore=1-Math.min(1,weightedDistance(t.text,candidate.text)/Math.max(t.text.length,candidate.text.length,1));
    const score=spatial*.65+textScore*.35;
    if(score>bestScore){best=t;bestScore=score;}
  }

  if(best&&bestScore>.28){
    best.box={
      x:best.box.x*.35+candidate.box.x*.65,
      y:best.box.y*.35+candidate.box.y*.65,
      w:best.box.w*.35+candidate.box.w*.65,
      h:best.box.h*.35+candidate.box.h*.65
    };
    best.text=candidate.text;
    best.lastSeen=now;
    best.history.push({text:candidate.text,time:now,confidence:candidate.confidence});
    best.history=best.history.filter(x=>now-x.time<2600).slice(-5);
    return best;
  }

  const t={
    id:nextTrackId++,box:candidate.box,text:candidate.text,lastSeen:now,
    history:[{text:candidate.text,time:now,confidence:candidate.confidence}],
    state:'yellow',label:candidate.text,greenUntil:0,redUntil:0
  };
  tracks.push(t);
  return t;
}

function consensus(t){
  const groups=[];
  for(const h of t.history){
    let g=groups.find(x=>weightedDistance(x.text,h.text)<=.4);
    if(!g){g={text:h.text,count:0,confidence:0};groups.push(g);}
    g.count++; g.confidence+=h.confidence;
  }
  groups.sort((a,b)=>b.count-a.count||b.confidence-a.confidence);
  return groups[0]||null;
}

function targetVote(t){
  const votes=new Map();
  for(const h of t.history.slice(-4)){
    const bm=bestTargetMatch(h.text); if(!bm)continue;
    const allowed=els.tolerant.checked?1.05:.4;
    if(bm.distance<=allowed){
      const e=votes.get(bm.target.norm)||{target:bm.target,count:0,similarity:0};
      e.count++;e.similarity=Math.max(e.similarity,bm.similarity);votes.set(bm.target.norm,e);
    }
  }
  return [...votes.values()].sort((a,b)=>b.count-a.count||b.similarity-a.similarity)[0]||null;
}

function renderTracks(){
  cleanTracks();
  const now=Date.now();
  const liveIds=new Set(tracks.map(t=>String(t.id)));
  [...els.overlay.querySelectorAll('.plate-box')].forEach(d=>{
    if(!liveIds.has(d.dataset.trackId))d.remove();
  });

  for(const t of tracks){
    if(t.redUntil>now)t.state='red';
    else if(t.greenUntil>now)t.state='green';
    else t.state='yellow';

    const p=sourceBoxToStage(t.box); if(!p)continue;
    let div=els.overlay.querySelector(`.plate-box[data-track-id="${t.id}"]`);
    if(!div){
      div=document.createElement('div');
      div.dataset.trackId=String(t.id);
      div.innerHTML='<span class="plate-label"></span>';
      els.overlay.appendChild(div);
    }
    div.className=`plate-box ${t.state}`;
    div.style.left=`${clamp(p.left,0,els.stage.clientWidth-4)}px`;
    div.style.top=`${clamp(p.top,0,els.stage.clientHeight-4)}px`;
    div.style.width=`${clamp(p.width,30,els.stage.clientWidth)}px`;
    div.style.height=`${clamp(p.height,14,els.stage.clientHeight)}px`;
    div.querySelector('.plate-label').textContent=t.state==='red'?(t.label||'ZIEL'):t.label;
  }
}

function extractCandidates(data,crop){
  const words=[];
  const pushWord=w=>{
    const text=normalize(w.text);
    const confidence=Number(w.confidence)||0;
    const b=w.bbox;
    if(!text||!b)return;
    if(text.length<3||text.length>10)return;
    if(confidence<Math.max(18,Number(els.confidence.value)-25))return;
    if(germanPlatePlausibility(text)<18)return;

    const bw=b.x1-b.x0,bh=b.y1-b.y0;
    if(bw<=0||bh<=0)return;
    const ratio=bw/bh;
    if(ratio<1.25||ratio>9.5)return;

    const padX=Math.max(4,bw*.08),padY=Math.max(3,bh*.18);
    const box={
      x:crop.source.x+(b.x0-padX)*crop.scaleX,
      y:crop.source.y+(b.y0-padY)*crop.scaleY,
      w:(bw+2*padX)*crop.scaleX,
      h:(bh+2*padY)*crop.scaleY
    };
    words.push({text,confidence,box});
  };

  if(Array.isArray(data.words))data.words.forEach(pushWord);
  for(const block of data.blocks||[])
    for(const par of block.paragraphs||[])
      for(const line of par.lines||[])
        for(const word of line.words||[])pushWord(word);


  // V9.3.2: combine adjacent OCR words from one line.
  // Tesseract often splits German plates, e.g. "NB" + "BC" + "721".
  for(const block of data.blocks||[]){
    for(const par of block.paragraphs||[]){
      for(const line of par.lines||[]){
        const lineWords=(line.words||[]).filter(w=>w?.bbox && normalize(w.text));
        if(lineWords.length<2) continue;
        for(let start=0; start<lineWords.length; start++){
          let text='', x0=Infinity,y0=Infinity,x1=-Infinity,y1=-Infinity, conf=0,count=0;
          for(let end=start; end<Math.min(lineWords.length,start+4); end++){
            const w=lineWords[end], n=normalize(w.text);
            if(!n) continue;
            text += n;
            x0=Math.min(x0,w.bbox.x0); y0=Math.min(y0,w.bbox.y0);
            x1=Math.max(x1,w.bbox.x1); y1=Math.max(y1,w.bbox.y1);
            conf += Number(w.confidence)||0; count++;
            if(text.length<3 || text.length>10) continue;
            const avg=conf/Math.max(1,count);
            if(avg<Math.max(18,Number(els.confidence.value)-25)) continue;
            if(germanPlatePlausibility(text)<18) continue;
            const bw=x1-x0,bh=y1-y0,ratio=bw/Math.max(1,bh);
            if(ratio<1.25||ratio>9.5) continue;
            const padX=Math.max(4,bw*.06),padY=Math.max(3,bh*.14);
            words.push({
              text,confidence:avg,
              box:{
                x:crop.source.x+(x0-padX)*crop.scaleX,
                y:crop.source.y+(y0-padY)*crop.scaleY,
                w:(bw+2*padX)*crop.scaleX,
                h:(bh+2*padY)*crop.scaleY
              }
            });
          }
        }
      }
    }
  }

  // Also use line boxes when Tesseract groups the whole plate as a line.
  for(const block of data.blocks||[]){
    for(const par of block.paragraphs||[]){
      for(const line of par.lines||[]){
        const text=normalize(line.text);
        const confidence=Number(line.confidence)||0;
        const b=line.bbox;
        if(!b||text.length<3||text.length>10||confidence<Math.max(18,Number(els.confidence.value)-25))continue;
        if(germanPlatePlausibility(text)<18)continue;
        const bw=b.x1-b.x0,bh=b.y1-b.y0,ratio=bw/Math.max(1,bh);
        if(ratio<1.25||ratio>9.5)continue;
        const padX=Math.max(4,bw*.05),padY=Math.max(3,bh*.12);
        words.push({
          text,confidence,
          box:{
            x:crop.source.x+(b.x0-padX)*crop.scaleX,
            y:crop.source.y+(b.y0-padY)*crop.scaleY,
            w:(bw+2*padX)*crop.scaleX,
            h:(bh+2*padY)*crop.scaleY
          }
        });
      }
    }
  }

  // Keep strongest unique candidates.
  words.sort((a,b)=>b.confidence-a.confidence);
  const kept=[];
  for(const w of words){
    if(kept.some(k=>boxIou(k.box,w.box)>.45))continue;
    kept.push(w);
    if(kept.length>=4)break;
  }
  return kept;
}

async function initWorker(){
  if(worker)return;
  if(!window.Tesseract)throw new Error('OCR konnte nicht geladen werden.');
  setStatus('OCR lädt …','busy');
  worker=await Tesseract.createWorker('eng',1,{
    logger:m=>{
      if(m.status==='recognizing text'&&typeof m.progress==='number')
        setStatus(`OCR ${Math.round(m.progress*100)} %`,'busy');
    }
  });
  await worker.setParameters({
    tessedit_char_whitelist:'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789',
    tessedit_pageseg_mode:'11',
    preserve_interword_spaces:'0'
  });
}

async function scanOnce(){
  if(!running||busy)return;
  busy=true;
  const started=performance.now();

  try{
    const crop=cropRoi();
    if(!crop)return;

    const result=await worker.recognize(crop.canvas,{}, {blocks:true,text:true});
    scans++;els.scanCount.textContent=String(scans);
    els.ocrTime.textContent=`${Math.round(performance.now()-started)} ms`;

    const candidates=extractCandidates(result.data,crop);
    let strongest=null;

    for(const c of candidates){
      const t=updateTrack(c);
      const con=consensus(t);
      if(!con)continue;

      t.label=con.text;
      if(!strongest||con.count>strongest.count)strongest={...con,track:t};

      if(con.count>=GREEN_CONFIRMATIONS){
        t.greenUntil=Date.now()+1800;
        t.label=con.text;
      }

      const vote=targetVote(t);
      if(vote&&vote.count>=RED_CONFIRMATIONS){
        t.redUntil=Date.now()+3200;
        t.label=vote.target.raw;
        showBanner(vote.target.raw);
        setStatus('TREFFER','hit');

        const now=Date.now();
        if(now-lastHitAt>4500){
          lastHitAt=now;hits++;els.hitCount.textContent=String(hits);
          addLog('hit',vote.target.raw,`${vote.count} OCR-Bestätigungen`);
          await alarm();
        }
      }
    }

    cleanTracks();
    renderTracks();

    if(strongest){
      els.lastOcr.textContent=strongest.text;
      els.confirmCount.textContent=String(strongest.count);
      const bm=bestTargetMatch(strongest.text);
      els.closest.textContent=bm?bm.target.raw:'—';
      els.similarity.textContent=bm?`${bm.similarity} %`:'—';
      if(!tracks.some(t=>t.redUntil>Date.now()))setStatus('Scan aktiv','active');
    }else{
      els.confirmCount.textContent='0';
      if(!tracks.some(t=>t.redUntil>Date.now()))setStatus('Scan aktiv','active');
    }
  }catch(e){
    console.warn(e);
    setStatus('Scan aktiv','active');
  }finally{
    busy=false;
    if(running)timer=setTimeout(scanOnce,Number(els.interval.value));
  }
}

async function ensureAudio(){
  if(!audioCtx)audioCtx=new (window.AudioContext||window.webkitAudioContext)();
  if(audioCtx.state==='suspended')await audioCtx.resume();
}

async function alarm(){
  await ensureAudio();
  const now=audioCtx.currentTime;
  [0,.34,.68].forEach(o=>{
    const osc=audioCtx.createOscillator(),g=audioCtx.createGain();
    osc.type='square';osc.frequency.value=1050;
    g.gain.setValueAtTime(.0001,now+o);
    g.gain.exponentialRampToValueAtTime(.45,now+o+.015);
    g.gain.exponentialRampToValueAtTime(.0001,now+o+.22);
    osc.connect(g).connect(audioCtx.destination);
    osc.start(now+o);osc.stop(now+o+.25);
  });
  if(navigator.vibrate)navigator.vibrate([220,100,220,100,450]);
}

function showBanner(plate){
  els.banner.hidden=false;els.bannerType.textContent='TREFFER!';els.bannerText.textContent=plate;
  clearTimeout(showBanner.t);
  showBanner.t=setTimeout(()=>{els.banner.hidden=true;if(running)setStatus('Scan aktiv','active');},3200);
}

async function requestWake(){
  if(!els.wake.checked||!navigator.wakeLock)return;
  try{wakeLock=await navigator.wakeLock.request('screen')}catch(_){wakeLock=null}
}
async function releaseWake(){try{await wakeLock?.release()}catch(_){}wakeLock=null;}

async function configureCameraControls(){
  capabilities=track?.getCapabilities?.()||{};
  const settings=track?.getSettings?.()||{};

  if(capabilities.zoom){
    els.zoom.disabled=false;
    els.zoom.min=capabilities.zoom.min??1;
    els.zoom.max=capabilities.zoom.max??4;
    els.zoom.step=capabilities.zoom.step??.1;
    els.zoom.value=settings.zoom??capabilities.zoom.min??1;
    els.zoomValue.textContent=`${Number(els.zoom.value).toFixed(1).replace('.',',')}×`;
    els.zoomSupport.textContent='Optischer/Hardware-Zoom der Kamera verfügbar.';
  }else{
    els.zoom.disabled=true;
    els.zoomSupport.textContent='Diese Safari-Kamera meldet keinen Hardware-Zoom.';
  }

  const modes=capabilities.focusMode||[];
  if(Array.isArray(modes)&&modes.includes('continuous')){
    els.autoFocus.disabled=false;
    els.focusStatus.textContent='Kontinuierlicher Autofokus verfügbar.';
    try{await track.applyConstraints({advanced:[{focusMode:'continuous'}]});}catch(_){}
  }else{
    els.autoFocus.disabled=true;
    els.focusStatus.textContent='Safari verwendet den Kamera-Autofokus.';
  }

  if(capabilities.focusDistance){
    els.manualFocusGroup.hidden=false;
    els.focus.min=capabilities.focusDistance.min??0;
    els.focus.max=capabilities.focusDistance.max??1;
    els.focus.step=capabilities.focusDistance.step??.01;
    els.focus.value=settings.focusDistance??capabilities.focusDistance.min??0;
    els.focusValue.textContent=Number(els.focus.value).toFixed(2).replace('.',',');
  }else{
    els.manualFocusGroup.hidden=true;
  }
}

async function setZoom(value){
  if(!track||!capabilities.zoom)return;
  const z=Number(value);
  try{
    await track.applyConstraints({advanced:[{zoom:z}]});
    els.zoomValue.textContent=`${z.toFixed(1).replace('.',',')}×`;
  }catch(e){console.warn('zoom',e)}
}

async function setAutoFocus(){
  if(!track)return;
  try{
    await track.applyConstraints({advanced:[{focusMode:'continuous'}]});
    els.focusStatus.textContent='Autofokus aktiv.';
  }catch(e){
    els.focusStatus.textContent='Autofokus wird von Safari gesteuert.';
  }
}

async function setManualFocus(value){
  if(!track||!capabilities.focusDistance)return;
  try{
    await track.applyConstraints({advanced:[{focusMode:'manual',focusDistance:Number(value)}]});
    els.focusValue.textContent=Number(value).toFixed(2).replace('.',',');
    els.focusStatus.textContent='Manueller Fokus aktiv.';
  }catch(e){console.warn('focus',e)}
}

async function start(){
  showError();
  if(!targets().length){showError('Bitte mindestens ein Zielkennzeichen eintragen.');return;}
  try{
    await ensureAudio();await initWorker();
    setStatus('Kamera startet …','busy');
    stream=await navigator.mediaDevices.getUserMedia({
      video:{facingMode:{ideal:'environment'},width:{ideal:1920},height:{ideal:1080}},
      audio:false
    });
    track=stream.getVideoTracks()[0];
    els.video.srcObject=stream;

    if(els.video.readyState<1||!els.video.videoWidth){
      await new Promise((resolve,reject)=>{
        const timeout=setTimeout(()=>reject(new Error('Kamerabild wurde nicht bereitgestellt.')),5000);
        const ready=()=>{clearTimeout(timeout);resolve();};
        els.video.addEventListener('loadedmetadata',ready,{once:true});
      });
    }

    els.video.muted=true;els.video.playsInline=true;
    els.video.setAttribute('playsinline','');els.video.setAttribute('webkit-playsinline','');
    await els.video.play();

    running=true;tracks=[];
    els.video.hidden=false;els.video.style.display='block';els.video.style.visibility='visible';els.video.style.opacity='1';
    els.placeholder.hidden=true;els.placeholder.style.display='none';els.stage.classList.add('camera-live');
    els.start.disabled=true;els.stop.disabled=false;
    showView('scanView');setStatus('Scan aktiv','active');
    await configureCameraControls();
    await requestWake();
    scanOnce();
  }catch(e){
    showError(`Start fehlgeschlagen: ${e.message||e}`);
    setStatus('Fehler','hit');await stop(false);showView('setupView');
  }
}

async function stop(back=true){
  running=false;clearTimeout(timer);timer=null;busy=false;
  stream?.getTracks().forEach(t=>t.stop());stream=null;track=null;els.video.srcObject=null;
  els.stage.classList.remove('camera-live');els.placeholder.hidden=false;els.placeholder.style.display='';
  els.start.disabled=false;els.stop.disabled=true;els.zoom.disabled=true;els.autoFocus.disabled=true;
  tracks=[];els.overlay.innerHTML='';els.banner.hidden=true;
  await releaseWake();setStatus('Bereit','idle');
  if(back)showView('setupView');
  if(pendingReload)location.reload();
}

function logs(){try{return JSON.parse(localStorage.getItem(LOG_KEY)||'[]')}catch(_){return[]}}
function addLog(kind,plate,note){
  const l=logs();l.unshift({kind,plate,note,time:Date.now()});
  localStorage.setItem(LOG_KEY,JSON.stringify(l.slice(0,100)));
}
function renderLog(){
  const l=logs();
  if(!l.length){els.log.innerHTML='<div class="empty-log">Noch keine Ereignisse.</div>';return;}
  els.log.innerHTML=l.map(x=>`<div class="log-item ${x.kind}"><div><div class="kind">${x.kind==='hit'?'TREFFER':'ERKANNT'}</div><strong>${escapeHtml(x.plate)}</strong><small>${escapeHtml(x.note)}</small></div><small>${new Date(x.time).toLocaleString('de-DE')}</small></div>`).join('');
}
function escapeHtml(s){return String(s).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#039;'}[c]));}

els.targets.addEventListener('input',updateTargetCount);
els.start.addEventListener('click',start);
els.stop.addEventListener('click',()=>stop(true));
els.zoom?.addEventListener('input',()=>setZoom(els.zoom.value));
els.autoFocus?.addEventListener('click',setAutoFocus);
els.focus?.addEventListener('input',()=>setManualFocus(els.focus.value));
els.testAlarm.addEventListener('click',async()=>{
  const t=targets()[0];if(!t)return;
  showView('scanView');showBanner(t.raw);setStatus('TREFFER','hit');await alarm();
  setTimeout(()=>{if(!running){setStatus('Bereit','idle');showView('setupView')}},2200);
});
els.clearLog.addEventListener('click',()=>{localStorage.removeItem(LOG_KEY);renderLog()});
document.querySelectorAll('.tab-button').forEach(b=>b.addEventListener('click',()=>showView(b.dataset.view)));
document.addEventListener('visibilitychange',async()=>{if(document.visibilityState==='visible'&&running)await requestWake()});

async function initServiceWorker(){
  if(!('serviceWorker'in navigator))return;
  let reloading=false;
  navigator.serviceWorker.addEventListener('controllerchange',()=>{
    if(reloading)return;if(running){pendingReload=true;return;}reloading=true;location.reload();
  });
  try{
    const reg=await navigator.serviceWorker.register('./sw.js?v=932',{updateViaCache:'none'});
    setTimeout(()=>reg.update().catch(()=>{}),1500);
    setInterval(()=>reg.update().catch(()=>{}),120000);
  }catch(e){console.warn('service worker',e)}
}

const saved=localStorage.getItem(TARGET_KEY)||localStorage.getItem('plateTargetsV9')||
            localStorage.getItem('plateTargetsV8')||localStorage.getItem('plateTargets');
if(saved)els.targets.value=saved;
updateTargetCount();renderLog();initServiceWorker();
})();