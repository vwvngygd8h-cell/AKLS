(() => {
'use strict';

const $ = id => document.getElementById(id);
const els = {
  video:$('video'), canvas:$('captureCanvas'), detector:$('detectorCanvas'), stage:$('cameraStage'),
  overlay:$('plateOverlay'), placeholder:$('placeholder'), start:$('startBtn'), stop:$('stopBtn'),
  targets:$('targetPlates'), targetCount:$('targetCount'), activeTargets:$('activeTargets'),
  tolerant:$('tolerantMode'), wake:$('wakeLockToggle'), interval:$('scanInterval'), roi:$('roiMode'),
  confidence:$('ocrConfidence'), status:$('statusPill'), primary:$('scanPrimaryStatus'),
  lastOcr:$('lastOcr'), closest:$('closestTarget'), similarity:$('similarity'), ocrTime:$('ocrTime'),
  scanCount:$('scanCount'), hitCount:$('hitCount'), confirmCount:$('confirmCount'),
  banner:$('alertBanner'), bannerType:$('alertType'), bannerText:$('alertText'),
  log:$('hitLog'), clearLog:$('clearLogBtn'), testAlarm:$('testAlarmBtn'), error:$('errorBox'),
  setupView:$('setupView'), scanView:$('scanView'), logView:$('logView')
};

const APP_VERSION = '9.2.0';
const LOG_KEY = 'akls-v9-log';
const TARGET_KEY = 'plateTargetsV9';
const DETECT_INTERVAL = 150;
const TRACK_TTL = 750;
const HISTORY_TTL = 2600;
const GREEN_CONFIRMATIONS = 2;
const RED_CONFIRMATIONS = 2;
const YELLOW_CONFIRMATIONS = 2;
const MAX_LIVE_TRACKS = 2;

let stream=null, worker=null, running=false, busy=false, scanTimer=null, detectorTimer=null;
let wakeLock=null, audioCtx=null, scans=0, hits=0, lastHitAt=0, pendingReload=false;
let nextTrackId=1, tracks=[];

const normalize = s => (s||'').toUpperCase()
  .replace(/Ä/g,'A').replace(/Ö/g,'O').replace(/Ü/g,'U')
  .replace(/[^A-Z0-9]/g,'');

const pretty = s => String(s||'').trim().toUpperCase()
  .replace(/\s+/g,' ').replace(/\s*-\s*/g,'-');

const clamp = (n,a,b) => Math.min(b,Math.max(a,n));

function targets(){
  const seen=new Set();
  return (els.targets.value||'').split(/\n|,|;/).map(v=>v.trim()).filter(Boolean)
    .map(raw=>({raw:pretty(raw),norm:normalize(raw)}))
    .filter(x=>x.norm.length>=3 && !seen.has(x.norm) && seen.add(x.norm));
}

const CONFUSIONS = {
  '0':['O','Q','D'], 'O':['0','Q'], '1':['I','L'], 'I':['1','L'], 'L':['1','I'],
  '2':['Z'], 'Z':['2'], '5':['S'], 'S':['5'], '6':['G'], 'G':['6'], '8':['B'], 'B':['8']
};

function confusionCost(a,b){
  if(a===b) return 0;
  if(CONFUSIONS[a]?.includes(b) || CONFUSIONS[b]?.includes(a)) return 0.35;
  return 1;
}

function weightedDistance(a,b){
  const rows=Array.from({length:a.length+1},()=>new Float32Array(b.length+1));
  for(let i=0;i<=a.length;i++) rows[i][0]=i;
  for(let j=0;j<=b.length;j++) rows[0][j]=j;
  for(let i=1;i<=a.length;i++){
    for(let j=1;j<=b.length;j++){
      rows[i][j]=Math.min(
        rows[i-1][j]+1,
        rows[i][j-1]+1,
        rows[i-1][j-1]+confusionCost(a[i-1],b[j-1])
      );
    }
  }
  return rows[a.length][b.length];
}

function bestTargetMatch(value){
  const v=normalize(value);
  let best=null;
  for(const t of targets()){
    const candidates=new Set([v]);
    if(v.length>=t.norm.length){
      for(let i=0;i<=v.length-t.norm.length;i++) candidates.add(v.slice(i,i+t.norm.length));
    }
    for(const c of candidates){
      const distance=weightedDistance(c,t.norm);
      const similarity=Math.round(Math.max(0,1-distance/Math.max(c.length,t.norm.length,1))*100);
      if(!best || distance<best.distance || (distance===best.distance && similarity>best.similarity)){
        best={target:t,value:c,distance,similarity};
      }
    }
  }
  return best;
}

function germanPlatePlausibility(s){
  const n=normalize(s);
  if(n.length<4 || n.length>10) return 0;
  let score=0;
  if(/[A-Z]/.test(n) && /\d/.test(n)) score+=15;
  if(/^[A-Z]{1,3}[A-Z]{1,2}\d{1,4}[EH]?$/.test(n)) score+=35;
  if(/^[A-Z]{2,5}\d{1,4}$/.test(n)) score+=22;
  if(/^[A-Z]{1,3}\d{1,4}$/.test(n)) score+=8;
  return score;
}

function displayPlate(n){
  const s=normalize(n);
  const m=s.match(/^([A-Z]{1,3})([A-Z]{1,2})(\d{1,4}[EH]?)$/);
  return m ? `${m[1]}-${m[2]} ${m[3]}` : s;
}

function setStatus(text,kind='idle'){
  els.status.textContent=text;
  els.status.className=`status-pill ${kind}`;
  els.primary.textContent=text;
}

function showView(id){
  [els.setupView,els.scanView,els.logView].forEach(v=>{
    v.hidden=v.id!==id;
    v.classList.toggle('active-view',v.id===id);
  });
  document.querySelectorAll('.tab-button').forEach(b=>b.classList.toggle('active',b.dataset.view===id));
  if(id==='logView') renderLog();
  window.scrollTo({top:0,behavior:'auto'});
}

function updateTargetCount(){
  const n=targets().length;
  els.targetCount.textContent=`${n} Zielkennzeichen`;
  els.activeTargets.textContent=String(n);
  localStorage.setItem(TARGET_KEY,els.targets.value);
}

function error(msg=''){
  els.error.hidden=!msg;
  els.error.textContent=msg;
}

function roiFractions(){
  switch(els.roi.value){
    case 'wide': return {x:.01,y:.18,w:.98,h:.64};
    case 'full': return {x:0,y:0,w:1,h:1};
    default: return {x:.04,y:.26,w:.92,h:.48};
  }
}

function getVisibleSourceRect(){
  const vw=els.video.videoWidth,vh=els.video.videoHeight,sw=els.stage.clientWidth,sh=els.stage.clientHeight;
  if(!vw||!vh||!sw||!sh) return null;
  const sourceAR=vw/vh,stageAR=sw/sh;
  if(sourceAR>stageAR){
    const w=vh*stageAR; return {x:(vw-w)/2,y:0,w,h:vh,vw,vh};
  }
  const h=vw/stageAR; return {x:0,y:(vh-h)/2,w:vw,h,vw,vh};
}

function sourceToStage(box){
  const v=getVisibleSourceRect();
  if(!v) return null;
  const sw=els.stage.clientWidth,sh=els.stage.clientHeight;
  return {
    left:(box.x-v.x)/v.w*sw,
    top:(box.y-v.y)/v.h*sh,
    width:box.w/v.w*sw,
    height:box.h/v.h*sh
  };
}

function iou(a,b){
  const x1=Math.max(a.x,b.x), y1=Math.max(a.y,b.y);
  const x2=Math.min(a.x+a.w,b.x+b.w), y2=Math.min(a.y+a.h,b.y+b.h);
  const inter=Math.max(0,x2-x1)*Math.max(0,y2-y1);
  const union=a.w*a.h+b.w*b.h-inter;
  return union?inter/union:0;
}

function smoothBox(a,b,alpha=.58){
  if(!a) return {...b};
  return {
    x:a.x*(1-alpha)+b.x*alpha,
    y:a.y*(1-alpha)+b.y*alpha,
    w:a.w*(1-alpha)+b.w*alpha,
    h:a.h*(1-alpha)+b.h*alpha
  };
}

function renderTracks(){
  const now=Date.now();
  tracks=tracks.filter(t=>now-t.lastSeen<TRACK_TTL);
  const liveIds=new Set(tracks.map(t=>String(t.id)));

  [...els.overlay.querySelectorAll('.plate-box')].forEach(div=>{
    if(!liveIds.has(div.dataset.trackId)) div.remove();
  });

  for(const t of tracks){
    if((t.seenCount||0) < YELLOW_CONFIRMATIONS && t.state!=='green' && t.state!=='red') continue;
    const p=sourceToStage(t.box);
    if(!p) continue;
    let div=els.overlay.querySelector(`.plate-box[data-track-id="${t.id}"]`);
    if(!div){
      div=document.createElement('div');
      div.dataset.trackId=String(t.id);
      div.innerHTML='<span class="plate-label"></span>';
      els.overlay.appendChild(div);
    }
    if(t.redUntil>now) t.state='red';
    else if(t.greenUntil>now) t.state='green';
    else if((t.seenCount||0) >= YELLOW_CONFIRMATIONS) t.state='yellow';
    else t.state='pending';

    div.className=`plate-box ${t.state}`;
    div.style.left=`${clamp(p.left,0,els.stage.clientWidth-6)}px`;
    div.style.top=`${clamp(p.top,0,els.stage.clientHeight-6)}px`;
    div.style.width=`${clamp(p.width,24,els.stage.clientWidth)}px`;
    div.style.height=`${clamp(p.height,12,els.stage.clientHeight)}px`;
    div.querySelector('.plate-label').textContent =
      t.state==='red' ? (t.label||'ZIELTREFFER') :
      t.state==='green' ? (t.label||'Kennzeichen gelesen') :
      'Kennzeichen erkannt';
  }
}

function detectorCandidates(){
  if(!running || els.video.readyState<2) return [];
  const v=getVisibleSourceRect(); if(!v) return [];
  const r=roiFractions();
  const sx=v.x+v.w*r.x, sy=v.y+v.h*r.y, sw=v.w*r.w, sh=v.h*r.h;

  const c=els.detector,ctx=c.getContext('2d',{willReadFrequently:true});
  ctx.drawImage(els.video,sx,sy,sw,sh,0,0,c.width,c.height);

  const {data}=ctx.getImageData(0,0,c.width,c.height);
  const W=c.width,H=c.height;
  const gray=new Uint8Array(W*H);
  for(let i=0,p=0;i<data.length;i+=4,p++) gray[p]=(data[i]*30+data[i+1]*59+data[i+2]*11)/100;

  const integral=new Float64Array((W+1)*(H+1));
  const edgeInt=new Float64Array((W+1)*(H+1));
  const darkInt=new Float64Array((W+1)*(H+1));

  for(let y=1;y<=H;y++){
    let row=0,erow=0,drow=0;
    for(let x=1;x<=W;x++){
      const i=(y-1)*W+(x-1),g=gray[i];
      row+=g;
      const gx=x<W?Math.abs(g-gray[i+1]):0;
      const gy=y<H?Math.abs(g-gray[i+W]):0;
      erow+=gx+gy;
      drow+=(g<105?1:0);
      integral[y*(W+1)+x]=integral[(y-1)*(W+1)+x]+row;
      edgeInt[y*(W+1)+x]=edgeInt[(y-1)*(W+1)+x]+erow;
      darkInt[y*(W+1)+x]=darkInt[(y-1)*(W+1)+x]+drow;
    }
  }

  const sum=(arr,x,y,w,h)=>arr[(y+h)*(W+1)+(x+w)]-arr[y*(W+1)+(x+w)]-arr[(y+h)*(W+1)+x]+arr[y*(W+1)+x];

  const raw=[];
  const widths=[42,50,60,72,84];
  const ratios=[3.2,3.6,4.0,4.4,4.8];

  for(const ww of widths){
    for(const ar of ratios){
      const hh=Math.max(9,Math.round(ww/ar));
      if(hh>=H-4) continue;
      for(let y=2;y<=H-hh-2;y+=4){
        for(let x=2;x<=W-ww-2;x+=5){
          const area=ww*hh;
          const mean=sum(integral,x,y,ww,hh)/area;
          const edge=sum(edgeInt,x,y,ww,hh)/area;
          const dark=sum(darkInt,x,y,ww,hh)/area;
          const centerBias=1-Math.abs((x+ww/2)-W/2)/(W/2);
          const brightFit=1-Math.min(1,Math.abs(mean-155)/80);
          const darkFit=1-Math.min(1,Math.abs(dark-.30)/.30);

          // Kennzeichen sind typischerweise relativ hell, horizontal,
          // mit vielen dunklen Zeichenkanten auf heller Fläche.
          const score=edge*.85 + brightFit*18 + darkFit*14 + centerBias*5;

          if(
            mean>95 && mean<225 &&
            edge>30 &&
            dark>.12 && dark<.58 &&
            score>47
          ){
            raw.push({x,y,w:ww,h:hh,score});
          }
        }
      }
    }
  }

  raw.sort((a,b)=>b.score-a.score);
  const kept=[];
  for(const candidate of raw){
    const normalized={x:candidate.x/W,y:candidate.y/H,w:candidate.w/W,h:candidate.h/H};
    if(kept.some(k=>iou(normalized,k.normalized)>.26)) continue;
    kept.push({...candidate,normalized});
    if(kept.length>=2) break;
  }

  return kept.map(k=>{
    const padX=k.w*.10,padY=k.h*.30;
    return {
      x:sx+(k.x-padX)/W*sw,
      y:sy+(k.y-padY)/H*sh,
      w:(k.w+2*padX)/W*sw,
      h:(k.h+2*padY)/H*sh,
      score:k.score
    };
  });
}

function updateTracks(detections){
  const now=Date.now();
  const unmatched=new Set(detections.map((_,i)=>i));

  for(const t of tracks){
    let bestI=-1,bestScore=0;
    detections.forEach((d,i)=>{
      if(!unmatched.has(i)) return;
      const score=iou(t.box,d);
      if(score>bestScore){bestScore=score;bestI=i;}
    });
    if(bestI>=0 && bestScore>.18){
      const d=detections[bestI];
      t.box=smoothBox(t.box,d);
      t.lastSeen=now;
      t.detectorScore=d.score;
      t.seenCount=(t.seenCount||1)+1;
      unmatched.delete(bestI);
    }
  }

  for(const i of unmatched){
    const d=detections[i];
    tracks.push({
      id:nextTrackId++, box:{...d}, lastSeen:now, detectorScore:d.score,
      state:'pending', label:'', history:[], lastOcrAt:0, greenUntil:0, redUntil:0,
      seenCount:1
    });
  }

  tracks.sort((a,b)=>(b.seenCount||0)-(a.seenCount||0) || b.detectorScore-a.detectorScore);
  if(tracks.length>MAX_LIVE_TRACKS) tracks=tracks.slice(0,MAX_LIVE_TRACKS);
  renderTracks();
}

function detectionLoop(){
  if(!running) return;
  updateTracks(detectorCandidates());
  detectorTimer=setTimeout(detectionLoop,DETECT_INTERVAL);
}

function chooseTrack(){
  const now=Date.now();
  const live=tracks.filter(t=>now-t.lastSeen<550 && (t.seenCount||0)>=YELLOW_CONFIRMATIONS);
  if(!live.length) return null;
  live.sort((a,b)=>{
    const overdueA=now-a.lastOcrAt;
    const overdueB=now-b.lastOcrAt;
    return (overdueB-overdueA) || (b.detectorScore-a.detectorScore);
  });
  return live[0];
}

function cropTrack(track,variant='gray'){
  const b=track.box;
  const vw=els.video.videoWidth,vh=els.video.videoHeight;
  const padX=b.w*.16,padY=b.h*.38;
  const x=clamp(b.x-padX,0,vw-1), y=clamp(b.y-padY,0,vh-1);
  const w=clamp(b.w+2*padX,1,vw-x), h=clamp(b.h+2*padY,1,vh-y);

  const maxW=1000, scale=Math.min(1.5,maxW/w);
  els.canvas.width=Math.max(1,Math.round(w*scale));
  els.canvas.height=Math.max(1,Math.round(h*scale));
  const ctx=els.canvas.getContext('2d',{willReadFrequently:true});

  ctx.filter='grayscale(1) contrast(1.55) brightness(1.05)';
  ctx.drawImage(els.video,x,y,w,h,0,0,els.canvas.width,els.canvas.height);
  ctx.filter='none';

  if(variant==='binary'){
    const im=ctx.getImageData(0,0,els.canvas.width,els.canvas.height);
    const d=im.data;
    let mean=0;
    for(let i=0;i<d.length;i+=4) mean+=d[i];
    mean/=d.length/4;
    const threshold=clamp(mean*.92,85,175);
    for(let i=0;i<d.length;i+=4){
      const v=d[i]>threshold?255:0;
      d[i]=d[i+1]=d[i+2]=v;
    }
    ctx.putImageData(im,0,0);
  }
  return els.canvas;
}

function collectTexts(data){
  const out=[];
  const push=(text,confidence)=>{const n=normalize(text);if(n)out.push({text,n,confidence:Number(confidence)||0});};
  if(Array.isArray(data.words)) for(const w of data.words) push(w.text,w.confidence||data.confidence);
  for(const b of data.blocks||[]) for(const p of b.paragraphs||[]) for(const l of p.lines||[]){
    push(l.text,l.confidence||data.confidence);
    for(const w of l.words||[]) push(w.text,w.confidence||data.confidence);
  }
  if(data.text) push(data.text,data.confidence);
  return out;
}

function scoreRead(item){
  const n=item.n;
  let q=item.confidence+germanPlatePlausibility(n);
  if(n.length>=5&&n.length<=9) q+=8;
  if(/[A-Z]{1,5}\d{1,4}/.test(n)) q+=6;
  const bm=bestTargetMatch(n);
  if(bm && bm.similarity>=80) q+=(bm.similarity-80)*.6;
  return {...item,quality:q};
}

function bestRead(data){
  const items=collectTexts(data).map(scoreRead).sort((a,b)=>b.quality-a.quality);
  return items[0]||null;
}

function canonicalAgainstTarget(read){
  const n=normalize(read);
  const bm=bestTargetMatch(n);
  if(!bm) return n;
  if(bm.similarity>=88 && Math.abs(n.length-bm.target.norm.length)<=1){
    let rebuilt='';
    const t=bm.target.norm;
    const c=bm.value.padEnd(t.length,'?');
    for(let i=0;i<t.length;i++){
      const ci=c[i],ti=t[i];
      rebuilt += (ci===ti || confusionCost(ci,ti)<=.35) ? ti : (ci||ti);
    }
    return rebuilt;
  }
  return n;
}

function addHistory(track,value,confidence){
  const now=Date.now();
  const canonical=canonicalAgainstTarget(value);
  track.history.push({value:canonical,raw:normalize(value),confidence,time:now});
  track.history=track.history.filter(x=>now-x.time<HISTORY_TTL).slice(-6);
}

function consensus(track){
  const h=track.history;
  if(!h.length) return null;
  const groups=[];
  for(const item of h){
    let g=groups.find(x=>weightedDistance(x.value,item.value)<=.45);
    if(!g){
      g={value:item.value,count:0,confidence:0,last:0};
      groups.push(g);
    }
    g.count++;
    g.confidence+=item.confidence;
    g.last=Math.max(g.last,item.time);
  }
  groups.sort((a,b)=>b.count-a.count || b.confidence-a.confidence || b.last-a.last);
  return groups[0];
}

function confirmedTarget(track){
  const recent=track.history.slice(-4);
  const votes=new Map();
  for(const item of recent){
    const bm=bestTargetMatch(item.value);
    if(!bm) continue;
    const allowed=els.tolerant.checked ? 1.05 : .40;
    if(bm.distance<=allowed){
      const key=bm.target.norm;
      const entry=votes.get(key)||{target:bm.target,count:0,bestSimilarity:0};
      entry.count++;
      entry.bestSimilarity=Math.max(entry.bestSimilarity,bm.similarity);
      votes.set(key,entry);
    }
  }
  return [...votes.values()].sort((a,b)=>b.count-a.count || b.bestSimilarity-a.bestSimilarity)[0]||null;
}

async function initWorker(){
  if(worker) return;
  if(!window.Tesseract) throw new Error('OCR konnte nicht geladen werden. Für den ersten Start ist Internet erforderlich.');
  setStatus('OCR lädt …','busy');
  worker=await Tesseract.createWorker('eng',1,{
    logger:m=>{
      if(m.status==='recognizing text'&&typeof m.progress==='number'){
        setStatus(`OCR ${Math.round(m.progress*100)} %`,'busy');
      }
    }
  });
  await worker.setParameters({
    tessedit_char_whitelist:'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789',
    tessedit_pageseg_mode:'7',
    preserve_interword_spaces:'0'
  });
}

async function recognizeVariant(track,variant){
  const canvas=cropTrack(track,variant);
  const result=await worker.recognize(canvas,{}, {blocks:true,text:true});
  return bestRead(result.data);
}

async function scanOnce(){
  if(!running||busy) return;
  const track=chooseTrack();
  if(!track){
    scanTimer=setTimeout(scanOnce,Math.max(180,Number(els.interval.value)));
    return;
  }

  busy=true;
  const started=performance.now();
  track.lastOcrAt=Date.now();

  try{
    let read=await recognizeVariant(track,'gray');
    if(!read || read.confidence<Number(els.confidence.value) || germanPlatePlausibility(read.n)<20){
      const alt=await recognizeVariant(track,'binary');
      if(alt && (!read || alt.quality>read.quality)) read=alt;
    }

    scans++;
    els.scanCount.textContent=String(scans);
    els.ocrTime.textContent=`${Math.round(performance.now()-started)} ms`;

    if(!read || read.confidence<Math.max(30,Number(els.confidence.value)-12)){
      els.confirmCount.textContent='0';
      setStatus('Scan aktiv','active');
      return;
    }

    addHistory(track,read.n,read.confidence);
    const c=consensus(track);
    els.confirmCount.textContent=c?String(c.count):'0';

    if(!c){
      setStatus('Scan aktiv','active');
      return;
    }

    const label=displayPlate(c.value);
    els.lastOcr.textContent=label;
    const bm=bestTargetMatch(c.value);
    els.closest.textContent=bm?bm.target.raw:'—';
    els.similarity.textContent=bm?`${bm.similarity} %`:'—';

    if(c.count>=GREEN_CONFIRMATIONS){
      track.state='green';
      track.label=label;
      track.greenUntil=Date.now()+1800;
      addLogThrottled(`read-${track.id}-${c.value}`,'read',label,`${c.count} Frames bestätigt`);
    }

    const targetVote=confirmedTarget(track);
    if(targetVote && targetVote.count>=RED_CONFIRMATIONS){
      track.state='red';
      track.label=targetVote.target.raw;
      track.redUntil=Date.now()+3200;
      setStatus('TREFFER','hit');
      showBanner(targetVote.target.raw);

      const now=Date.now();
      if(now-lastHitAt>4500){
        lastHitAt=now;
        hits++;
        els.hitCount.textContent=String(hits);
        addLog('hit',targetVote.target.raw,`${targetVote.count} Frames bestätigt`);
        await alarm();
      }
    } else {
      setStatus('Scan aktiv','active');
    }

    renderTracks();
  } catch(e){
    console.warn(e);
    setStatus('Scan aktiv','active');
  } finally {
    busy=false;
    if(running) scanTimer=setTimeout(scanOnce,Number(els.interval.value));
  }
}

async function ensureAudio(){
  if(!audioCtx) audioCtx=new (window.AudioContext||window.webkitAudioContext)();
  if(audioCtx.state==='suspended') await audioCtx.resume();
}

async function alarm(){
  await ensureAudio();
  const now=audioCtx.currentTime;
  [0,.34,.68].forEach(o=>{
    const osc=audioCtx.createOscillator(),g=audioCtx.createGain();
    osc.type='square'; osc.frequency.value=1050;
    g.gain.setValueAtTime(.0001,now+o);
    g.gain.exponentialRampToValueAtTime(.45,now+o+.015);
    g.gain.exponentialRampToValueAtTime(.0001,now+o+.22);
    osc.connect(g).connect(audioCtx.destination);
    osc.start(now+o); osc.stop(now+o+.25);
  });
  if(navigator.vibrate) navigator.vibrate([220,100,220,100,450]);
}

function showBanner(plate){
  els.banner.hidden=false;
  els.bannerType.textContent='TREFFER!';
  els.bannerText.textContent=plate;
  clearTimeout(showBanner.t);
  showBanner.t=setTimeout(()=>{
    els.banner.hidden=true;
    if(running)setStatus('Scan aktiv','active');
  },3200);
}

async function wake(){
  if(!els.wake.checked||!navigator.wakeLock)return;
  try{wakeLock=await navigator.wakeLock.request('screen')}catch(_){wakeLock=null}
}
async function releaseWake(){try{await wakeLock?.release()}catch(_){} wakeLock=null;}

async function start(){
  error();
  if(!targets().length){error('Bitte mindestens ein Zielkennzeichen eintragen.');return}
  try{
    await ensureAudio();
    await initWorker();
    setStatus('Kamera startet …','busy');
    stream=await navigator.mediaDevices.getUserMedia({
      video:{facingMode:{ideal:'environment'},width:{ideal:1920},height:{ideal:1080}},
      audio:false
    });
    els.video.srcObject=stream;

    // iOS/PWA: wait until the stream has real dimensions before showing scan view.
    if (els.video.readyState < 1 || !els.video.videoWidth) {
      await new Promise((resolve, reject) => {
        const timeout=setTimeout(()=>reject(new Error('Kamerabild wurde nicht bereitgestellt.')),5000);
        const ready=()=>{clearTimeout(timeout);els.video.removeEventListener('loadedmetadata',ready);resolve();};
        els.video.addEventListener('loadedmetadata',ready,{once:true});
      });
    }

    els.video.muted=true;
    els.video.playsInline=true;
    els.video.setAttribute('playsinline','');
    els.video.setAttribute('webkit-playsinline','');
    await els.video.play();

    running=true;
    tracks=[];
    els.video.hidden=false;
    els.video.style.display='block';
    els.video.style.visibility='visible';
    els.video.style.opacity='1';
    els.placeholder.hidden=true;
    els.placeholder.style.display='none';
    els.stage.classList.add('camera-live');
    els.start.disabled=true;
    els.stop.disabled=false;
    showView('scanView');
    setStatus('Scan aktiv','active');
    await wake();
    detectionLoop();
    scanOnce();
  }catch(e){
    error(`Start fehlgeschlagen: ${e.message||e}`);
    setStatus('Fehler','hit');
    await stop(false);
    showView('setupView');
  }
}

async function stop(back=true){
  running=false;
  clearTimeout(scanTimer); clearTimeout(detectorTimer);
  scanTimer=detectorTimer=null; busy=false;
  stream?.getTracks().forEach(t=>t.stop());
  stream=null; els.video.srcObject=null;
  els.stage.classList.remove('camera-live');
  els.placeholder.hidden=false;
  els.placeholder.style.display='';
  els.start.disabled=false; els.stop.disabled=true;
  tracks=[]; els.overlay.innerHTML=''; els.banner.hidden=true;
  await releaseWake();
  setStatus('Bereit','idle');
  if(back) showView('setupView');
  if(pendingReload) location.reload();
}

function logs(){try{return JSON.parse(localStorage.getItem(LOG_KEY)||'[]')}catch(_){return[]}}
function addLog(kind,plate,note){
  const l=logs();
  l.unshift({kind,plate,note,time:Date.now()});
  localStorage.setItem(LOG_KEY,JSON.stringify(l.slice(0,120)));
}
const logThrottle=new Map();
function addLogThrottled(key,kind,plate,note){
  const now=Date.now();
  if(now-(logThrottle.get(key)||0)<5000) return;
  logThrottle.set(key,now);
  addLog(kind,plate,note);
}
function renderLog(){
  const l=logs();
  if(!l.length){els.log.innerHTML='<div class="empty-log">Noch keine Ereignisse.</div>';return}
  els.log.innerHTML=l.map(x=>`<div class="log-item ${x.kind}"><div><div class="kind">${
    x.kind==='hit'?'TREFFER':x.kind==='read'?'BESTÄTIGT':'ERKANNT'
  }</div><strong>${escapeHtml(x.plate)}</strong><small>${escapeHtml(x.note)}</small></div><small>${
    new Date(x.time).toLocaleString('de-DE')
  }</small></div>`).join('');
}
function escapeHtml(s){
  return String(s).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#039;'}[c]));
}

els.targets.addEventListener('input',updateTargetCount);
els.start.addEventListener('click',start);
els.stop.addEventListener('click',()=>stop(true));
els.testAlarm.addEventListener('click',async()=>{
  const t=targets()[0];
  if(t){
    showView('scanView'); showBanner(t.raw); setStatus('TREFFER','hit'); await alarm();
    setTimeout(()=>{if(!running){setStatus('Bereit','idle');showView('setupView')}},2200);
  }
});
els.clearLog.addEventListener('click',()=>{localStorage.removeItem(LOG_KEY);renderLog()});
document.querySelectorAll('.tab-button').forEach(b=>b.addEventListener('click',()=>showView(b.dataset.view)));
document.addEventListener('visibilitychange',async()=>{if(document.visibilityState==='visible'&&running)await wake()});
window.addEventListener('pagehide',()=>{if(running)stream?.getTracks().forEach(t=>t.stop())});

async function initServiceWorker(){
  if(!('serviceWorker'in navigator)) return;
  let reloading=false;
  navigator.serviceWorker.addEventListener('controllerchange',()=>{
    if(reloading)return;
    if(running){pendingReload=true;return}
    reloading=true; location.reload();
  });
  try{
    const reg=await navigator.serviceWorker.register('./sw.js?v=92',{updateViaCache:'none'});
    setTimeout(()=>reg.update().catch(()=>{}),1500);
    setInterval(()=>reg.update().catch(()=>{}),120000);
  }catch(e){console.warn('service worker',e)}
}

const saved=localStorage.getItem(TARGET_KEY) ||
            localStorage.getItem('plateTargetsV8') ||
            localStorage.getItem('plateTargets');
if(saved) els.targets.value=saved;
updateTargetCount(); renderLog(); initServiceWorker();
})();