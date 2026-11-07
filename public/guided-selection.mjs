import {decodeImage} from './render.mjs';
import {DEFAULT_OBJECT_COLOR,drawRegionOverlay,regionMaskInfo,validateDetectionResult} from './object-regions.mjs';
import {layerPointToDocument} from './layer-transform.mjs';
import {guidedMarkTarget,guidedWorkingCopy,mapGuidedResult,manualGuidedResult} from './guided-detection.mjs';
import {createGroupedSelection} from './grouped-selection.mjs';

// A proposed selection is a disposable draft until the user confirms its number.
export function createGuidedSelection({getProject,getSelected,canRun,onConfirm,onError,onChange}) {
  const $=id=>document.getElementById(id),dialog=$('guidedDetectionDialog');
  const group=createGroupedSelection({getProject,getSelected,canRun,onConfirm,onError,onChange});
  let session=null,availability=null;
  function available(){
    const project=getProject(),id=getSelected();
    if(availability?.project===project&&availability.id===id)return availability.value;
    let value=false;try{value=Boolean(guidedMarkTarget(project,id));}catch{}
    availability={project,id,value};return value;
  }
  function current(draft){return session===draft&&dialog.open&&getProject()===draft.project;}
  function clear(){session?.abort.abort();session=null;onChange?.();}
  function close(){group.close();if(dialog.open)dialog.close();clear();}
  function sync(){
    if(group.active){group.sync();return;}
    $('guidedGroupList').hidden=true;$('guidedDetectionTitle').textContent='Detect marked area';
    $('guidedDetectionNote').textContent='Check the proposed selection before numbering it. Your pencil or highlight stays editable.';
    $('useMarkedArea').textContent='Use marked area';$('confirmGuidedDetection').textContent='Number this area';
    if(session&&getProject()!==session.project){close();return;}
    $('useMarkedArea').disabled=!session?.manualResult||!session?.image;
    $('guidedCandidateChoice').disabled=!session?.result?.regions.length||session.running;
    $('confirmGuidedDetection').disabled=!session?.result?.regions.length||session.running;
    $('guidedCandidateField').hidden=!session?.result?.regions.length;
    $('guidedDetectionPreview').setAttribute('aria-busy',String(Boolean(session?.running)));
  }
  function render(draft){
    if(!current(draft)||!draft.image)return;
    const canvas=$('guidedDetectionPreview'),context=canvas.getContext('2d');
    canvas.width=draft.working.request.width;canvas.height=draft.working.request.height;
    context.drawImage(draft.image,0,0,canvas.width,canvas.height);
    const region=draft.result?.regions[draft.index];
    canvas.dataset.candidateId=region?.id||'';canvas.dataset.selectionMode=draft.manual?'manual':'detected';
    if(region){
      const {crop,fullWidth,fullHeight}=draft.working,sx=canvas.width/crop.width,sy=canvas.height/crop.height;
      drawRegionOverlay(context,region.mask,{x:-crop.x*sx,y:-crop.y*sy,width:fullWidth*sx,height:fullHeight*sy},{color:DEFAULT_OBJECT_COLOR,fillOpacity:.19,lineWidth:2});
    }
    else {
      const [x0,y0,x1,y1]=draft.working.request.prompt.box;
      context.strokeStyle=DEFAULT_OBJECT_COLOR;context.lineWidth=2;context.setLineDash([6,4]);context.strokeRect(x0,y0,x1-x0,y1-y0);context.setLineDash([]);
    }
    canvas.hidden=false;sync();
  }
  function setResult(draft,result,manual=false){
    // Offer the same canonical full-image mask that will be saved. Mapping can
    // merge candidates and expand very thin pixels on the bounded mask grid.
    draft.result=mapGuidedResult(validateDetectionResult(result),draft.working);draft.index=0;draft.manual=manual;
    const select=$('guidedCandidateChoice');select.replaceChildren();
    draft.result.regions.forEach((region,index)=>{
      const option=document.createElement('option');option.value=String(index);option.textContent=manual?'Manual marked area':`Selection ${index+1}`;select.append(option);
    });
    select.value='0';render(draft);
  }
  async function run(){
    if(session||group.active||!canRun())return;
    if(group.count()>1){await group.run();return;}
    if(!available()){onError(getProject().sketch?'Highlight a subject on your sketch first, then detect the marked area.':'Select a visible pencil or highlight mark over an image first.');return;}
    const draft={project:getProject(),markId:getSelected(),abort:new AbortController(),working:null,image:null,result:null,index:0,manual:false,running:true};
    session=draft;$('guidedDetectionStatus').textContent=draft.project.sketch?'Preparing your sketch beneath the highlight…':'Preparing the original image beneath your mark…';
    $('guidedDetectionError').textContent='';$('guidedDetectionPreview').hidden=true;$('guidedCandidateChoice').replaceChildren();
    dialog.showModal();sync();onChange?.();
    try {
      draft.working=await guidedWorkingCopy(draft.project,draft.markId);
      if(!current(draft))return;
      draft.manualResult=manualGuidedResult(draft.working);
      draft.image=await decodeImage(draft.working.request.source);
      if(!current(draft))return;
      render(draft);$('guidedDetectionStatus').textContent='Finding this area on your computer… You can also use your marked area.';
      const signal=draft.abort.signal,statusResponse=await fetch('/api/local-detection/status',{signal});
      if(!statusResponse.ok)throw new Error('Local detection is unavailable. Use marked area to continue.');
      const status=await statusResponse.json();
      if(!status.available)throw new Error(status.message||'Local SAM 2 is unavailable. Use marked area to continue.');
      if(status.busy)throw new Error('The detector is still running. Use marked area, or cancel and try again shortly.');
      const response=await fetch('/api/local-detection',{method:'POST',headers:{'Content-Type':'application/json','X-Asun-Detection-Token':status.token},body:JSON.stringify(draft.working.request),signal});
      const result=await response.json();
      if(!current(draft)||draft.manual)return;
      if(!response.ok)throw new Error(result.error||result.message||'Local guided detection failed.');
      const validated=validateDetectionResult(result);
      if(validated.width!==draft.working.request.width||validated.height!==draft.working.request.height)throw new Error('The detector returned a selection for a different image size.');
      draft.running=false;setResult(draft,validated);
      $('guidedDetectionStatus').textContent=validated.regions.length?'Check the selection. Choose another result or use your marked area, then number it.':'No clear selection found. Use marked area to number your manual selection.';
    } catch(error) {
      if(current(draft)&&!draft.manual&&error.name!=='AbortError'){
        $('guidedDetectionError').textContent=error.message||'Guided detection failed.';
        $('guidedDetectionStatus').textContent=draft.working?'Your mark is unchanged. Use marked area to continue manually.':'Your mark is unchanged. Cancel and select a mark over an image.';
      }
    } finally {
      if(current(draft)){draft.running=false;sync();onChange?.();}
    }
  }
  $('guidedCandidateChoice').onchange=()=>{if(!session?.result)return;const index=Number($('guidedCandidateChoice').value);if(Number.isInteger(index)&&session.result.regions[index]){session.index=index;render(session);}};
  $('useMarkedArea').onclick=()=>{
    if(group.active){group.useMarked();return;}
    const draft=session;if(!draft?.working||!draft.manualResult||!current(draft))return;
    draft.abort.abort();draft.running=false;$('guidedDetectionError').textContent='';
    setResult(draft,draft.manualResult,true);$('guidedDetectionStatus').textContent='Manual marked area. Number this area to keep this selection with references or a comment.';
  };
  $('confirmGuidedDetection').onclick=()=>{
    if(group.active){group.confirm();return;}
    const draft=session;if(!draft?.result||draft.running||!current(draft))return;
    try {
      const chosen=draft.result.regions[draft.index];if(!chosen)return;
      const mapped=draft.result,region=chosen;
      if(!region)throw new Error('This selection is too small. Try a larger mark.');
      const [x,y,width,height]=regionMaskInfo(region.mask).bbox;
      const raster=draft.project.layers.find(item=>item.id===draft.working.rasterId),asset=draft.project.assets[draft.working.assetId];
      const point=layerPointToDocument(raster,{x:(x+width/2)*raster.width/mapped.width,y:(y+height/2)*raster.height/mapped.height});
      // Close first so the normal reference/comment editor can open as the next step.
      const confirmed={project:draft.project,raster,asset,mask:region.mask,point,manual:draft.manual,markIds:[draft.markId]};
      close();onConfirm(confirmed);
    }catch(error){if(current(draft))$('guidedDetectionError').textContent=error.message;else onError(error.message);}
  };
  for(const id of ['cancelGuidedDetection','closeGuidedDetection'])$(id).onclick=close;
  dialog.addEventListener('close',()=>{if(!dialog.open)clear();});
  return {run,sync,available,close,count:group.count,get active(){return Boolean(session)||group.active;}};
}
