import {decodeImage} from './render.mjs';
import {drawRegionOverlay,MAX_REGION_SIDE,validateDetectionResult} from './object-regions.mjs';
import {guidedWorkingCopy,mapGuidedResult,manualGuidedResult} from './guided-detection.mjs';
import {guidedMarkTargets,unionRegionMasks,regionInteriorPoint} from './guided-group.mjs';
import {sketchWorkingCopy} from './sketch-detection.mjs';
import {layerPointToDocument} from './layer-transform.mjs';

// Each mark gets its own clean crop and SAM prompt. Only explicitly accepted
// masks are combined; the space between disconnected objects stays unselected.
export function createGroupedSelection({getProject,getSelected,canRun,onConfirm,onError,onChange}) {
  const $=id=>document.getElementById(id),dialog=$('guidedDetectionDialog');
  const colors=['#ffb347','#72d7ff','#b9ef88','#eea2ff','#ff9d99','#99aaff'];
  let session=null;
  const current=draft=>session===draft&&dialog.open&&getProject()===draft.project;
  const chosen=entry=>entry.manual?entry.manualRegion:entry.result?.regions[entry.index];
  const included=draft=>draft.entries.filter(entry=>entry.include);
  function count(){try{return guidedMarkTargets(getProject(),getSelected()).length;}catch{return 0;}}
  function clear(){if(!session)return;session.abort.abort();session=null;onChange?.();}
  function close(){if(!session)return;clear();if(dialog.open)dialog.close();}
  function sync(){
    const draft=session;if(!draft)return;
    if(!current(draft)){close();return;}
    const entries=included(draft),ready=entries.length&&entries.every(entry=>chosen(entry));
    $('guidedCandidateField').hidden=true;$('guidedGroupList').hidden=false;
    $('guidedDetectionTitle').textContent='Detect highlighted objects';
    $('guidedDetectionNote').textContent='Highlight across each whole object. Each highlight is detected separately. Keep the areas you want, then give the group one set of references.';
    $('confirmGuidedDetection').textContent=`Number group${entries.length?' · '+entries.length+' areas':''}`;
    $('confirmGuidedDetection').disabled=Boolean(draft.running||!ready);
    $('useMarkedArea').textContent='Use all highlights manually';
    $('useMarkedArea').disabled=!entries.length||!entries.every(entry=>entry.manualRegion);
    $('guidedDetectionPreview').setAttribute('aria-busy',String(draft.running));
    for(const entry of draft.entries){
      if(!entry.ui)continue;
      entry.ui.include.checked=entry.include;
      entry.ui.select.disabled=draft.running||!entry.include||!entry.result?.regions.length;
      entry.ui.select.value=entry.manual?'manual':String(entry.index);
      entry.ui.manual.disabled=draft.running||!entry.include||!entry.manualRegion;
      entry.ui.status.textContent=!entry.include?'Excluded from this group':entry.manual?'Manual highlight — not AI detected':entry.error||entry.status;
      entry.ui.row.dataset.state=!entry.include?'excluded':entry.manual?'manual':entry.error?'error':entry.result?.regions.length?'ready':'pending';
    }
  }
  function render(draft){
    if(!current(draft)||!draft.image)return;
    const canvas=$('guidedDetectionPreview'),ctx=canvas.getContext('2d');
    canvas.width=draft.width;canvas.height=draft.height;ctx.drawImage(draft.image,0,0,canvas.width,canvas.height);
    for(const [i,entry] of draft.entries.entries()){
      if(!entry.include)continue;
      const region=chosen(entry),color=colors[i%colors.length];
      if(region){
        drawRegionOverlay(ctx,region.mask,{x:0,y:0,width:canvas.width,height:canvas.height},{color,fillOpacity:.24,lineWidth:2});
        const point=regionInteriorPoint(region.mask);ctx.fillStyle='#101820';ctx.beginPath();ctx.arc(point.x,point.y,12,0,Math.PI*2);ctx.fill();
        ctx.fillStyle=color;ctx.font='bold 15px Arial';ctx.textAlign='center';ctx.textBaseline='middle';ctx.fillText(String(i+1),point.x,point.y);
      } else {
        const [l,t,r,b]=entry.target.sourceBox,sx=canvas.width/entry.target.asset.width,sy=canvas.height/entry.target.asset.height;
        ctx.strokeStyle=color;ctx.lineWidth=2;ctx.setLineDash([6,4]);ctx.strokeRect(l*sx,t*sy,(r-l)*sx,(b-t)*sy);ctx.setLineDash([]);
      }
    }
    canvas.dataset.selectionMode='group';canvas.dataset.areaCount=String(included(draft).length);canvas.hidden=false;sync();
  }
  function buildRows(draft){
    const list=$('guidedGroupList');list.replaceChildren();
    draft.entries.forEach((entry,index)=>{
      const row=document.createElement('div');row.className='guided-group-row';row.dataset.markId=entry.target.mark.id;
      const label=document.createElement('label'),check=document.createElement('input');check.type='checkbox';check.checked=true;check.dataset.groupInclude='';
      check.setAttribute('aria-label',`Include highlight ${index+1}`);label.append(check,document.createTextNode(`Highlight ${index+1}`));
      const select=document.createElement('select');select.dataset.groupCandidate='';select.setAttribute('aria-label',`Selection for highlight ${index+1}`);
      select.append(new Option('Waiting for detection','0'));
      const manual=document.createElement('button');manual.type='button';manual.dataset.groupManual='';manual.textContent='Use highlight';manual.title='Use this exact highlight manually';
      const status=document.createElement('small');status.className='guided-group-status';status.setAttribute('role','status');
      row.append(label,select,manual,status);list.append(row);entry.ui={row,include:check,select,manual,status};
      check.onchange=()=>{if(current(draft)){entry.include=check.checked;render(draft);}};
      select.onchange=()=>{if(!current(draft))return;if(select.value==='manual'&&entry.manualRegion){entry.manual=true;render(draft);return;}const index=Number(select.value);if(entry.result?.regions[index]){entry.index=index;entry.manual=false;render(draft);}};
      manual.onclick=()=>{if(current(draft)&&!draft.running&&entry.manualRegion){entry.manual=true;ensureManualOption(entry);render(draft);}};
    });
  }
  function ensureManualOption(entry){if(![...entry.ui.select.options].some(option=>option.value==='manual'))entry.ui.select.append(new Option('Manual highlight','manual'));}
  async function run(){
    if(session||!canRun())return;
    const project=getProject(),targets=guidedMarkTargets(project,getSelected());if(targets.length<2)return;
    const draft={project,entries:targets.map(target=>({target,include:true,index:0,manual:false,status:'Preparing…'})),abort:new AbortController(),running:true};
    session=draft;$('guidedDetectionError').textContent='';$('guidedDetectionPreview').hidden=true;$('guidedDetectionStatus').textContent=`Preparing ${targets.length} highlighted areas…`;
    buildRows(draft);dialog.showModal();sync();onChange?.();
    try {
      const asset=targets[0].asset,scale=Math.min(1,MAX_REGION_SIDE/Math.max(asset.width,asset.height));
      draft.width=Math.max(1,Math.round(asset.width*scale));draft.height=Math.max(1,Math.round(asset.height*scale));
      draft.image=await decodeImage(project.sketch?(await sketchWorkingCopy(project,{maxSide:MAX_REGION_SIDE})).source:asset.source);
      if(!current(draft))return;
      for(const entry of draft.entries){
        entry.working=await guidedWorkingCopy(project,entry.target.mark.id);if(!current(draft))return;
        entry.manualRegion=mapGuidedResult(manualGuidedResult(entry.working),entry.working).regions[0];entry.status='Waiting for detection';
      }
      render(draft);
      const signal=draft.abort.signal,response=await fetch('/api/local-detection/status',{signal});
      if(!response.ok)throw new Error('Local detection is unavailable. Use the highlights manually or try again.');
      const status=await response.json();if(!current(draft)||signal.aborted)return;
      if(!status.available)throw new Error(status.message||'Local detection is unavailable.');
      if(status.busy)throw new Error('The detector is still running. Cancel and try again shortly, or use the highlights manually.');
      // The existing local GPU worker accepts one inference at a time.
      for(const [index,entry] of draft.entries.entries()){
        if(!current(draft)||signal.aborted)return;
        if(!entry.include){entry.status='Not detected';continue;}
        entry.status='Detecting…';$('guidedDetectionStatus').textContent=`Detecting highlight ${index+1} of ${draft.entries.length} on your computer…`;sync();
        try{
          const response=await fetch('/api/local-detection',{method:'POST',headers:{'Content-Type':'application/json','X-Asun-Detection-Token':status.token},body:JSON.stringify(entry.working.request),signal});
          const result=await response.json();if(!current(draft)||signal.aborted)return;
          if(!response.ok)throw new Error(result.error||result.message||'Detection failed for this highlight.');
          entry.result=mapGuidedResult(validateDetectionResult(result),entry.working);entry.index=0;
          if(!entry.result.regions.length)throw new Error('No selection found. Use highlight manually or exclude it.');
          entry.status='Detected — review the selection';entry.ui.select.replaceChildren(...entry.result.regions.map((_,i)=>new Option(`Selection ${i+1}`,String(i))));
        }catch(error){if(error.name==='AbortError')throw error;entry.error=error.message||'Detection failed.';}
        render(draft);
      }
      $('guidedDetectionStatus').textContent='Review every included area. References and instructions will apply to the whole group.';
    }catch(error){
      if(current(draft)&&error.name!=='AbortError'){
        $('guidedDetectionError').textContent=error.message||'Grouped detection failed.';
        for(const entry of draft.entries)if(!chosen(entry))entry.status='Not detected — use highlight manually or exclude it';
        $('guidedDetectionStatus').textContent='Your highlights are unchanged. Manual selections remain available.';
      }
    }finally{if(current(draft)){draft.running=false;render(draft);sync();onChange?.();}}
  }
  function useMarked(){
    const draft=session;if(!draft||!current(draft))return;const entries=included(draft);if(!entries.length||!entries.every(entry=>entry.manualRegion))return;
    draft.abort.abort();draft.running=false;for(const entry of entries){entry.manual=true;ensureManualOption(entry);}
    $('guidedDetectionError').textContent='';$('guidedDetectionStatus').textContent='Manual highlight selections. Review and number the group to share references.';render(draft);
  }
  function confirm(){
    const draft=session;if(!draft||!current(draft)||draft.running)return;
    try{
      const entries=included(draft);if(!entries.length||entries.some(entry=>!chosen(entry)))return;
      const mask=unionRegionMasks(entries.map(entry=>chosen(entry).mask)),raster=entries[0].target.raster,asset=entries[0].target.asset,p=regionInteriorPoint(mask);
      const hit={project:draft.project,raster,asset,mask,point:layerPointToDocument(raster,{x:p.x*raster.width/mask.width,y:p.y*raster.height/mask.height}),manual:entries.every(entry=>entry.manual),group:{areaCount:entries.length},markIds:entries.map(entry=>entry.target.mark.id)};
      close();onConfirm(hit);
    }catch(error){if(current(draft))$('guidedDetectionError').textContent=error.message;else onError(error.message);}
  }
  dialog.addEventListener('close',()=>{if(!dialog.open)clear();});
  return {run,sync,close,useMarked,confirm,count,get active(){return Boolean(session);}};
}
