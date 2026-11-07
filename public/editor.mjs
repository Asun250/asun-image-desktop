import {decorateReferenceIcons} from './reference-icons.mjs';
import {hasProjectContent,resetProject} from './project-reset.mjs';
import {canvasImageFitTarget,canvasImageFitChanges,fitCanvasToImage} from './canvas-fit.mjs';
import {newProject,dimensions,addRaster,addText,attachObjectRegion,updateText,addDrawing,layerSourceDimensions,updateLayer,reorderLayer,removeLayer,duplicateLayer,addReference,referenceLinks,linkReferences,labelComment,updateLabelComment,MAX_LABEL_COMMENT_LENGTH,updateReferenceAnnotations,updateReferenceNotes,MAX_REFERENCE_NOTE_LENGTH,referenceProject,removeReference,saveVariant,restoreVariant,serializeProject,parseProject,History} from './core.mjs';
import {decodeImage,renderProject,exportImage,clearImageCache,drawRasterRegionOverlay} from './render.mjs';
import {createColorWheel} from './color-wheel.mjs';
import {clipboardImageFiles,readClipboardImages} from './clipboard.mjs';
import {linkedReferences,linkedLabelComments,referenceBoardPages,exportReferenceBoard,exportReferenceBoards} from './reference-board.mjs';
import {createReferenceEditor} from './reference-editor.mjs';
import {zipReferencePages} from './reference-download.mjs';
import {referenceSearchUrl} from './reference-search.mjs';
import {cycleTool,createWheelStepper} from './wheel-controls.mjs';
import {readOriginalImage,previewSource,sourceFileInfo,clearPreviewCache} from './image-source.mjs';
import {captureDroppedImageFiles} from './image-import-validation.mjs';
import {sheetDropInput,sheetWebPhotoFile} from './sheet-photo-drop.mjs';
import {exportCompleteReferencePack} from './reference-pack.mjs';
import {createLocalDetection,detectionTarget} from './auto-detection.mjs';
import {DEFAULT_OBJECT_LABEL_SIZE,DEFAULT_OBJECT_COLOR,nextObjectNumber} from './object-regions.mjs';
import {createGuidedSelection} from './guided-selection.mjs';
import {createEditSummary} from './edit-summary.mjs';
import {mountDesktopSheetCreation} from './desktop-sheet.mjs';
import {mountDesktopImageGeneration} from './desktop-image-generation.mjs';
import {hasImageGenerationInstructions} from './image-generation-request.mjs';
import {isSketchProject,sketchSurfaceLayer} from './sketch-project.mjs';
import {createSketchProject,normalizeSketchSurface,mountSketchWorkspace} from './sketch-workspace.mjs';
import {mountMainImageSearch} from './main-image-search.mjs';
import {buildOutputProject,loadGenerationProject,loadGenerationRecord} from './generation-result-actions.mjs';
import {mountImageEditWorkspace} from './image-edit-workspace.mjs';
import {brushObjectSelection,selectionTarget} from './edit-selection.mjs';
import {eraseObjectRegions} from './object-erase.mjs';
import {objectRemovalRequest} from './object-removal-request.mjs';
import {documentPointToLayer,layerPointToDocument,layerCorners,normalizeRotation} from './layer-transform.mjs';
import {documentToView,viewToDocument,rotateView,fitRotatedView} from './view-transform.mjs';
import {mountRotationControls} from './rotation-controls.mjs';
import {mountGenerationQueue} from './generation-queue.mjs';
import {mountWorkflowTabs} from './workflow-tabs.mjs';
import {createWorkflowSessionStore} from './workflow-session-store.mjs';
import {encodeWorkspaceSession,decodeWorkspaceSession,cloneWorkflowData} from './workflow-session-codec.mjs';
import {cloneEditableData} from './editable-data.mjs';
import {mountComposerReferences} from './composer-references.mjs';
decorateReferenceIcons();
const $=id=>document.getElementById(id), copy=cloneEditableData;
const esc=value=>String(value).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
let project=newProject(),history=new History(project),selected=null,tool='move',dirty=false,busy=false,compare=false,space=false;
const desktopSheetListeners=new Set();
let desktopSheetEditor=null;
let sketchWorkspace=null,mainWorkspaceSession=null,sketchWorkspaceSession=null;
let mainImageSearch=null;
let composerReferences=null;
let imageEditWorkspace=null,imageEditActive=false,imageEditGeneration=null,rotationControls=null,generationQueue=null;
let workflowTabs=null,workflowStore=null,workflowEntries=[],activeWorkflowId=null,workflowReady=false,workflowRestoring=false,workflowSaveTimer=null,workflowSaveMessage='',workflowStorageBlocked=false,workflowSaving=false,workflowSaveAgain=false;
let workflowIdleSave=null,workflowViewTimer=null,workflowSignatureBefore=null,workflowRevision=0,workflowSavedRevision=-1;
let observedProject=null,projectRevision=0;
const workflowGenerationOwners={image:null,sheet:null};
let view={x:0,y:0,zoom:1,angle:0},gesture=null,crop=null,renderId=0,toastTimer,dialogSubmit=null,downloadLock=false,textDraft=null,copying=false;
let redrawFrame=null,redrawRunning=false,drawnProject=null,drawnTextId=null,drawnCompare=null;
const brushSettings={mask:70,erase:70,pencil:6,highlight:28,select:42,subtract:42};
const brushColors={pencil:"#eba76f",highlight:"#ffff00"};
const textDefaults={fontSize:36,color:'#eba76f'};
const stage=$('stage'),board=$('board'),canvas=$('canvas');
const imageEditOverlay=document.createElement('canvas');imageEditOverlay.id='imageEditSelectionOverlay';imageEditOverlay.hidden=true;board.append(imageEditOverlay);
const wheelTools=Array.from(document.querySelectorAll('.toolrail [data-tool]'),button=>button.dataset.tool),toolWheelStepper=createWheelStepper();
const layer=()=>project.layers.find(item=>item.id===selected);
let colorSession=null;
let referenceSession=null,referenceOpenTimer=null,referenceDragDepth=0,referenceExportSession=null;
const referenceEditor=createReferenceEditor($('referenceEditorHost'),{onExpand:expanded=>setReferencePhotoExpanded(expanded),onChange:annotations=>{const ref=activeReference();if(ref)ref.annotations=copy(annotations);},onError:error=>{$('referenceDialogError').textContent=error.message||String(error);}});
const textColorWheel=createColorWheel($('colorPicker'),{onPreview:previewTextColor,onApply:applyWheelColor,onCancel:cancelWheelColor});
const guidedSelection=createGuidedSelection({getProject:()=>project,getSelected:()=>selected,canRun:()=>!busy&&!localDetection.running&&!gesture&&!compare&&!document.querySelector('dialog[open]'),onConfirm:hit=>{if(project!==hit.project){toast('The project changed. Select your mark again.',true);return;}setTool('detect',false);numberObjectRegion(hit);},onError:message=>toast(message,true),onChange:()=>localDetection.sync()});
const editSummaryView=createEditSummary($('editSummaryPanel'),{onOpen:id=>{if(busy||gesture||document.querySelector('dialog[open]'))return;if(!finishText())return;clearReferenceOpen();hideImageMenu();selected=id;refresh();openReferenceDialog(id);},onError:error=>toast(error.message||String(error),true)});
const localDetection=createLocalDetection({getProject:()=>project,overlay:$('objectHover'),canHover:()=>tool==='detect'&&!busy&&!compare&&!space&&!gesture&&!textDraft&&!document.querySelector('dialog[open]')&&$('imageMenu').hidden,onChange:syncDetectionControls,onError:message=>toast(message,true)});
function syncDetectionControls(info){const visible=tool==='detect',marked=guidedSelection.available();guidedSelection.sync();const markCount=marked?guidedSelection.count():0;$('detectMarkedArea').querySelector('.guided-label-full').textContent=markCount>1?`Detect ${markCount} highlights`:'Detect marked area';$('detectMarkedArea').querySelector('.guided-label-compact').textContent=markCount>1?`Detect ${markCount} marks`:'Detect mark';$('detectMarkedArea').title=markCount>1?'Detect the highlighted objects separately, then share references with the group':'Use the selected pencil or highlight mark to guide local detection';$('autoDetect').hidden=marked&&!isSketchProject(project);$('detectMarkedArea').hidden=!marked;$('detectMarkedArea').disabled=busy||info.state==='running'||compare||guidedSelection.active;$('autoDetect').disabled=!detectionTarget(project)||busy;$('autoDetect').setAttribute('aria-busy',String(info.state==='running'));$('autoDetect').textContent=info.state==='running'?'Detecting…':'Auto detect';$('detectionStatus').hidden=!visible;$('detectionStatus').textContent=info.message;$('detectionStatus').title=info.message;$('detectionStatus').dataset.state=info.state;$('detectAgain').hidden=!visible||info.state!=='ready';$('detectAgain').disabled=busy||info.state==='running';if(imageEditWorkspace)syncImageEditWorkspace();}
function runDetection(force=false){if(busy||document.querySelector('dialog[open]'))return;if(!finishText())return;setTool('detect',false);localDetection.run(force);}
$('autoDetect').onclick=()=>!isSketchProject(project)&&guidedSelection.available()?guidedSelection.run():runDetection();$('detectMarkedArea').onclick=()=>guidedSelection.run();$('detectAgain').onclick=()=>runDetection(true);
function numberObjectRegion(hit){try{const p=hit.point,content=nextObjectNumber(project),fontSize=imageEditActive?Math.max(8,Math.min(45,Math.min(hit.raster.width,hit.raster.height)*.09)):hit.group?Math.max(18,Math.min(64,Math.min(hit.raster.width,hit.raster.height)*.09)):DEFAULT_OBJECT_LABEL_SIZE,metrics=measureText(content,fontSize),x=Math.max(0,Math.min(project.width-metrics.width,p.x-metrics.width/2)),y=Math.max(0,Math.min(project.height-metrics.height,p.y-metrics.height/2));const result=addText(project,{content,fontSize,color:DEFAULT_OBJECT_COLOR,fontFamily:'Arial',x,y,width:metrics.width,height:metrics.height});const objectRegion={version:1,assetId:hit.raster.assetId,rasterLayerId:hit.raster.id,sourceWidth:hit.asset.width,sourceHeight:hit.asset.height,mask:hit.mask,...(hit.group?{group:hit.group}:{})};let next=attachObjectRegion(result.project,result.layerId,objectRegion);if(hit.group){next=updateLayer(next,result.layerId,{name:`Group ${content} · ${hit.group.areaCount} areas`});next=updateLabelComment(next,result.layerId,`Apply the references and instructions to all ${hit.group.areaCount} selected areas in this group.`);for(const markId of hit.markIds||[])next=updateLayer(next,markId,{visible:false});}if(isSketchProject(project)&&!hit.group)for(const markId of hit.markIds||[])next=updateLayer(next,markId,{visible:false});selected=result.layerId;commit(next,hit.group?`Number group ${content} · ${hit.group.areaCount} areas`:(hit.manual?'Number marked area ':'Number detected object ')+content);if(imageEditActive){syncImageEditWorkspace();}else openReferenceDialog(selected);}catch(error){toast(error.message,true);}}
function selectDetectedObject(p){if(!insideBoard(p))return;const hit=localDetection.pick(p);if(!hit){if(!localDetection.running&&!localDetection.ready)runDetection();else if(!localDetection.running)toast('No region here. Try Alt+scroll, or draw a pencil/highlight mark and use Detect marked area.');return;}localDetection.clearHover();if(hit.label){selected=hit.label.id;if(imageEditActive)refresh();else openReferenceDialog(selected);return;}numberObjectRegion({...hit,point:p});}
function toast(message,error=false){clearTimeout(toastTimer);$('toast').textContent=message;$('toast').classList.toggle('error',error);$('toast').hidden=false;toastTimer=setTimeout(()=>$('toast').hidden=true,error?6500:3500);}
function setPreviewImage(image,asset){
  const token=Symbol();image.previewToken=token;image.dataset.imageRole='generated-preview';
  if(!asset){image.removeAttribute('src');return;}
  image.title=`Generated preview · original ${asset.width} × ${asset.height} px retained`;
  if(asset.preview?.source){image.src=asset.preview.source;return;}
  previewSource(asset).then(source=>{if(image.previewToken===token)image.src=source;}).catch(()=>{if(image.previewToken===token){image.removeAttribute('src');image.title='Preview unavailable. Original image remains stored in the project.';}});
}
function hasReferenceContent(snapshot=project){return linkedReferences(snapshot).length>0||linkedLabelComments(snapshot).length>0;}
function canExportReferencePack(snapshot=project){return Boolean(snapshot.original&&snapshot.assets[snapshot.original.assetId]&&(hasReferenceContent(snapshot)||snapshot.sceneConsistency?.enabled));}
function syncPackControls(){
  syncDeleteAllControls();
  const available=canExportReferencePack(),disabled=!available||busy||copying;
  for(const id of ['completeReferencePackTop','downloadCompleteReferencePack'])$(id).disabled=disabled;
  $('downloadCompleteReferencePackPages').disabled=busy||copying||!referenceExportSession||!canExportReferencePack(referenceExportSession.snapshot);
}
function modal(title,content,confirmText,submit){if(!finishText())return;finishGesture();hideImageMenu();if($('dialog').open)$('dialog').close();$('dialogTitle').textContent=title;$('dialogContent').innerHTML=content;$('dialogError').textContent='';$('confirmDialog').textContent=confirmText||'Continue';$('confirmDialog').hidden=!confirmText;$('confirmDialog').disabled=false;$('cancelDialog').textContent=confirmText?'Cancel':'Done';dialogSubmit=submit;$('dialog').showModal();}
$('dialogForm').addEventListener('submit',async event=>{event.preventDefault();if(!dialogSubmit||$('confirmDialog').disabled)return;$('confirmDialog').disabled=true;try{if(await dialogSubmit()!==false)$('dialog').close();}catch(error){$('dialogError').textContent=error.message;}finally{$('confirmDialog').disabled=false;}});
for(const id of ['cancelDialog','closeDialog'])$(id).onclick=()=>$('dialog').close();
function notifyDesktopState(){if(desktopSheetEditor)for(const listener of desktopSheetListeners)listener(desktopSheetEditor.state());if(workflowReady)renderWorkflowTabs();}
async function guarded(action){if(busy){toast('Please wait for the current file operation.');return;}busy=true;document.body.classList.add('busy');composerReferences?.sync();syncPackControls();syncCanvasFitControls();localDetection.sync();notifyDesktopState();try{await action();}catch(error){toast(error.message||'That operation could not be completed.',true);}finally{busy=false;document.body.classList.remove('busy');composerReferences?.sync();syncTextOptions();$('copyReferencesTop').disabled=!hasReferenceContent()||copying;syncPackControls();syncCanvasFitControls();localDetection.sync();if(referenceSession)syncReferencePreview();notifyDesktopState();}}
function syncDeleteAllControls(){const hasContent=hasProjectContent(project)||Boolean(textDraft&&$('textEditor').value)||$('prompt').value!==project.prompt;$('deleteAllLayers').disabled=!hasContent||busy||copying||Boolean(gesture)||Boolean(document.querySelector('dialog[open]'));}
function syncCanvasFitControls(){const target=canvasImageFitTarget(project,selected),needed=target&&canvasImageFitChanges(project,target.id);$('fitCanvasPhoto').hidden=!needed;$('fitCanvasPhoto').disabled=!needed||busy||Boolean(gesture)||Boolean(crop);$('fitCanvasPhoto').title=target?'Fit the canvas to '+project.assets[target.assetId].name+' at its original dimensions; annotations stay aligned. Content outside this photo frame is clipped.':'Select a photo to fit the canvas.';}
function commit(next,label){next=normalizeSketchSurface(next);if(history.commit(next,label)){project=history.project;dirty=true;}refresh();}
function syncPrompt(){if(project.prompt!==$('prompt').value)commit({...project,prompt:$('prompt').value},'Edit prompt');}
function refresh(){
  if(!layer()||selected===project.sketch?.surfaceLayerId)selected=null;
  sketchWorkspace?.sync(isSketchProject(project),tool);
  $('projectName').textContent=project.name;$('documentLabel').textContent=project.name;$('documentSize').textContent=`${project.width} × ${project.height} px`;
  document.title=`${project.name} — Asun IMG`;$('savedState').textContent=dirty?'Unsaved edits':'Local project';
  $('undo').disabled=!history.canUndo;$('redo').disabled=!history.canRedo;$('export').disabled=!project.layers.length;
  $('emptyState').hidden=project.layers.length>0||project.original!==null||['text','pencil','highlight'].includes(tool)||Boolean(textDraft);$('compare').disabled=!project.original;
  $('variantCount').textContent=project.variants.length;$('prompt').value=project.prompt;
  for(const id of ['layerUp','layerDown','duplicateLayer','deleteLayer'])$(id).disabled=!selected;
  $('layerProperties').disabled=!selected;$('editTextLayer').hidden=layer()?.kind!=='text';
  $('copyReferencesTop').disabled=!hasReferenceContent()||copying||busy;
  syncPackControls();localDetection.sync();
  renderLayers();renderProperties();renderHistory();renderReferences();editSummaryView.update(project,selected);updateView();redraw();
  notifyDesktopState();
  syncImageEditWorkspace();
  workflowChanged();
}

function editSelectedArea(){return layer()?.objectRegion&&layer().visible?layer():null;}
function syncImageEditWorkspace(){
  imageEditWorkspace?.sync({active:imageEditActive,busy:busy||Boolean(gesture)||localDetection.running,hasImage:Boolean(detectionTarget(project)),tool,brushSize:brushSettings[tool]||brushSettings.select,selectedId:editSelectedArea()?.id||null,
    areas:project.layers.filter(item=>item.objectRegion&&item.visible&&item.opacity>0).map(item=>({id:item.id,label:item.text.content,name:item.name,selected:item.id===selected})),generation:imageEditGeneration?.state()||{},message:$('detectionStatus').textContent});
  drawImageEditOverlay();
}
function drawImageEditOverlay(){
  const current=editSelectedArea(),stroke=gesture?.mode==='edit-selection'?gesture:null;
  imageEditOverlay.hidden=!imageEditActive||compare||(!current&&!stroke);if(imageEditOverlay.hidden){if(imageEditOverlay.width||imageEditOverlay.height){imageEditOverlay.width=0;imageEditOverlay.height=0;}return;}
  const scale=Math.min(1,1600/Math.max(project.width,project.height));
  imageEditOverlay.width=Math.max(1,Math.round(project.width*scale));imageEditOverlay.height=Math.max(1,Math.round(project.height*scale));
  imageEditOverlay.style.width=project.width+'px';imageEditOverlay.style.height=project.height+'px';
  const context=imageEditOverlay.getContext('2d');context.scale(imageEditOverlay.width/project.width,imageEditOverlay.height/project.height);
  if(current){const raster=project.layers.find(item=>item.id===current.objectRegion.rasterLayerId);if(raster)drawRasterRegionOverlay(context,project,raster,current.objectRegion.mask,{color:'#56d9cc',fillOpacity:.30,lineWidth:2});}
  if(stroke){context.save();context.beginPath();const corners=layerCorners(stroke.raster);context.moveTo(corners[0].x,corners[0].y);for(const corner of corners.slice(1))context.lineTo(corner.x,corner.y);context.closePath();context.clip();context.strokeStyle=stroke.subtract?'#ff806c':'#56d9cc';context.globalAlpha=.5;context.lineWidth=stroke.size;context.lineCap='round';context.lineJoin='round';context.beginPath();context.moveTo(...stroke.points[0]);for(const p of stroke.points.slice(1))context.lineTo(...p);if(stroke.points.length===1)context.lineTo(stroke.points[0][0]+.01,stroke.points[0][1]);context.stroke();context.restore();}
}
function finishEditSelection(current){
  try{
    const previous=current.labelId?current.before.layers.find(item=>item.id===current.labelId):null;
    const hit=brushObjectSelection(current.before,{rasterId:current.raster.id,mask:previous?.objectRegion.mask||null,points:current.points,size:current.size,mode:current.subtract?'subtract':'add'});
    if(!hit){if(previous){selected=null;commit(removeLayer(current.before,previous.id),'Clear painted selection');}else refresh();return;}
    if(previous){const region={...previous.objectRegion,mask:hit.mask};delete region.group;const next=attachObjectRegion(current.before,previous.id,region),position={x:Math.max(0,Math.min(project.width-previous.width,hit.point.x-previous.width/2)),y:Math.max(0,Math.min(project.height-previous.height,hit.point.y-previous.height/2))};commit(updateLayer(next,previous.id,position),current.subtract?'Subtract selection':'Refine selection');}
    else numberObjectRegion(hit);
  }catch(error){project=current.before;refresh();toast(error.message,true);}
}
function enterImageEditWorkspace({route=true}={}){
  checkDesktopSheetReady();if(isSketchProject(project))leaveSketchWorkspace({route:false});
  imageEditActive=true;compare=false;setTool('select',false);refresh();fit();if(route)sketchLocation(false);stage.focus();
}
function leaveImageEditWorkspace({route=true}={}){
  checkDesktopSheetReady();imageEditActive=false;setTool('move',false);refresh();fit();if(route)sketchLocation(false);stage.focus();
}
function eraseEditSelection(){
  checkDesktopSheetReady();const area=editSelectedArea();if(!area)throw new Error('Paint or select the object you want to erase first.');
  const next=eraseObjectRegions(project,[area.id]);selected=null;commit(next,'Erase selected object');localDetection.clearHover();toast('Selected pixels erased to transparency. Undo brings the object back.');
}
async function removeAndFillSelection(){
  checkDesktopSheetReady();const area=editSelectedArea();if(!area)throw new Error('Select an object before choosing Remove & fill.');
  await desktopImageGeneration.generate({prepareProject:snapshot=>objectRemovalRequest(snapshot,[area.id])});
}
function renderLayers(){const list=$('layerList');list.replaceChildren();if(!project.layers.length){list.innerHTML='<p class="panel-empty">Your layers will appear here.</p>';return;}
  for(const item of [...project.layers].reverse().filter(item=>item.id!==project.sketch?.surfaceLayerId)){
    const row=document.createElement('div');row.className=`layer-row ${item.id===selected?'selected':''} ${item.visible?'':'is-hidden'}`;row.dataset.id=item.id;row.tabIndex=0;row.draggable=true;row.setAttribute('role','option');row.setAttribute('aria-selected',String(item.id===selected));
    const visibility=document.createElement('button');visibility.className='visibility';visibility.innerHTML='<svg viewBox="0 0 24 24" aria-hidden="true"><use href="#ui-'+(item.visible?'eye':'eyeoff')+'"></use></svg>';visibility.title=`${item.visible?'Hide':'Show'} ${item.name}`;visibility.setAttribute('aria-label',visibility.title);visibility.onclick=event=>{event.stopPropagation();commit(updateLayer(project,item.id,{visible:!item.visible}),item.visible?'Hide layer':'Show layer');};
    const image=document.createElement(item.kind==='text'||item.kind==='drawing'?'span':'img');if(image.tagName==='IMG'){setPreviewImage(image,project.assets[item.assetId]);image.alt='';image.draggable=false;}else{image.className='annotation-thumb';image.textContent=item.kind==='text'?'T':item.drawing.mode==='highlight'?'▰':'✎';image.style.color=item.kind==='text'?item.text.color:item.drawing.color;}
    const info=document.createElement('span');info.className='layer-info';const title=document.createElement('span');title.className='layer-title';title.textContent=item.name;const detail=document.createElement('small');detail.textContent=`${Math.round(item.width)} × ${Math.round(item.height)}${item.mask.length?' · masked':''}${referenceLinks(item).length?' · '+referenceLinks(item).length+' linked photos':''}${labelComment(item).trim()?' · comment':''}`;info.append(title,detail);row.append(visibility,image,info);
    row.onclick=()=>{if(!finishText())return;selected=item.id;refresh();};row.ondblclick=()=>renameLayer(item.id);row.onkeydown=event=>{if(event.key==='Enter'){if(!finishText())return;selected=item.id;refresh();}};
    row.ondragstart=event=>event.dataTransfer.setData('application/x-asun-layer',item.id);row.ondragover=event=>{if([...event.dataTransfer.types].includes('application/x-asun-layer'))event.preventDefault();};row.ondrop=event=>{event.preventDefault();const id=event.dataTransfer.getData('application/x-asun-layer');if(id&&project.layers.some(l=>l.id===id))commit(reorderLayer(project,id,project.layers.findIndex(l=>l.id===item.id)),'Reorder layers');};list.append(row);
  }
}
function renderProperties(){syncTextOptions();const item=layer();$('transformPanel').hidden=!item;$('transformContext').textContent=item?item.name:'Select a layer';for(const [field,key]of Object.entries({layerX:'x',layerY:'y',layerW:'width',layerH:'height'}))$(field).value=item?Math.round(item[key]*10)/10:'';
  for(const field of ['opacity','brightness','contrast','saturation']){const value=item?(field==='opacity'?Math.round(item.opacity*100):item[field]):100;$(field).value=value;$(field+'Value').textContent=value+(field==='opacity'?'%':'');}}
function renderHistory(){const list=$('historyList');list.replaceChildren();history.entries.forEach((entry,index)=>{const button=document.createElement('button');button.className=index===history.index?'active':index>history.index?'future':'';button.textContent=`${index===history.index?'●':'·'}  ${entry.label}`;button.onclick=()=>{project=history.go(index);dirty=true;refresh();};list.append(button);});$('historyCount').textContent=`${history.index} edits`;list.scrollTop=list.scrollHeight;}
function renderReferences(){const list=$('referenceList');const scroll=list.scrollLeft;list.replaceChildren();for(const [index,ref] of project.references.entries()){const card=document.createElement('div');card.className='reference-card';card.dataset.referenceId=ref.id;card.title=ref.name;const image=document.createElement('img');setPreviewImage(image,ref);image.alt=ref.name;image.draggable=false;image.onclick=()=>composerReferences?.open();const order=document.createElement('span');order.className='reference-order';order.textContent=String(index+1);card.append(order);const labels=project.layers.filter(item=>referenceLinks(item).includes(ref.id)).map(item=>item.text.content.trim());if(labels.length){const badge=document.createElement('span');badge.className='reference-label-badge';badge.textContent=labels.join(', ');badge.title=`Linked labels: ${labels.join(', ')}`;card.append(badge);}const remove=document.createElement('button');remove.textContent='×';remove.setAttribute('aria-label',`Remove reference ${ref.name}`);remove.disabled=busy;remove.onclick=()=>{if(busy)return;try{commit(removeReference(project,ref.id),'Remove reference');}catch(error){toast(error.message,true);}};card.append(image,remove);list.append(card);}list.scrollLeft=scroll;$('referenceCount').textContent=`${project.references.length} photo${project.references.length===1?'':'s'}`;$('addReference').disabled=busy;composerReferences?.sync();}
function updateView(){syncDeleteAllControls();syncCanvasFitControls();board.style.setProperty('--inverse-zoom',1/view.zoom);board.style.width=`${project.width}px`;board.style.height=`${project.height}px`;board.style.transform=`translate(${view.x}px,${view.y}px) rotate(${view.angle||0}deg) scale(${view.zoom})`;$('zoomValue').textContent=`${Math.round(view.zoom*100)}%`;$('navScale').textContent=`${Math.round(view.zoom*100)}%`;
  const item=layer();$('selection').hidden=!item||!item.visible||['mask','erase','crop','text','pencil','highlight','detect','select','subtract'].includes(tool)||compare||Boolean(textDraft);if(item){Object.assign($('selection').style,{left:item.x+'px',top:item.y+'px',width:item.width+'px',height:item.height+'px',transform:`rotate(${item.rotation||0}deg)`,transformOrigin:'50% 50%'});}
  if(crop)Object.assign($('cropBox').style,{left:crop.x+'px',top:crop.y+'px',width:crop.width+'px',height:crop.height+'px'});$('cropBox').hidden=!crop;$('cropActions').hidden=!crop;
  for(const axis of ['X','Y']){const ruler=$('ruler'+axis),length=axis==='X'?stage.clientWidth:stage.clientHeight,offset=axis==='X'?view.x:view.y;const step=view.zoom>1?50:view.zoom>.35?200:500;ruler.replaceChildren();ruler.title=view.angle?'Canvas rotated: rulers resume at 0°':'';if(view.angle)continue;for(let n=Math.ceil(-offset/view.zoom/step)*step;n*view.zoom+offset<length;n+=step){const tick=document.createElement('span');tick.textContent=n;tick.style[axis==='X'?'left':'top']=(n*view.zoom+offset+3)+'px';ruler.append(tick);}}
  drawImageEditOverlay();syncRotationControls();scheduleWorkflowViewChange();
}
function syncRotationControls(){
  const item=layer(),raster=item?.kind==='raster'&&item.id!==project.sketch?.surfaceLayerId;
  rotationControls?.sync({viewAngle:view.angle||0,layerAngle:raster?item.rotation||0:0,hasRaster:Boolean(raster)&&!compare,busy:busy||Boolean(gesture&&gesture.mode!=='rotate-layer')});
}
function changeViewRotation(angle){
  if(busy)throw new Error('Wait for the current image operation to finish.');
  if(!finishText())return;finishGesture();hideImageMenu();localDetection.clearHover();
  const anchor=documentToView(view,{x:project.width/2,y:project.height/2});
  view=rotateView(view,angle,anchor);$('brushCursor').hidden=true;updateView();layoutTextEditor();
}
function changeLayerRotation(angle,{commit:final=true}={}){
  if(busy||compare)throw new Error('Finish the current operation and turn off Before / after to rotate an image layer.');
  if(!finishText())return;
  const item=layer();if(item?.kind!=='raster'||item.id===project.sketch?.surfaceLayerId)throw new Error('Select an image layer to rotate.');
  if(gesture&&(gesture.mode!=='rotate-layer'||gesture.id!==item.id))finishGesture();
  if(!gesture&&normalizeRotation(item.rotation||0)===normalizeRotation(angle)){syncRotationControls();return;}
  if(!gesture)gesture={mode:'rotate-layer',before:copy(project),id:item.id};
  project=updateLayer(gesture.before,item.id,{rotation:normalizeRotation(angle)});
  localDetection.clearHover();$('brushCursor').hidden=true;
  if(final)finishGesture();else refresh();
}
function fit(){view=fitRotatedView(project.width,project.height,stage.clientWidth,stage.clientHeight,view.angle||0);updateView();}
function zoomAt(next,x=stage.clientWidth/2,y=stage.clientHeight/2){next=Math.max(.02,Math.min(16,next));const ratio=next/view.zoom;view.x=x-(x-view.x)*ratio;view.y=y-(y-view.y)*ratio;view.zoom=next;updateView();}
function scheduleRedraw(){
  if(redrawRunning||redrawFrame!==null)return;
  redrawFrame=requestAnimationFrame(()=>{redrawFrame=null;void renderLatestCanvas();});
}
function redraw(){
  const textId=textDraft?.id||null;
  // Selection/tool changes do not change the pixels. Painting mutates a live
  // mask until commit, so it explicitly bypasses this identity shortcut.
  if(!redrawRunning&&redrawFrame===null&&gesture?.mode!=='paint'&&drawnProject===project&&drawnTextId===textId&&drawnCompare===compare){updateCompare();return;}
  renderId++;scheduleRedraw();
}
async function renderLatestCanvas(){
  redrawRunning=true;const token=renderId,source=project,textId=textDraft?.id||null,showCompare=compare;
  const snapshot=textId?{...source,layers:source.layers.filter(item=>item.id!==textId)}:source;
  const temp=document.createElement('canvas');let before;
  try{
    await renderProject(snapshot,temp);if(token!==renderId)return;
    if(showCompare&&snapshot.original){before=document.createElement('canvas');await renderProject(snapshot,before,{original:true});if(token!==renderId)return;}
    canvas.width=temp.width;canvas.height=temp.height;canvas.getContext('2d').drawImage(temp,0,0);
    const nav=$('navigator');nav.width=240;nav.height=Math.max(1,Math.round(snapshot.height/snapshot.width*240));nav.getContext('2d').drawImage(temp,0,0,nav.width,nav.height);
    if(before){const original=$('originalCanvas');original.width=before.width;original.height=before.height;original.getContext('2d').drawImage(before,0,0);}
    drawnProject=source;drawnTextId=textId;drawnCompare=showCompare;updateCompare();
  }catch(error){if(token===renderId)toast(error.message,true);}
  finally{temp.width=temp.height=0;if(before)before.width=before.height=0;redrawRunning=false;if(token!==renderId)scheduleRedraw();}
}
function updateCompare(){if(!project.original)compare=false;const original=$('originalCanvas');original.hidden=!compare;if(!compare&&(original.width||original.height)){original.width=0;original.height=0;}$('compareLabels').hidden=!compare;$('compareSplit').hidden=!compare;$('compare').setAttribute('aria-pressed',String(compare));original.style.clipPath=`inset(0 ${100-Number($('compareSplit').value)}% 0 0)`;updateView();}
function toolCursor(){return space||tool==='hand'?'grab':['mask','erase','crop','pencil','highlight','select','subtract'].includes(tool)?'crosshair':tool==='text'?'text':'default';}
function setTool(next,detect=true){
  toolWheelStepper.reset();
  if(!finishText())return;finishGesture();hideImageMenu();
  if(Object.hasOwn(brushSettings,tool))brushSettings[tool]=Number($('brushSize').value);
  if(Object.hasOwn(brushColors,tool))brushColors[tool]=$('brushColor').value;
  if(isSketchProject(project)&&next==='crop'){toast('Use Canvas size to resize your drawing page.');return;}
  tool=next;crop=null;localDetection.clearHover();sketchWorkspace?.sync(isSketchProject(project),tool);
  for(const button of document.querySelectorAll('[data-tool]')){button.classList.toggle('active',button.dataset.tool===next);button.setAttribute('aria-pressed',String(button.dataset.tool===next));}
  const brush=Object.hasOwn(brushSettings,next),drawing=next==='pencil'||next==='highlight';
  $('brushOptions').hidden=!brush;$('brushColorOption').hidden=!drawing;$('textOptions').hidden=next!=='text';$('toolHint').hidden=brush||next==='text'||next==='detect';
  if(brush){$('brushSize').value=brushSettings[next];$('brushValue').textContent=brushSettings[next]+' px';}
  if(drawing)$('brushColor').value=brushColors[next];
  $('canvasMessage').textContent=({move:'Select a layer, then drag to move or resize.',mask:'Mask brush hides pixels on the selected layer.',erase:'Restore brush brings masked pixels back.',crop:'Drag to select the canvas area you want to keep.',hand:'Drag anywhere to pan the canvas.',text:'Click the image, type, and press Enter. Click again to add more text.',pencil:'Draw or circle an area, then use Detect marked area. Each stroke stays editable.',highlight:'Highlight each whole object with a separate stroke, then Detect highlights to share references.',detect:'Hover an object, then click to number it. Click a numbered object to open its references. Alt+scroll: overlapping regions.'})[next];
  if(isSketchProject(project)&&next==='pencil')$('canvasMessage').textContent='Draw your scene. Highlight subjects separately to select them and add references.';
  if(imageEditActive&&['select','subtract'].includes(next))$('canvasMessage').textContent=next==='subtract'?'Brush to subtract from the selected area.':'Paint the object to select it. Add strokes to refine; choose New selection for another object.';
  syncImageEditWorkspace();stage.style.cursor=toolCursor();$('brushCursor').hidden=true;$('emptyState').hidden=project.layers.length>0||project.original!==null||['text','pencil','highlight'].includes(next);syncTextOptions();updateView();localDetection.sync();if(next==='detect'&&detect&&!busy&&!document.querySelector('dialog[open]'))localDetection.run();
}
for(const button of document.querySelectorAll('[data-tool]'))button.onclick=()=>setTool(button.dataset.tool);
$('brushSize').oninput=()=>{$('brushValue').textContent=$('brushSize').value+' px';if(Object.hasOwn(brushSettings,tool))brushSettings[tool]=Number($('brushSize').value);syncImageEditWorkspace();};
$('brushColor').oninput=()=>{if(Object.hasOwn(brushColors,tool))brushColors[tool]=$('brushColor').value;};
function point(event){const rect=stage.getBoundingClientRect(),sx=event.clientX-rect.left,sy=event.clientY-rect.top;return {...viewToDocument(view,{x:sx,y:sy}),sx,sy};}
function layerContains(item,p){const local=documentPointToLayer(item,p);return local.x>=0&&local.y>=0&&local.x<=item.width&&local.y<=item.height;}
function layerSourcePoint(item,p){const local=documentPointToLayer(item,p),source=layerSourceDimensions(project,item);return [local.x*source.width/item.width,local.y*source.height/item.height];}
function transient(id,patch){project=updateLayer(gesture?.before||project,id,patch);updateView();redraw();renderProperties();}
stage.addEventListener('pointerdown',event=>{
  clearReferenceOpen();
  if(busy||event.target.closest('#emptyState,#cropActions,#textEditor')||event.button>1)return;if(gesture)return;hideImageMenu();if(!finishText())return;
  event.preventDefault();stage.focus();const p=point(event);
  if(space||tool==='hand'||event.button===1){gesture={mode:'pan',sx:p.sx,sy:p.sy,vx:view.x,vy:view.y};syncDeleteAllControls();stage.setPointerCapture(event.pointerId);return;}
  if(compare){toast('Turn off Before / after to edit.');return;}
  const before=copy(project);
  if(imageEditActive&&['select','subtract'].includes(tool)){
    if(!insideBoard(p))return;const existing=editSelectedArea(),raster=selectionTarget(project,selected);
    if(!raster){toast('Choose an image first.');return;}if(tool==='subtract'&&!existing){toast('Select an area before subtracting.');return;}
    gesture={mode:'edit-selection',before,raster,labelId:existing?.id||null,subtract:tool==='subtract',size:Number($('brushSize').value),points:[[p.x,p.y]]};
    syncImageEditWorkspace();stage.setPointerCapture(event.pointerId);return;
  }
  if(tool==='detect'){selectDetectedObject(p);return;}
  if(tool==='text'){if(insideBoard(p))startText(p);return;}
  if(tool==='pencil'||tool==='highlight'){if(!insideBoard(p))return;gesture={mode:'drawing',before,stroke:{mode:tool,color:$('brushColor').value,size:Number($('brushSize').value),points:[[p.x,p.y]]}};drawPreview();}
  else if(tool==='crop'){crop={x:p.x,y:p.y,width:0,height:0};gesture={mode:'crop',start:p};}
  else if(['mask','erase'].includes(tool)){const item=layer();if(!item||!item.visible){toast('Select a visible layer first.');return;}const asset=layerSourceDimensions(project,item);const stroke={mode:tool==='mask'?'hide':'restore',size:Math.min(8192,Number($('brushSize').value)*asset.width/item.width),points:[layerSourcePoint(item,p)]};project=copy(project);project.layers.find(l=>l.id===selected).mask.push(stroke);gesture={mode:'paint',before,id:selected};redraw();}
  else if(event.target.id==='resizeHandle'&&layer()){gesture={mode:'resize',start:p,before,id:selected,layer:copy(layer())};}
  else{const hit=[...project.layers].reverse().find(item=>item.id!==project.sketch?.surfaceLayerId&&item.visible&&item.opacity>0&&layerContains(item,p));selected=hit?.id||null;refresh();if(!hit)return;gesture={mode:'move',start:p,before,id:selected,layer:copy(hit),moved:false};}
  syncDeleteAllControls();stage.setPointerCapture(event.pointerId);
});
stage.addEventListener('pointermove',event=>{const p=point(event);if(tool==='detect')localDetection.hover(p);if(['mask','erase','pencil','highlight','select','subtract'].includes(tool)&&!space&&!compare&&insideBoard(p)){const size=Number($('brushSize').value)*view.zoom;Object.assign($('brushCursor').style,{left:(p.sx-size/2)+'px',top:(p.sy-size/2)+'px',width:size+'px',height:size+'px'});$('brushCursor').hidden=false;}else $('brushCursor').hidden=true;if(!gesture)return;
  if(gesture.mode==='edit-selection'){const points=gesture.points,last=points.at(-1);if(points.length<50000&&(last[0]!==p.x||last[1]!==p.y))points.push([p.x,p.y]);drawImageEditOverlay();}
  if(gesture.mode==='pan'){view.x=gesture.vx+p.sx-gesture.sx;view.y=gesture.vy+p.sy-gesture.sy;updateView();}
  if(gesture.mode==='move'){gesture.moved=gesture.moved||Math.hypot(p.sx-gesture.start.sx,p.sy-gesture.start.sy)>=4;if(!(referenceLinks(gesture.layer).length||labelComment(gesture.layer).trim()||gesture.layer.objectRegion)||gesture.moved)transient(gesture.id,{x:Math.round(gesture.layer.x+p.x-gesture.start.x),y:Math.round(gesture.layer.y+p.y-gesture.start.y)});}
  if(gesture.mode==='resize'){const original=gesture.layer,start=documentPointToLayer(original,gesture.start),current=documentPointToLayer(original,p);let width=Math.max(1,Math.min(32768,original.width+current.x-start.x)),height=Math.max(1,Math.min(32768,original.height+current.y-start.y));if($('lockRatio').checked||event.shiftKey){const scale=Math.min(width/original.width,32768/original.height);width=original.width*scale;height=original.height*scale;}const anchor=layerPointToDocument(original,{x:0,y:0}),resized={...original,width,height},newAnchor=layerPointToDocument(resized,{x:0,y:0});transient(gesture.id,{x:original.x+anchor.x-newAnchor.x,y:original.y+anchor.y-newAnchor.y,width,height});}
  if(gesture.mode==='paint'){const item=project.layers.find(item=>item.id===gesture.id),asset=layerSourceDimensions(project,item),stroke=item.mask.at(-1);if(stroke.points.length<50000)stroke.points.push(layerSourcePoint(item,p));redraw();}
  if(gesture.mode==='drawing'){const points=gesture.stroke.points,last=points.at(-1),next=[Math.max(0,Math.min(project.width,p.x)),Math.max(0,Math.min(project.height,p.y))];if(points.length<50000&&(next[0]!==last[0]||next[1]!==last[1]))points.push(next);drawPreview();}
  if(gesture.mode==='crop'){const x=Math.max(0,Math.min(project.width,Math.min(p.x,gesture.start.x))),y=Math.max(0,Math.min(project.height,Math.min(p.y,gesture.start.y)));crop={x:Math.round(x),y:Math.round(y),width:Math.max(0,Math.round(Math.min(project.width,Math.max(p.x,gesture.start.x))-x)),height:Math.max(0,Math.round(Math.min(project.height,Math.max(p.y,gesture.start.y))-y))};updateView();}
});
function finishGesture(cancel=false){if(!gesture)return;const current=gesture;gesture=null;syncDeleteAllControls();$('drawingPreview').hidden=true;if(cancel&&current.before){project=current.before;refresh();return;}if(current.mode==='edit-selection'){finishEditSelection(current);syncImageEditWorkspace();return;}if(current.mode==='drawing'){try{const result=addDrawing(current.before,current.stroke);selected=result.layerId;commit(result.project,current.stroke.mode==='highlight'?'Add highlight':'Pencil stroke');}catch(error){project=current.before;refresh();toast(error.message,true);}return;}if(['move','resize','paint','rotate-layer'].includes(current.mode)){try{commit(project,({move:'Move layer',resize:'Resize layer','rotate-layer':'Rotate image layer',paint:tool==='erase'?'Restore mask':'Paint mask'})[current.mode]);}catch(error){project=current.before;refresh();toast(error.message,true);}}syncRotationControls();syncImageEditWorkspace();}
stage.addEventListener('pointerup',event=>{const current=gesture,p=point(event);finishGesture();if(current?.mode==='move'&&!current.moved&&Math.hypot(p.sx-current.start.sx,p.sy-current.start.sy)<4&&(referenceLinks(current.layer).length||labelComment(current.layer).trim()||current.layer.objectRegion)&&insideBoard(p)&&tool==='move'){const target=project;referenceOpenTimer=setTimeout(()=>{referenceOpenTimer=null;if(project===target&&selected===current.id&&!busy&&!textDraft&&tool==='move'&&!compare&&!$('dialog').open&&!$('colorPicker').open)openReferenceDialog(current.id);},400);}});stage.addEventListener('pointercancel',()=>{clearReferenceOpen();finishGesture(true);});stage.addEventListener('lostpointercapture',()=>finishGesture());stage.addEventListener('pointerleave',()=>{$('brushCursor').hidden=true;localDetection.clearHover();});
stage.addEventListener('wheel',event=>{
  // Keep normal scrolling in the on-image text editor. Ctrl+wheel still zooms
  // the canvas, including that draft, without changing browser page zoom.
  if(textInputTarget(event.target)&&!event.ctrlKey){toolWheelStepper.reset();return;}
  event.preventDefault();
  if(busy||gesture||space||document.querySelector('dialog[open]')||!$('imageMenu').hidden){toolWheelStepper.reset();return;}
  clearReferenceOpen();
  if(event.ctrlKey){
    toolWheelStepper.reset();const {deltaX,deltaY,deltaMode}=event;
    if(!Number.isFinite(deltaY)||!Number.isFinite(deltaX)||!deltaY||Math.abs(deltaX)>Math.abs(deltaY)||![0,1,2].includes(deltaMode))return;
    const pixels=deltaY*(deltaMode===1?16:deltaMode===2?stage.clientHeight:1),p=point(event);
    zoomAt(view.zoom*Math.exp(-Math.max(-1000,Math.min(1000,pixels))*.0015),p.sx,p.sy);layoutTextEditor();localDetection.clearHover();return;
  }
  if(tool==='detect'&&event.altKey){const direction=toolWheelStepper.step(event);if(direction)localDetection.cycle(direction,point(event));return;}
  if(imageEditActive&&['select','subtract'].includes(tool)){const direction=toolWheelStepper.step(event);if(direction){$('brushSize').value=Math.max(1,Math.min(500,Number($('brushSize').value)+direction*5));$('brushSize').oninput();}return;}
  if(crop){toolWheelStepper.reset();return;}
  const direction=toolWheelStepper.step(event);if(direction)setTool(cycleTool(tool,direction,imageEditActive?['select','subtract','detect','move','hand']:wheelTools));
},{passive:false});
$('fit').onclick=fit;$('zoomIn').onclick=()=>zoomAt(view.zoom*1.25);$('zoomOut').onclick=()=>zoomAt(view.zoom/1.25);$('zoomValue').onclick=()=>zoomAt(1);
$('compare').onclick=()=>{compare=!compare;redraw();updateCompare();};$('compareSplit').oninput=updateCompare;
$('cancelCrop').onclick=()=>{crop=null;updateView();};$('applyCrop').onclick=()=>{try{dimensions(crop.width,crop.height);const next={...project,width:crop.width,height:crop.height,layers:project.layers.map(l=>({...l,x:l.x-crop.x,y:l.y-crop.y}))};commit(next,'Crop canvas');crop=null;setTool('move');fit();}catch(error){toast(error.message,true);}};
function undo(){cancelText();finishGesture(true);syncPrompt();if(history.canUndo){project=history.undo();dirty=true;crop=null;refresh();}}function redo(){cancelText();finishGesture(true);if(history.canRedo){project=history.redo();dirty=true;refresh();}}
$('undo').onclick=undo;$('redo').onclick=redo;
for(const [field,key]of Object.entries({layerX:'x',layerY:'y',layerW:'width',layerH:'height'}))$(field).onchange=()=>{if(!layer())return;try{const value=Number($(field).value),patch={[key]:value};if($('lockRatio').checked&&key==='width')patch.height=value*layer().height/layer().width;if($('lockRatio').checked&&key==='height')patch.width=value*layer().width/layer().height;commit(updateLayer(project,selected,patch),'Transform layer');}catch(error){toast(error.message,true);renderProperties();}};
for(const field of ['opacity','brightness','contrast','saturation']){$(field).oninput=()=>{$(field+'Value').textContent=$(field).value+(field==='opacity'?'%':'');};$(field).onchange=()=>{if(layer())commit(updateLayer(project,selected,{[field]:Number($(field).value)/(field==='opacity'?100:1)}),'Adjust '+field);};}
$('resetAdjustments').onclick=()=>{if(layer())commit(updateLayer(project,selected,{brightness:100,contrast:100,saturation:100,opacity:1}),'Reset adjustments');};$('clearMask').onclick=()=>{if(layer())commit(updateLayer(project,selected,{mask:[]}),'Clear mask');};
$('layerUp').onclick=()=>{if(selected)commit(reorderLayer(project,selected,project.layers.findIndex(l=>l.id===selected)+1),'Move layer up');};$('layerDown').onclick=()=>{if(selected)commit(reorderLayer(project,selected,project.layers.findIndex(l=>l.id===selected)-1),'Move layer down');};
$('duplicateLayer').onclick=()=>{if(!selected)return;try{const result=duplicateLayer(project,selected);selected=result.layerId;commit(result.project,'Duplicate layer');}catch(error){toast(error.message,true);}};
function deleteSelected(){if(!finishText())return;finishGesture();if(selected){commit(removeLayer(project,selected),'Delete layer');selected=project.layers.at(-1)?.id||null;refresh();}}$('deleteLayer').onclick=deleteSelected;
function deleteAllLayers(){if(busy||copying||gesture||document.querySelector('dialog[open]'))return;if(!finishText())return;finishGesture(true);syncPrompt();try{const next=isSketchProject(project)?createSketchProject(newProject(project.width,project.height,'Sketch reference')):resetProject(project);if(next===project){syncDeleteAllControls();return;}clearReferenceOpen();hideImageMenu();guidedSelection.close();referenceSession=null;referenceExportSession=null;colorSession=null;dialogSubmit=null;referenceEditor.clear();clearReferenceDrag();dragDepth=0;$('dropHint').hidden=true;clearPreviewCache();clearImageCache();selected=null;compare=false;crop=null;space=false;localDetection.reset();commit(next,'Delete all - fresh project');setTool('move',false);fit();stage.focus();toast('Fresh canvas ready. Undo restores the previous project.');}catch(error){toast(error.message,true);}}
$('deleteAllLayers').onclick=deleteAllLayers;
$('deleteAllLayers').addEventListener('keydown',event=>{if(event.key===' '||event.key==='Enter')event.stopPropagation();});
new MutationObserver(syncDeleteAllControls).observe(document.body,{subtree:true,attributes:true,attributeFilter:['open']});
function renameLayer(id){const item=project.layers.find(l=>l.id===id);modal('Rename layer',`<label class="dialog-field">Name<input id="nameField" maxlength="200" value="${esc(item.name)}" required></label>`,'Rename',()=>commit(updateLayer(project,id,{name:$('nameField').value.trim()||'Layer'}),'Rename layer'));}
function choose(input){if(busy)return;$(input).value='';$(input).click();}
for(const id of ['importEmpty','importTop','importLayer'])$(id).onclick=()=>choose('imageInput');$('addReference').onclick=()=>choose('referenceInput');
async function readRaster(file){return readOriginalImage(file);}
async function importRasterFiles(files,references=false,pasted=false,canCommit=()=>true){
  if(!files.length)return;if(!finishText())return;finishGesture();syncPrompt();
  const target=project;let next=target,lastSelected=selected;
  // Decode every image before committing the import, keeping a failed paste atomic.
  for(const file of files){const asset=await readRaster(file);if(references)next=addReference(next,asset);else{const result=addRaster(next,asset,{fitDocument:next.layers.length===0});next=result.project;lastSelected=result.layerId;if(target.layers.length===0&&target.name==='Untitled')next.name=file.name.replace(/\.[^.]+$/,'');}}
  if(!canCommit())throw new Error('Image import was canceled.');
  if(project!==target)throw new Error('The canvas changed while importing. Paste or import again into the current canvas.');
  selected=lastSelected;commit(next,references?'Add reference images':pasted?'Paste image'+(files.length>1?'s':''):'Import image'+(files.length>1?'s':''));
  if(!references){setTool('move');fit();}toast(references?'Reference images added.':pasted?'Image pasted as a new layer.':'Image added. Drag to move it or use the mask brush.');
}
async function importFiles(files,references=false,pasted=false){if(files.length)await guarded(()=>importRasterFiles(files,references,pasted));}
function textInputTarget(target){return target instanceof Element&&(target.isContentEditable||Boolean(target.closest('input,textarea,select,[contenteditable="true"],[contenteditable="plaintext-only"],[role="textbox"]')));}
document.addEventListener('paste',event=>{
  if(event.defaultPrevented||document.querySelector('#asunSheetCreator:not([hidden])')||document.querySelector('#mainImageSearchDialog[open]')||$('dialog').open||$('colorPicker').open||$('referenceExportDialog').open)return;
  if($('referenceDialog').open){handleReferencePaste(event);return;}
  let files;
  if(textInputTarget(event.target)){
    if(event.target!==$('textEditor'))return;
    // A copied image can be pasted while Text is active; ordinary words still paste into the label.
    try{files=clipboardImageFiles(event.clipboardData);}catch{return;}
  }
  event.preventDefault();hideImageMenu();
  if(busy){toast('Please wait for the current file operation, then paste again.');return;}
  try{
    // ClipboardEvent data is available now; retain its File objects before awaiting decode.
    files=files||clipboardImageFiles(event.clipboardData);
    importFiles(files,false,true);
  }catch(error){toast(error.message,true);}
});
async function pasteClipboardImage(){
  hideImageMenu();if(document.querySelector('#asunSheetCreator:not([hidden])')||$('dialog').open||$('colorPicker').open||$('referenceDialog').open||$('referenceExportDialog').open||$('guidedDetectionDialog').open)return;
  await guarded(async()=>{
    const target=project;
    try{
      // This explicit click is the only path that requests clipboard read permission.
      const files=await readClipboardImages();
      if(project!==target)throw new Error('The canvas changed while reading the clipboard. Paste again into the current canvas.');
      await importRasterFiles(files,false,true);
    }catch(error){
      if(['NotAllowedError','SecurityError'].includes(error.name))throw new Error('Clipboard access was blocked. Click the canvas and press Ctrl+V, or allow clipboard access and try Paste image again.');
      throw error;
    }
  });
}
$('pasteTop').onclick=pasteClipboardImage;$('pasteImage').onclick=pasteClipboardImage;
$('imageInput').onchange=event=>importFiles([...event.target.files]);$('referenceInput').onchange=event=>importFiles([...event.target.files],true);
composerReferences=mountComposerReferences({getProject:()=>project,isBusy:()=>busy,onChoose:()=>choose('referenceInput'),onImport:load=>guarded(async()=>importRasterFiles(await load(),true)),onRemove:id=>{if(!busy)commit(removeReference(project,id),'Remove reference');},onError:message=>toast(message,true),setPreviewImage});
const imageDropTypes=transfer=>[...transfer.types].some(type=>['Files','text/uri-list','text/html','text/plain'].includes(type));
let dragDepth=0;stage.addEventListener('dragenter',event=>{if(imageDropTypes(event.dataTransfer)){event.preventDefault();dragDepth++;$('dropHint').hidden=false;}});stage.addEventListener('dragover',event=>{if(imageDropTypes(event.dataTransfer))event.preventDefault();});stage.addEventListener('dragleave',()=>{if(--dragDepth<=0)$('dropHint').hidden=true;});stage.addEventListener('drop',event=>{
  event.preventDefault();dragDepth=0;$('dropHint').hidden=true;
  if(busy){toast('Please wait for the current file operation, then drop again.');return;}
  try{
    const target=project,pending=sheetDropInput(event.dataTransfer);
    void guarded(async()=>{const input=await pending,files=[...input.files];for(const url of input.urls)files.push(await sheetWebPhotoFile(url));if(project!==target)throw new Error('The canvas changed while loading the dropped image. Drop it again into the current canvas.');await importRasterFiles(files);});
  }catch(error){toast(error.message,true);}
});
function download(blob,name){const url=URL.createObjectURL(blob),link=document.createElement('a');link.href=url;link.download=name;document.body.append(link);link.click();link.remove();setTimeout(()=>URL.revokeObjectURL(url),60000);}
const safeName=name=>(name.trim().replace(/[<>:"/\\|?*\x00-\x1f]/g,'_').replace(/\.+$/,'')||'Asun IMG').slice(0,120);
$('saveProject').onclick=()=>{if(downloadLock||busy)return;downloadLock=true;setTimeout(()=>downloadLock=false,700);try{if(!finishText())return;finishGesture();syncPrompt();download(new Blob([serializeProject(project)],{type:'application/json'}),safeName(project.name)+'.asun');dirty=false;workflowChanged();$('savedState').textContent='Project downloaded';toast('Project downloaded with originals, layers, masks and references.');}catch(error){toast(error.message,true);}};
$('openProject').onclick=()=>{if(!finishText())return;finishGesture();if(dirty)modal('Open another project?','<p class="dialog-note">Unsaved edits will be replaced. Save your current project first if you want to keep them.</p>','Choose project',()=>choose('projectInput'));else choose('projectInput');};
$('projectInput').onchange=event=>{
  const file=event.target.files[0];if(!file)return;
  guarded(async()=>{
    let next=parseProject(await file.text());
    if(!workflowReady&&isSketchProject(project)&&!isSketchProject(next))next=createSketchProject(next);
    for(const asset of Object.values(next.assets)){const image=await decodeImage(asset.source);if(image.naturalWidth!==asset.width||image.naturalHeight!==asset.height)throw new Error('A source image does not match its saved dimensions.');}
    for(const ref of next.references){const image=await decodeImage(ref.source);if(image.naturalWidth!==ref.width||image.naturalHeight!==ref.height)throw new Error('A reference photo does not match its saved dimensions.');}
    // Validate every source before adding a tab; failed imports leave the live draft active.
    if(workflowReady){
      const active=workflowEntries.find(tab=>tab.id===activeWorkflowId);
      if(hasProjectContent(project)||active?.jobIds.length||mainWorkspaceSession||sketchWorkspaceSession)addWorkflow(next);
      else{active.name=next.name;active.dirty=false;active.session=newWorkflowSession(next);restoreWorkflow(active,{fitView:true});fit();void persistWorkflows();}
    }else{
      cancelText();finishGesture(true);clearPreviewCache();clearImageCache();localDetection.reset();project=next;history.reset(project);selected=project.layers.at(-1)?.id||null;dirty=false;compare=false;crop=null;refresh();fit();sketchLocation(isSketchProject(project),true);
    }
    toast('Project reopened. Originals and edits restored.');
  });
};
$('projectName').onclick=()=>modal('Name your project',`<label class="dialog-field">Project name<input id="nameField" maxlength="200" required value="${esc(project.name)}"></label>`,'Rename',()=>commit({...project,name:$('nameField').value.trim()||'Untitled'},'Rename project'));
$('newProject').onclick=()=>modal('Create a canvas',`<label class="dialog-field">Project name<input id="nameField" value="Untitled" maxlength="200"></label><div class="dialog-grid"><label class="dialog-field">Width (px)<input id="widthField" type="number" min="1" max="8192" value="1600" required></label><label class="dialog-field">Height (px)<input id="heightField" type="number" min="1" max="8192" value="1000" required></label></div><p class="dialog-note">${isSketchProject(project)?'A white drawing page, ready for a new sketch.':'A transparent canvas, ready for image and text layers.'} ${dirty?'Current unsaved edits will be replaced. Save your project first to keep them.':''}</p>`,'Create canvas',()=>{project=isSketchProject(project)?createSketchProject(newProject(Number($('widthField').value),Number($('heightField').value),$('nameField').value.trim()||'Sketch reference')):newProject(Number($('widthField').value),Number($('heightField').value),$('nameField').value.trim()||'Untitled');history.reset(project);selected=null;dirty=false;compare=false;crop=null;clearImageCache();clearPreviewCache();localDetection.reset();refresh();fit();});
$('fitCanvasPhoto').onclick=()=>{if(busy||gesture||crop||document.querySelector('dialog[open]'))return;const target=canvasImageFitTarget(project,selected);if(!target)return;if(!finishText())return;syncPrompt();try{const next=fitCanvasToImage(project,target.id);if(next===project)return;clearReferenceOpen();hideImageMenu();localDetection.clearHover();selected=target.id;compare=false;commit(next,'Fit canvas to photo');fit();toast('Canvas fitted to the full photo. Annotations stay aligned; original files are preserved.');}catch(error){toast(error.message,true);}};
$('resizeCanvas').onclick=()=>modal('Resize canvas',`<div class="dialog-grid"><label class="dialog-field">Width (px)<input id="widthField" type="number" min="1" max="8192" value="${project.width}" required></label><label class="dialog-field">Height (px)<input id="heightField" type="number" min="1" max="8192" value="${project.height}" required></label></div><p class="dialog-note">Layers keep their size and top-left position. ${isSketchProject(project)?'Extra drawing paper is white.':'Extra canvas is transparent.'} This does not generate or fill new image content.</p>`,'Resize canvas',()=>{const size=dimensions(Number($('widthField').value),Number($('heightField').value));commit({...project,...size},'Resize canvas');fit();});
$('export').onclick=()=>{if(!project.layers.length||busy)return;modal('Export your image',`<label class="dialog-field">Filename<input id="nameField" value="${esc(project.name)}" maxlength="120" required></label><div class="dialog-grid"><label class="dialog-field">Format<select id="formatField"><option value="png">${isSketchProject(project)?'PNG · sketch on white':'PNG · transparent'}</option><option value="jpeg">JPEG · white background</option></select></label><label class="dialog-field">JPEG quality<input id="qualityField" type="number" min="1" max="100" value="92"></label></div><p class="dialog-note">${project.width} × ${project.height} pixels. Exports the current visible layers. To keep editable layers and originals, use Save project as well.</p>`,'Download image',async()=>{const format=$('formatField').value,blob=await exportImage(project,format,Number($('qualityField').value)/100);download(blob,safeName($('nameField').value)+(format==='jpeg'?'.jpg':'.png'));toast('Image exported. Your original files are unchanged.');});};
function insideBoard(p){return p.x>=0&&p.y>=0&&p.x<project.width&&p.y<project.height;}
function measureText(content,size,fontFamily='Arial'){
  const context=document.createElement('canvas').getContext('2d');context.font=`600 ${size}px ${fontFamily}`;
  const lines=content.split('\n'),padding=Math.ceil(size*.2);
  const width=Math.max(1,Math.ceil(Math.max(...lines.map(line=>context.measureText(line).width))+padding*2));
  const height=Math.max(1,Math.ceil(lines.length*size*1.25+padding*2));
  dimensions(width,height);return {width,height,padding};
}
function layoutTextEditor(){
  if(!textDraft)return;
  const size=Number($('textSize').value),content=$('textEditor').value;
  if(!Number.isFinite(size)||size<8||size>500)return;
  let metrics;try{metrics=measureText(content,size,textDraft.fontFamily);}catch{metrics={width:8192,height:1000,padding:Math.ceil(size*.2)};}
  Object.assign($('textEditor').style,{left:textDraft.x+'px',top:textDraft.y+'px',width:Math.max(metrics.width,120/view.zoom/textDraft.scaleX)+'px',height:metrics.height+'px',padding:metrics.padding+'px',fontSize:size+'px',lineHeight:'1.25',fontFamily:textDraft.fontFamily,color:$('textColor').value,transform:`scale(${textDraft.scaleX},${textDraft.scaleY})`});
}
function startText(p,id=null){
  if(!finishText())return;if(compare){toast('Turn off Before / after to edit.');return;}
  const item=id?project.layers.find(item=>item.id===id):null;
  $('textSize').value=item?item.text.fontSize:textDefaults.fontSize;$('textColor').value=item?item.text.color:textDefaults.color;updateColorSwatch();
  textDraft={id,x:item?item.x:p.x,y:item?item.y:p.y,fontFamily:item?item.text.fontFamily:'Arial',scaleX:item?item.width/item.text.baseWidth:1,scaleY:item?item.height/item.text.baseHeight:1};
  $('textEditor').value=item?item.text.content:'';$('textEditor').hidden=false;$('emptyState').hidden=true;
  $('textOptions').hidden=false;layoutTextEditor();syncTextOptions();updateView();redraw();$('textEditor').focus();if(item)$('textEditor').select();
}
function cancelText(){if(!textDraft)return;textDraft=null;$('textEditor').hidden=true;$('textOptions').hidden=tool!=='text';refresh();}
// Confirm pending words before an inspector/toolbar action changes their layer or history.
document.addEventListener('click',event=>{
  if(!textDraft||event.target.closest('#stage,#textOptions,#colorPicker,#undo,#redo'))return;
  if(!finishText()){event.preventDefault();event.stopImmediatePropagation();}
},true);
document.addEventListener('dragstart',event=>{if(textDraft&&event.target.closest('.layer-row')&&!finishText()){event.preventDefault();event.stopImmediatePropagation();}},true);
function finishText(){
  if(!textDraft)return true;
  const content=$('textEditor').value;
  if(!content.trim()){cancelText();return true;}
  try{
    const fontSize=Number($('textSize').value),color=$('textColor').value;
    if(!Number.isFinite(fontSize)||fontSize<8||fontSize>500)throw new Error('Choose a text size from 8 to 500 px.');
    const draft=textDraft,metrics=measureText(content,fontSize,draft.fontFamily);
    let next;if(draft.id){next=updateText(project,draft.id,{content,fontSize,color,fontFamily:draft.fontFamily,width:metrics.width,height:metrics.height});selected=draft.id;}
    else{const result=addText(project,{content,fontSize,color,fontFamily:draft.fontFamily,x:draft.x,y:draft.y,width:metrics.width,height:metrics.height});next=result.project;selected=result.layerId;}
    textDraft=null;$('textEditor').hidden=true;$('textOptions').hidden=tool!=='text';commit(next,draft.id?'Edit text':'Add text annotation');return true;
  }catch(error){toast(error.message,true);return false;}
}
$('textEditor').addEventListener('input',()=>{layoutTextEditor();syncTextOptions();syncDeleteAllControls();});
$('textEditor').addEventListener('keydown',event=>{
  if(event.isComposing)return;
  if(event.key==='Enter'&&!event.shiftKey){event.preventDefault();event.stopPropagation();if(finishText())stage.focus();}
  if(event.key==='Escape'){event.preventDefault();event.stopPropagation();cancelText();stage.focus();}
});
for(const id of ['textSize','textColor'])$(id).addEventListener('input',()=>{layoutTextEditor();updateColorSwatch();});
$('textColor').onchange=()=>applyTextStyle('color',$('textColor').value);
$('textSize').onchange=()=>applyTextStyle('fontSize',Number($('textSize').value));
$('textColorWheel').onclick=()=>{
  if(busy)return;finishGesture();
  const item=layer();colorSession={draft:textDraft,layerId:!textDraft&&item?.kind==='text'?item.id:null,initialColor:$('textColor').value};
  textColorWheel.open(colorSession.initialColor,{title:colorSession.layerId?'Selected text / number color':'Text / number color'});
};
function updateColorSwatch(){$('textColorWheel').style.setProperty('--picked-color',$('textColor').value);}
function syncTextOptions(){
  const item=layer(),selectedText=item?.kind==='text'&&['move','text'].includes(tool);
  $('textOptions').hidden=!(textDraft||tool==='text'||selectedText);
  const referenceItem=textDraft?project.layers.find(entry=>entry.id===textDraft.id):item;
  $('linkReference').disabled=busy||(textDraft?!$('textEditor').value.trim():!selectedText);$('linkReference').textContent=referenceLinks(referenceItem).length?'View references':labelComment(referenceItem).trim()?'View comment':'References / comment';
  if(!textDraft&&!colorSession){if(selectedText){$('textSize').value=item.text.fontSize;$('textColor').value=item.text.color;}else if(tool==='text'){$('textSize').value=textDefaults.fontSize;$('textColor').value=textDefaults.color;}}
  $('toolHint').hidden=!$('textOptions').hidden||['mask','erase','pencil','highlight'].includes(tool);
  $('textEditHint').textContent=selectedText&&tool==='move'&&!textDraft?'Selected text / number':'Enter to place · Esc to cancel';updateColorSwatch();
}
function applyTextStyle(property,value){
  try{
    if(property==='fontSize'&&(!Number.isFinite(value)||value<8||value>500))throw new Error('Choose a text size from 8 to 500 px.');
    textDefaults[property==='color'?'color':'fontSize']=value;
    if(textDraft){layoutTextEditor();localDetection.clearHover();return;}
    const item=layer();if(item?.kind!=='text')return;
    const patch={[property]:value};
    if(property==='fontSize'){if(!Number.isFinite(value)||value<8||value>500)throw new Error('Choose a text size from 8 to 500 px.');Object.assign(patch,measureText(item.text.content,value,item.text.fontFamily));delete patch.padding;}
    commit(updateText(project,item.id,patch),property==='color'?'Change text color':'Change text size');
  }catch(error){toast(error.message,true);syncTextOptions();}
}
function previewTextColor(color){$('textColor').value=color;updateColorSwatch();if(colorSession?.draft&&textDraft===colorSession.draft)layoutTextEditor();}
function applyWheelColor(color){
  const session=colorSession;colorSession=null;textDefaults.color=color;$('textColor').value=color;updateColorSwatch();
  if(session?.draft&&textDraft===session.draft){layoutTextEditor();queueMicrotask(()=>$('textEditor').focus());}
  else if(session?.layerId){try{commit(updateText(project,session.layerId,{color}),'Change text color');}catch(error){toast(error.message,true);syncTextOptions();}}
  else syncTextOptions();
}
function cancelWheelColor(){
  const session=colorSession;colorSession=null;if(!session)return;
  $('textColor').value=session.initialColor;updateColorSwatch();
  if(session.draft&&textDraft===session.draft){layoutTextEditor();queueMicrotask(()=>$('textEditor').focus());}else syncTextOptions();
}
$('editTextLayer').onclick=()=>{if(layer()?.kind==='text'){setTool('text');startText(null,selected);}};
stage.addEventListener('dblclick',event=>{clearReferenceOpen();if(busy||compare||!['move','text'].includes(tool)||event.target.closest('#textEditor,#emptyState'))return;const p=point(event);const hit=[...project.layers].reverse().find(item=>item.id!==project.sketch?.surfaceLayerId&&item.visible&&item.opacity>0&&layerContains(item,p));if(hit?.kind==='text'){event.preventDefault();selected=hit.id;setTool('text');startText(null,hit.id);}});
function drawPreview(){
  if(gesture?.mode!=='drawing')return;
  const preview=$('drawingPreview'),stroke=gesture.stroke;if(preview.width!==project.width||preview.height!==project.height){preview.width=project.width;preview.height=project.height;}preview.hidden=false;
  const context=preview.getContext('2d');context.clearRect(0,0,preview.width,preview.height);context.globalAlpha=stroke.mode==='highlight'?.35:1;context.strokeStyle=stroke.color;context.lineWidth=stroke.size;context.lineCap='round';context.lineJoin='round';context.beginPath();context.moveTo(...stroke.points[0]);
  if(stroke.points.length===1)context.lineTo(stroke.points[0][0]+.01,stroke.points[0][1]);else for(const p of stroke.points.slice(1))context.lineTo(...p);context.stroke();
}
function clearReferenceOpen(){clearTimeout(referenceOpenTimer);referenceOpenTimer=null;}
function activeReference(){return referenceSession?.refs.find(ref=>ref.key===referenceSession.activeKey);}
function flushReferenceEdits(){try{const ref=activeReference();if(ref)ref.annotations=referenceEditor.flush();return true;}catch(error){$('referenceDialogError').textContent=error.message;return false;}}
let referenceNormalScroll=0;
// Expand the same editor, keeping its annotation history and the unsaved
// reference session intact. Back changes the view; Save changes commits it.
function setReferencePhotoExpanded(expanded,{flush=true,focus=true}={}){
  const dialog=$('referenceDialog'),form=$('referenceLinkForm');
  if(expanded&&(!dialog.open||!activeReference()||busy))return false;
  if(flush&&!flushReferenceEdits())return false;
  if(expanded&&!dialog.classList.contains('reference-photo-expanded'))referenceNormalScroll=form.scrollTop;
  dialog.classList.toggle('reference-photo-expanded',expanded);referenceEditor.setExpanded(expanded);
  $('referenceDialogTitle').textContent=expanded?'Reference photo':'References';
  form.scrollTop=expanded?0:referenceNormalScroll;
  if(focus&&dialog.open){
    const target=$(expanded?'refBackToReferences':'refExpandPhoto');target?.focus({preventScroll:true});
    requestAnimationFrame(()=>{if(dialog.open&&dialog.classList.contains('reference-photo-expanded')===expanded)form.scrollTop=expanded?0:referenceNormalScroll;});
  }
  return true;
}
function syncReferencePreview(){
  const session=referenceSession;if(!session)return;const ref=activeReference();
  if(!ref&&$('referenceDialog').classList.contains('reference-photo-expanded'))setReferencePhotoExpanded(false,{flush:false,focus:false});
  const image=$('referencePreview');image.hidden=true;setPreviewImage(image,ref);image.alt=ref?.name||'';
  $('referenceName').textContent=ref?ref.name:'No photo selected';$('referenceOriginalInfo').hidden=!ref;
  $('referenceOriginalInfo').textContent=ref?`Original ${ref.width} × ${ref.height} px · ${sourceFileInfo(ref).mimeType.replace('image/','').toUpperCase()}`:'';
  $('referencePreviewEmpty').hidden=Boolean(ref);$('referenceEditorHost').hidden=!ref;
  $('referenceNotesField').hidden=!ref;$('referenceNotes').disabled=!ref;$('referenceNotes').maxLength=MAX_REFERENCE_NOTE_LENGTH;
  $('referenceNotes').value=ref?.notes||'';$('referenceNotesCount').textContent=`${$('referenceNotes').value.length} / ${MAX_REFERENCE_NOTE_LENGTH}`;
  $('labelComment').disabled=busy;$('saveReferenceLink').disabled=busy;$('unlinkReference').hidden=!session.refs.length;$('removeLinkedPhoto').disabled=!ref||busy;
  for(const button of $('referenceGallery').querySelectorAll('button'))button.disabled=busy;
  $('referenceChoice').disabled=busy;$('chooseReferencePhoto').disabled=busy;$('pasteReferencePhoto').disabled=busy;$('searchReferenceWeb').disabled=busy;$('referenceGalleryCount').textContent=`${session.refs.length} photo${session.refs.length===1?'':'s'}`;$('referenceLibraryEmpty').hidden=session.refs.length>0;
}
function renderReferenceGallery(){
  const session=referenceSession,list=$('referenceGallery');list.replaceChildren();if(!session)return;
  session.refs.forEach((ref,index)=>{const card=document.createElement('div');card.className='reference-gallery-card';const button=document.createElement('button');button.type='button';button.className='reference-gallery-photo';button.dataset.referenceKey=ref.key;button.classList.toggle('selected',ref.key===session.activeKey);button.setAttribute('aria-label',`Photo ${index+1}: ${ref.name}`);button.setAttribute('aria-pressed',String(ref.key===session.activeKey));const image=document.createElement('img');setPreviewImage(image,ref);image.alt='';image.draggable=false;const caption=document.createElement('span');caption.className='reference-photo-caption';const number=document.createElement('span');number.className='reference-photo-number';number.textContent=String(index+1);const name=document.createElement('span');name.className='reference-photo-name';name.textContent=ref.name;caption.append(number,name);button.title=ref.name;button.append(image,caption);button.onclick=()=>selectReferencePhoto(ref.key);const remove=document.createElement('button');remove.type='button';remove.className='reference-gallery-remove';remove.dataset.removeReferenceKey=ref.key;remove.textContent='×';remove.title=`Remove photo ${index+1}: ${ref.name} from this number`;remove.setAttribute('aria-label',remove.title);remove.onclick=()=>removeReferencePhoto(ref.key);card.append(button,remove);list.append(card);});syncReferencePreview();
}
function selectReferencePhoto(key){
  if(busy||!referenceSession||!flushReferenceEdits())return;const ref=referenceSession.refs.find(item=>item.key===key);if(!ref)return;
  referenceSession.activeKey=key;renderReferenceGallery();$('referenceDialogError').textContent='';referenceEditor.load(ref).catch(error=>{$('referenceDialogError').textContent=error.message;});
}
function clearReferenceDrag(){referenceDragDepth=0;$('referenceDropZone').classList.remove('is-dragover');}
function openReferenceDialog(id=selected){
  clearReferenceOpen();if(busy||$('dialog').open||$('colorPicker').open)return;if(!finishText())return;finishGesture();hideImageMenu();
  const item=project.layers.find(entry=>entry.id===id);if(item?.kind!=='text'){toast('Place or select a text / number label first.');return;}
  selected=item.id;refresh();clearReferenceDrag();referenceEditor.clear();const refs=referenceLinks(item).map(refId=>project.references.find(ref=>ref.id===refId)).filter(Boolean).map(ref=>({...copy(ref),key:ref.id,isNew:false}));
  referenceSession={layerId:item.id,target:project,refs,activeKey:refs[0]?.key||null,comment:labelComment(item)};$('referenceDialogTitle').textContent='References';$('referenceAreaLabel').textContent=item.objectRegion?.group?`Group “${item.text.content.trim().slice(0,80)}” · Applies to all ${item.objectRegion.group.areaCount} areas`:`Area “${item.text.content.trim().slice(0,80)}”`;
  $('labelComment').value=referenceSession.comment;$('labelComment').maxLength=MAX_LABEL_COMMENT_LENGTH;$('labelCommentCount').textContent=`${referenceSession.comment.length} / ${MAX_LABEL_COMMENT_LENGTH}`;
  const options=$('referenceChoice');options.replaceChildren(new Option('Add an existing photo…',''));for(const ref of project.references)options.append(new Option(ref.name,ref.id));
  $('referenceFileInput').value='';$('referenceDialogError').textContent='';renderReferenceGallery();if(!$('referenceDialog').open)$('referenceDialog').showModal();if(refs[0])referenceEditor.load(refs[0]).catch(error=>{$('referenceDialogError').textContent=error.message;});
}
$('linkReference').onclick=()=>{if(textDraft&&!$('textEditor').value.trim()){toast('Type your number or label first.');$('textEditor').focus();return;}if(!finishText())return;openReferenceDialog(selected);};
$('closeReferenceDialog').onclick=()=>$('referenceDialog').close();$('cancelReferenceLink').onclick=()=>$('referenceDialog').close();
$('referenceDialog').addEventListener('cancel',event=>{if($('referenceDialog').classList.contains('reference-photo-expanded')){event.preventDefault();setReferencePhotoExpanded(false);}});
$('referenceDialog').addEventListener('close',()=>{setReferencePhotoExpanded(false,{flush:false,focus:false});referenceNormalScroll=0;clearReferenceDrag();referenceEditor.clear();referenceSession=null;$('referenceFileInput').value='';stage.focus();});
$('referenceChoice').onchange=()=>{
  const session=referenceSession,id=$('referenceChoice').value;if(!session||busy||!id)return;if(!flushReferenceEdits()){$('referenceChoice').value='';return;}
  let ref=session.refs.find(item=>item.id===id);if(!ref){const source=project.references.find(item=>item.id===id);if(!source)return;ref={...copy(source),key:id,isNew:false};session.refs.push(ref);}session.activeKey=ref.key;$('referenceChoice').value='';renderReferenceGallery();referenceEditor.load(ref).catch(error=>{$('referenceDialogError').textContent=error.message;});
};
$('chooseReferencePhoto').onclick=()=>choose('referenceFileInput');
$('labelComment').addEventListener('input',()=>{if(!referenceSession)return;referenceSession.comment=$('labelComment').value;$('labelCommentCount').textContent=`${referenceSession.comment.length} / ${MAX_LABEL_COMMENT_LENGTH}`;});
$('labelComment').addEventListener('keydown',event=>{if(event.key==='Enter')event.stopPropagation();});
$('referenceNotes').addEventListener('input',()=>{const ref=activeReference();if(!ref)return;ref.notes=$('referenceNotes').value;$('referenceNotesCount').textContent=`${ref.notes.length} / ${MAX_REFERENCE_NOTE_LENGTH}`;});
$('referenceNotes').addEventListener('keydown',event=>{if(event.key==='Enter')event.stopPropagation();});
async function stageReferenceFiles(files,session){
  const staged=[];for(const file of files){const asset=await readRaster(file);staged.push({...asset,id:'draft-'+crypto.randomUUID(),annotations:[],isNew:true});}
  if(referenceSession!==session||!$('referenceDialog').open)return;
  if(project!==session.target)throw new Error('The project changed. Close this window and add the photos again.');
  if(!flushReferenceEdits())return;
  for(const ref of staged){ref.key=ref.id;session.refs.push(ref);}session.activeKey=staged.at(-1).key;renderReferenceGallery();await referenceEditor.load(staged.at(-1));$('referenceDialogError').textContent='';
}
async function previewReferenceFiles(files){
  const session=referenceSession;if(!session||Array.isArray(files)&&!files.length)return;if(busy){$('referenceDialogError').textContent='Wait until the photos finish loading, then add more.';return;}if(!flushReferenceEdits())return;$('referenceDialogError').textContent='';
  await guarded(async()=>{syncReferencePreview();try{
    const ready=await files;if(referenceSession!==session)return;if(!ready.length)throw new Error('Drop PNG, JPEG or WebP photo files here.');await stageReferenceFiles(ready,session);
  }catch(error){if(referenceSession===session)$('referenceDialogError').textContent=error.message;}});if(referenceSession===session)syncReferencePreview();
}
function handleReferencePaste(event){
  if(!referenceSession||$('referenceEditorColorDialog')?.open)return;
  let files;try{files=clipboardImageFiles(event.clipboardData);}catch(error){if(textInputTarget(event.target))return;event.preventDefault();$('referenceDialogError').textContent=error.message;return;}
  event.preventDefault();previewReferenceFiles(files);
}
async function pasteReferencePhoto(){
  const session=referenceSession;if(!session||!$('referenceDialog').open||busy||!flushReferenceEdits())return;$('referenceDialogError').textContent='';
  await guarded(async()=>{syncReferencePreview();try{
    const files=await readClipboardImages();if(referenceSession!==session||!$('referenceDialog').open)return;await stageReferenceFiles(files,session);
  }catch(error){if(referenceSession===session)$('referenceDialogError').textContent=['NotAllowedError','SecurityError'].includes(error.name)?'Clipboard access was blocked. Click the photo area and press Ctrl+V, or allow clipboard access and try Paste photo again.':error.message;}});
}
$('pasteReferencePhoto').onclick=pasteReferencePhoto;
function searchReferenceWeb(){
  if(!referenceSession||busy)return;
  window.open(referenceSearchUrl($('referenceWebQuery').value),'_blank','noopener,noreferrer');
  // Browsers intentionally return null for noopener windows; it does not imply
  // that the search was blocked. Leave the gallery and its pending edits intact.
  $('pasteReferencePhoto').focus();
}
$('searchReferenceWeb').onclick=searchReferenceWeb;
$('referenceWebQuery').addEventListener('keydown',event=>{if(event.key==='Enter'&&!event.isComposing){event.preventDefault();event.stopPropagation();searchReferenceWeb();}});
$('referenceFileInput').onchange=event=>previewReferenceFiles(Array.from(event.target.files));
function fileDrag(dataTransfer){return Boolean(dataTransfer&&(Array.from(dataTransfer.types||[]).includes('Files')||Array.from(dataTransfer.items||[]).some(item=>item.kind==='file')));}
function inReferenceDialog(event){const dialog=$('referenceDialog');if(!(event.target instanceof Node)||!dialog.contains(event.target))return false;if(event.target!==dialog)return true;const rect=dialog.getBoundingClientRect();return event.clientX>=rect.left&&event.clientX<=rect.right&&event.clientY>=rect.top&&event.clientY<=rect.bottom;}
for(const type of ['dragenter','dragover'])document.addEventListener(type,event=>{
  if(!$('referenceDialog').open)return;event.preventDefault();event.stopPropagation();const accepted=inReferenceDialog(event)&&fileDrag(event.dataTransfer)&&!busy;if(event.dataTransfer)event.dataTransfer.dropEffect=accepted?'copy':'none';if(accepted){if(type==='dragenter')referenceDragDepth++;$('referenceDropZone').classList.add('is-dragover');}else clearReferenceDrag();
},true);
document.addEventListener('dragleave',event=>{if(!$('referenceDialog').open)return;event.stopPropagation();if(!inReferenceDialog(event))return;referenceDragDepth=Math.max(0,referenceDragDepth-1);if(event.relatedTarget instanceof Node){if($('referenceDialog').contains(event.relatedTarget))return;clearReferenceDrag();return;}if(!referenceDragDepth)clearReferenceDrag();},true);
document.addEventListener('dragend',clearReferenceDrag);
document.addEventListener('drop',event=>{
  if(!$('referenceDialog').open)return;event.preventDefault();event.stopPropagation();clearReferenceDrag();if(!inReferenceDialog(event)){$('referenceDialogError').textContent='Drop your photos inside the reference window.';return;}
  if(busy){$('referenceDialogError').textContent='Wait until the photos finish loading, then add more.';return;}try{previewReferenceFiles(captureDroppedImageFiles(event.dataTransfer));}catch(error){$('referenceDialogError').textContent=error.message;}
},true);
function removeReferencePhoto(key){
  const session=referenceSession;if(busy||!session)return;const index=session.refs.findIndex(ref=>ref.key===key);if(index<0||!flushReferenceEdits())return;
  const restoreFocus=document.activeElement?.dataset.removeReferenceKey===key,removedActive=session.activeKey===key;
  session.refs.splice(index,1);if(removedActive){session.activeKey=session.refs[Math.min(index,session.refs.length-1)]?.key||null;referenceEditor.clear();}
  $('referenceDialogError').textContent='';renderReferenceGallery();
  if(removedActive&&activeReference())referenceEditor.load(activeReference()).catch(error=>{$('referenceDialogError').textContent=error.message;});
  if(restoreFocus){const next=[...$('referenceGallery').querySelectorAll('[data-reference-key]')].find(button=>button.dataset.referenceKey===session.activeKey);(next||$('chooseReferencePhoto')).focus();}
}
$('removeLinkedPhoto').onclick=()=>removeReferencePhoto(referenceSession?.activeKey);
$('unlinkReference').onclick=()=>{if(busy||!referenceSession)return;referenceEditor.clear();referenceSession.refs=[];referenceSession.activeKey=null;renderReferenceGallery();};
$('referenceLinkForm').addEventListener('submit',event=>{
  event.preventDefault();if(busy||!referenceSession||!flushReferenceEdits())return;try{
    const session=referenceSession;if(project!==session.target)throw new Error('The project changed. Close this window and try again.');let next=project;const ids=[];
    for(const ref of session.refs){let id=ref.id;if(ref.isNew){next=addReference(next,ref);id=next.references.at(-1).id;}next=updateReferenceAnnotations(next,id,ref.annotations||[]);next=updateReferenceNotes(next,id,ref.notes||'');ids.push(id);}
    next=updateLabelComment(linkReferences(next,session.layerId,ids),session.layerId,session.comment);const hasComment=Boolean(labelComment(next.layers.find(item=>item.id===session.layerId)));
    commit(next,'Save references and area comment');$('referenceDialog').close();toast(hasComment?(ids.length?'Area comment and reference photos saved.':'Area comment saved. No reference photo needed.'):ids.length?`${ids.length} reference photo${ids.length===1?'':'s'} saved with annotations and notes. Click this label with Move to view them.`:'References and area comment cleared.');
  }catch(error){$('referenceDialogError').textContent=error.message;}
});

function hideImageMenu(){$('imageMenu').hidden=true;}
stage.addEventListener('contextmenu',event=>{
  if(textInputTarget(event.target))return;
  const p=point(event);
  event.preventDefault();finishGesture();if(!finishText())return;
  const canCopy=insideBoard(p)&&project.layers.length>0;
  $('copyImage').disabled=!canCopy||copying;$('downloadImage').disabled=!canCopy;
  const canCopyReferences=canCopy&&hasReferenceContent();$('copyReferenceBoard').disabled=!canCopyReferences||copying;$('downloadReferenceBoard').disabled=!canCopyReferences;
  syncPackControls();
  const menu=$('imageMenu');menu.hidden=false;menu.style.left=Math.max(4,Math.min(event.clientX,innerWidth-menu.offsetWidth-8))+'px';menu.style.top=Math.max(4,Math.min(event.clientY,innerHeight-menu.offsetHeight-8))+'px';$(canCopy?'copyImage':'pasteImage').focus();
});
document.addEventListener('pointerdown',event=>{clearReferenceOpen();if(!event.target.closest('#imageMenu'))hideImageMenu();});
window.addEventListener('resize',hideImageMenu);stage.addEventListener('wheel',hideImageMenu);
$('imageMenu').addEventListener('keydown',event=>{if(event.key==='Escape'){event.preventDefault();hideImageMenu();stage.focus();}if(event.key==='ArrowDown'||event.key==='ArrowUp'){event.preventDefault();const items=[...$('imageMenu').querySelectorAll('button:not(:disabled)')];const index=items.indexOf(document.activeElement);items[(index+(event.key==='ArrowDown'?1:-1)+items.length)%items.length].focus();}});
async function copyAnnotatedImage(){
  if(copying||busy)return;hideImageMenu();if(!finishText())return;finishGesture();if(!project.layers.length){toast('Import an image or add an annotation first.');return;}
  if(!navigator.clipboard?.write||typeof ClipboardItem==='undefined'){toast('Image copying is unavailable in this browser. Right-click and choose Download annotated PNG.',true);return;}
  copying=true;$('copyImage').disabled=true;syncDeleteAllControls();
  try{
    const snapshot=copy(project);
    // Pass the PNG promise immediately so clipboard access keeps the user's click activation.
    const png=exportImage(snapshot,'png');
    png.catch(()=>{});
    await navigator.clipboard.write([new ClipboardItem({'image/png':png})]);
    toast('Image and annotations copied. Paste into ChatGPT with Ctrl+V.');
  }catch(error){toast(error.name==='NotAllowedError'?'Allow clipboard access for Asun IMG and try Copy image again. You can also download the annotated PNG from the right-click menu.':`Could not copy image: ${error.message}. Use Download annotated PNG.`,true);}
  finally{copying=false;$('copyImage').disabled=false;syncDeleteAllControls();}
}
$('copyImage').onclick=copyAnnotatedImage;
$('downloadImage').onclick=()=>{hideImageMenu();if(!finishText())return;finishGesture();guarded(async()=>{const blob=await exportImage(copy(project),'png');download(blob,safeName(project.name)+'.png');toast('Annotated PNG downloaded.');});};
async function copySceneReferences(){
  if(copying||busy)return;hideImageMenu();clearReferenceOpen();if(!finishText())return;finishGesture();
  if(!hasReferenceContent()){toast('Add a comment or reference photo to a visible number first.');return;}
  let snapshot;try{snapshot=copy(project);if(referenceBoardPages(snapshot).length>1){openReferenceExport(snapshot);return;}}catch(error){toast(error.message,true);return;}
  await copyReferencePage(snapshot,0);
}
function syncReferenceExport(){
  $('copyReferencePage').disabled=copying||busy;$('downloadReferencePages').disabled=copying||busy;$('referencePageChoice').disabled=copying||busy;
  syncPackControls();
}
function openReferenceExport(snapshot){
  const pages=referenceBoardPages(snapshot);referenceExportSession={snapshot,pages};
  const commentCount=linkedLabelComments(snapshot).length;$('referenceExportInfo').textContent=`${pages[0].totalReferences} reference photos${commentCount?` and ${commentCount} area comment${commentCount===1?'':'s'}`:''} across ${pages.length} pages. Each page includes the main scene and its numbered instructions. Copy and paste each page into ChatGPT, or download all pages as a ZIP of PNG images.`;
  $('referenceExportStatus').textContent='';$('referencePageChoice').replaceChildren(...pages.map((page,index)=>new Option(`Page ${index+1} of ${pages.length} · ${page.tiles.length} ${commentCount?'entries':'photos'}`,String(index))));syncReferenceExport();$('referenceExportDialog').showModal();
}
$('closeReferenceExport').onclick=()=>$('referenceExportDialog').close();
$('referenceExportDialog').addEventListener('close',()=>{referenceExportSession=null;stage.focus();});
for(const type of ['dragenter','dragover','drop'])document.addEventListener(type,event=>{if($('referenceExportDialog').open){event.preventDefault();event.stopPropagation();if(event.dataTransfer)event.dataTransfer.dropEffect='none';}},true);
async function copyReferencePage(snapshot,page){
  if(copying||busy)return;
  if(!navigator.clipboard?.write||typeof ClipboardItem==='undefined'){toast('Image copying is unavailable. Right-click and choose Download scene + references.',true);return;}
  const session=referenceExportSession;copying=true;$('copyReferenceBoard').disabled=true;$('copyReferencesTop').disabled=true;syncReferenceExport();if(session)$('referenceExportStatus').textContent=`Copying page ${page+1}…`;
  try{const png=exportReferenceBoard(snapshot,page);png.catch(()=>{});await navigator.clipboard.write([new ClipboardItem({'image/png':png})]);const message=session?`Page ${page+1} copied. Paste it into ChatGPT, then copy the next page.`:'Scene + references and area comments copied. Paste into ChatGPT with Ctrl+V.';if(session===referenceExportSession&&session)$('referenceExportStatus').textContent=message;toast(message);}
  catch(error){const message=error.name==='NotAllowedError'?'Clipboard access was blocked. Use Download all pages or Download scene + references.':`Could not copy references: ${error.message}. Use Download all pages or Download scene + references.`;if(session&&session===referenceExportSession)$('referenceExportStatus').textContent=message;toast(message,true);}
  finally{copying=false;syncReferenceExport();$('copyReferenceBoard').disabled=!hasReferenceContent();refresh();}
}
$('copyReferenceBoard').onclick=copySceneReferences;$('copyReferencesTop').onclick=copySceneReferences;
$('copyReferencePage').onclick=()=>{const session=referenceExportSession;if(session)copyReferencePage(session.snapshot,Number($('referencePageChoice').value));};
async function downloadReferencePages(snapshot){
  const session=referenceExportSession;await guarded(async()=>{syncReferenceExport();if(session)$('referenceExportStatus').textContent='Preparing all reference pages…';
    try{const blobs=await exportReferenceBoards(snapshot),name=safeName(snapshot.name)+' - scene and references';if(blobs.length===1)download(blobs[0],name+'.png');else download(await zipReferencePages(blobs.map((blob,index)=>({name:`${name} - page ${index+1}.png`,blob}))),name+'.zip');const message=blobs.length===1?'Scene + references and comments downloaded as one PNG.':`All ${blobs.length} pages downloaded in one ZIP. Extract it to attach the PNG pages to ChatGPT.`;if(session&&session===referenceExportSession)$('referenceExportStatus').textContent=message;toast(message);
    }catch(error){if(session&&session===referenceExportSession)$('referenceExportStatus').textContent=error.message;throw error;}
  });syncReferenceExport();
}
$('downloadReferencePages').onclick=()=>{const session=referenceExportSession;if(session)downloadReferencePages(session.snapshot);};
$('downloadReferenceBoard').onclick=()=>{if(busy||copying)return;hideImageMenu();if(!finishText())return;finishGesture();try{const snapshot=copy(project);if(referenceBoardPages(snapshot).length>1)openReferenceExport(snapshot);else downloadReferencePages(snapshot);}catch(error){toast(error.message,true);}};
async function downloadCompletePack(snapshot){
  if(busy||copying)return;const session=referenceExportSession;
  await guarded(async()=>{syncReferenceExport();if(session)$('referenceExportStatus').textContent='Preparing original images and numbered board…';
    try{const blob=await exportCompleteReferencePack(snapshot);download(blob,safeName(snapshot.name)+' - Complete reference pack.zip');const message='Reference pack downloaded. START-HERE.txt includes the generation and Astra review instructions.';if(session&&session===referenceExportSession)$('referenceExportStatus').textContent=message;toast(message);}
    catch(error){if(session&&session===referenceExportSession)$('referenceExportStatus').textContent=error.message;throw error;}
  });syncReferenceExport();
}
function exportCurrentReferencePack(){
  if(busy||copying)return;hideImageMenu();clearReferenceOpen();if(!finishText())return;finishGesture();syncPrompt();downloadCompletePack(copy(project));
}
$('completeReferencePackTop').onclick=exportCurrentReferencePack;$('downloadCompleteReferencePack').onclick=exportCurrentReferencePack;
$('downloadCompleteReferencePackPages').onclick=()=>{const session=referenceExportSession;if(session)downloadCompletePack(session.snapshot);};

function showVariants(){if(!finishText())return;finishGesture();syncPrompt();modal('Your local variants','<p class="dialog-note">Save snapshots of your own edits and return to them later. These are local versions, not AI-generated images.</p><div class="variant-actions"><button id="saveVariant" type="button" class="primary">+ Save current edit</button></div><div id="variantGrid" class="variant-grid"></div>',null,null);$('saveVariant').onclick=()=>modal('Save a variant',`<label class="dialog-field">Name<input id="variantName" maxlength="200" value="Variant ${project.variants.length+1}" required></label>`,'Save variant',()=>{commit(saveVariant(project,$('variantName').value.trim()),'Save variant');toast('Local variant saved with your project.');});
  const container=$('variantGrid');if(!project.variants.length)container.innerHTML='<p class="dialog-note">No variants yet. Save your first edit above.</p>';
  for(const variant of project.variants){const card=document.createElement('div');card.className='variant-card';const thumb=document.createElement('img');thumb.alt='';const title=document.createElement('strong');title.textContent=variant.name;const restore=document.createElement('button');restore.type='button';restore.textContent='Restore';restore.onclick=()=>{commit(restoreVariant(project,variant.id),'Restore '+variant.name);$('dialog').close();fit();};const remove=document.createElement('button');remove.type='button';remove.textContent='Delete';remove.onclick=()=>{commit({...project,variants:project.variants.filter(v=>v.id!==variant.id)},'Delete variant');showVariants();};card.append(thumb,title,restore,remove);container.append(card);const temp=document.createElement('canvas');renderProject({...project,width:variant.width,height:variant.height,layers:variant.layers},temp).then(()=>{const small=document.createElement('canvas');small.width=240;small.height=Math.max(1,Math.round(temp.height/temp.width*240));small.getContext('2d').drawImage(temp,0,0,small.width,small.height);thumb.src=small.toDataURL('image/png');}).catch(error=>toast(error.message,true));}}
$('variants').onclick=showVariants;$('editTab').onclick=()=>{if(isSketchProject(project)){try{leaveSketchWorkspace();}catch(error){toast(error.message,true);}return;}if($('dialog').open)$('dialog').close();stage.focus();};$('prompt').onchange=syncPrompt;
$('prompt').addEventListener('input',()=>{editSummaryView.update({...project,prompt:$('prompt').value},selected);syncDeleteAllControls();});
$('toggleEditSummary').onclick=()=>{const collapsed=$('editSummaryPanel').classList.toggle('is-collapsed');$('editSummaryPanel').closest('.canvas-area').classList.toggle('summary-collapsed',collapsed);$('editSummaryContent').hidden=collapsed;$('toggleEditSummary').setAttribute('aria-expanded',String(!collapsed));$('toggleEditSummary').setAttribute('aria-label',collapsed?'Expand edit summary':'Collapse edit summary');$('toggleEditSummary').title=collapsed?'Expand edit summary':'Collapse edit summary';$('toggleEditSummary').textContent=collapsed?'›':'‹';localDetection.clearHover();hideImageMenu();fit();};
$('help').onclick=()=>modal('Make yourself at home','<table class="shortcut-table"><tr><td>Move / Mask / Restore / Crop / Hand</td><td>V / B / E / C / H</td></tr><tr><td>Text / Pencil / Highlight / Objects</td><td>T / P / L / A</td></tr><tr><td>Remove extra canvas around a photo</td><td>Fit canvas to photo</td></tr><tr><td>Review chosen areas and edits</td><td>Edit summary → click an area</td></tr><tr><td>Find a missed object</td><td>Pencil / Highlight → Detect marked area</td></tr><tr><td>Give several objects the same references</td><td>Highlight each object → Detect highlights → Number group</td></tr><tr><td>Find and number objects locally</td><td>Auto detect → hover → click</td></tr><tr><td>Change overlapping object region</td><td>Objects → Alt+scroll</td></tr><tr><td>Place text / New line / Cancel text</td><td>Enter / Shift+Enter / Esc</td></tr><tr><td>Paste image from clipboard</td><td>Ctrl+V · Paste image</td></tr><tr><td>Copy image with annotations</td><td>Right-click → Copy · Ctrl+C</td></tr><tr><td>Add photos or a comment to a number</td><td>Select label → References / comment</td></tr><tr><td>View / annotate linked photos</td><td>Move → Click linked label</td></tr><tr><td>Share linked photos with ChatGPT</td><td>Copy scene + references</td></tr><tr><td>Pan canvas</td><td>Space + drag</td></tr><tr><td>Previous / next tool</td><td>Scroll up / down over the canvas</td></tr><tr><td>Zoom / Fit / 100%</td><td>Ctrl+scroll / 0 / 1</td></tr><tr><td>Undo / Redo</td><td>Ctrl+Z / Ctrl+Shift+Z</td></tr><tr><td>Import image / Open project</td><td>Ctrl+O / Ctrl+Shift+O</td></tr><tr><td>Save project / Export</td><td>Ctrl+S / Ctrl+E</td></tr><tr><td>Move selected layer</td><td>Arrows · Shift = 10 px</td></tr><tr><td>Start a fresh project</td><td>Layers → DELETE ALL · Ctrl+Z restores</td></tr><tr><td>Delete layer / Cancel gesture</td><td>Delete / Esc</td></tr><tr><td>Smaller / larger brush</td><td>[ / ]</td></tr></table><p class="dialog-note">Masks hide pixels. Restore brings them back. Double-click text on the canvas to edit its words. Select a text layer and use Edit text to revise it. Double-click a layer name to rename it. Character / item sheet uses your connected OpenAI API account to generate multiple angles on white. Choose an image model beside the main prompt and press Generate for image creation or editing. Returned images can be saved or added as a new editable layer.</p>',null,null);
document.addEventListener('keydown',event=>{if(document.querySelector('#asunSheetCreator:not([hidden])'))return;clearReferenceOpen();const typing=/INPUT|TEXTAREA|SELECT/.test(event.target.tagName);if(document.querySelector('dialog[open]'))return;const command=event.ctrlKey||event.metaKey;if(command&&event.key.toLowerCase()==='v')return;if(command&&event.key.toLowerCase()==='c'&&!typing){const selection=window.getSelection();if(selection&&!selection.isCollapsed&&[selection.anchorNode,selection.focusNode].some(node=>node&&$('editSummaryPanel').contains(node)))return;event.preventDefault();copyAnnotatedImage();return;}if(command&&['s','o','e','z','y'].includes(event.key.toLowerCase())){if(typing&&['z','y'].includes(event.key.toLowerCase()))return;event.preventDefault();const key=event.key.toLowerCase();if(key==='s')$('saveProject').click();if(key==='o')$(event.shiftKey?'openProject':'importTop').click();if(key==='e')$('export').click();if(key==='z')(event.shiftKey?redo:undo)();if(key==='y')redo();return;}if(typing||busy)return;if(event.code==='Space'){event.preventDefault();space=true;stage.style.cursor='grab';return;}if(event.key==='Escape'){localDetection.clearHover();hideImageMenu();cancelText();finishGesture(true);crop=null;updateView();return;}const tools=imageEditActive?{v:'move',b:'select',e:'subtract',h:'hand',a:'detect'}:{v:'move',b:'mask',e:'erase',c:'crop',h:'hand',t:'text',p:'pencil',l:'highlight',a:'detect'};if(tools[event.key.toLowerCase()])setTool(tools[event.key.toLowerCase()]);if(event.key==='0')fit();if(event.key==='1')zoomAt(1);if(event.key==='Delete'||event.key==='Backspace'){event.preventDefault();deleteSelected();}if(event.key==='['||event.key===']'){$('brushSize').value=Math.max(1,Math.min(500,Number($('brushSize').value)+(event.key===']'?10:-10)));$('brushSize').oninput();}if(['ArrowLeft','ArrowRight','ArrowUp','ArrowDown'].includes(event.key)&&layer()){event.preventDefault();const amount=event.shiftKey?10:1;const patch={x:layer().x+(event.key==='ArrowRight'?amount:event.key==='ArrowLeft'?-amount:0),y:layer().y+(event.key==='ArrowDown'?amount:event.key==='ArrowUp'?-amount:0)};commit(updateLayer(project,selected,patch),'Nudge layer');}});
function hasUnsavedReferenceEdits(){
  const session=referenceSession;if(!session)return false;if(referenceEditor.hasPending())return true;
  const originalLayer=session.target.layers.find(item=>item.id===session.layerId),ids=referenceLinks(originalLayer);
  if(session.comment.trim()!==labelComment(originalLayer).trim())return true;
  if(ids.length!==session.refs.length||session.refs.some((ref,index)=>ref.isNew||ref.id!==ids[index]))return true;
  return session.refs.some(ref=>{const original=session.target.references.find(item=>item.id===ref.id);return JSON.stringify(ref.annotations||[])!==JSON.stringify(original?.annotations||[])||(ref.notes||'')!==(original?.notes||'');});
}
document.addEventListener('keyup',event=>{if(event.code==='Space'){space=false;stage.style.cursor=toolCursor();}});window.addEventListener('blur',()=>{space=false;finishGesture(true);});window.addEventListener('beforeunload',event=>{if(dirty||mainWorkspaceSession?.dirty||sketchWorkspaceSession?.dirty||workflowEntries.some(tab=>tab.dirty||tab.session?.main?.dirty||tab.session?.sketch?.dirty)||textDraft&&$('textEditor').value.trim()||hasUnsavedReferenceEdits()){event.preventDefault();event.returnValue='';}});
function checkDesktopSheetReady(){
  if(busy||copying)throw new Error('Wait for the current editor operation to finish.');
  if(document.querySelector('dialog[open]'))throw new Error('Save or close the open dialog first.');
  if(!finishText())throw new Error('Finish the current text annotation first.');
  finishGesture();syncPrompt();
}
desktopSheetEditor=Object.freeze({
  peek(){return copy(project);},
  snapshot(){checkDesktopSheetReady();return copy(project);},
  apply(next,label='Update character / item sheet'){checkDesktopSheetReady();commit(parseProject(JSON.stringify(next)),label);return copy(project);},
  state(){if(observedProject!==project){observedProject=project;projectRevision++;}return {dirty,busy,projectRevision,hasSource:Boolean(project.original),name:project.name,hasAreaGenerationInstructions:hasImageGenerationInstructions({...project,prompt:''})};},
  subscribe(listener){desktopSheetListeners.add(listener);listener(this.state());return()=>desktopSheetListeners.delete(listener);},
  async importImages(files,{references=false}={}){
    checkDesktopSheetReady();busy=true;document.body.classList.add('busy');refresh();
    try{await importRasterFiles(Array.from(files),references,false);return copy(project);}
    finally{busy=false;document.body.classList.remove('busy');refresh();}
  },
  async editGeneratedImage(image){
    checkDesktopSheetReady();const expected=project,expectedPrompt=$('prompt').value;
    busy=true;document.body.classList.add('busy');refresh();
    let next;
    try{next=await buildOutputProject(image);if(project!==expected||$('prompt').value!==expectedPrompt)throw new Error('The project changed while opening the output. Choose Edit output image again.');}
    finally{busy=false;document.body.classList.remove('busy');refresh();}
    return applyGenerationProject(next,'Edit generated output');
  },
  restoreGenerationProject(next){return applyGenerationProject(next,'Restore generation setup');},
});
function applyGenerationProject(value,label){
  const next=parseProject(JSON.stringify(value)),removalIntent=next.imageEditRequest;delete next.imageEditRequest;checkDesktopSheetReady();
  if(workflowReady){
    addWorkflow(next,{dirty:true,imageEdit:label==='Edit generated output'||Boolean(removalIntent),sheet:Boolean(next.sheetPreset?.active)});
    if(removalIntent){selected=removalIntent.labelIds?.[0]||null;refresh();}
    toast(label==='Edit generated output'?'Output opened in a new edit tab. Your previous workflow is kept.':'Original setup opened in a new tab. Add your changes, then Generate.');
    return copy(project);
  }
  const sketchToMain=isSketchProject(project)&&!isSketchProject(next);
  // Keep the independent main/sketch drafts when the result changes workspaces.
  if(isSketchProject(project)&&!isSketchProject(next))leaveSketchWorkspace();
  else if(!isSketchProject(project)&&isSketchProject(next))enterSketchWorkspace();
  clearReferenceOpen();hideImageMenu();guidedSelection.close();localDetection.reset();clearImageCache();clearPreviewCache();
  selected=null;compare=false;crop=null;commit(next,label);setTool('move',false);sketchLocation(isSketchProject(project),true);fit();stage.focus();
  if(label==='Edit generated output'||removalIntent){enterImageEditWorkspace();if(removalIntent){selected=removalIntent.labelIds?.[0]||null;refresh();}}
  toast(label==='Edit generated output'?(sketchToMain?'Output ready in Edit image. Your drawing is kept in Draw / sketch reference; Undo restores the previous main canvas.':'Output ready in Edit image. Paint a selection or use Auto detect to select objects. Undo restores your previous canvas.'):'Original image, areas, references and instructions restored. Add your changes, then press Generate when ready.');
  return copy(project);
}
function captureWorkspaceSession(){
  return {project,history,selected,tool,dirty,compare,view:{...view},brushSettings:{...brushSettings},brushColors:{...brushColors}};
}
function restoreWorkspaceSession(session){
  clearReferenceOpen();hideImageMenu();guidedSelection.close();localDetection.reset();clearImageCache();clearPreviewCache();
  project=session.project;history=session.history;selected=session.selected;dirty=session.dirty;compare=session.compare;view={...session.view};crop=null;
  Object.assign(brushSettings,session.brushSettings);Object.assign(brushColors,session.brushColors);
  // Do not save the previous workspace's controls over the restored tool.
  tool='move';setTool(session.tool,false);refresh();stage.focus();
}
function sketchLocation(active,replace=false){
  const url=new URL(location.href);if(active)url.searchParams.set('workspace','sketch');else if(imageEditActive)url.searchParams.set('workspace','edit');else url.searchParams.delete('workspace');
  if(url.href!==location.href)window.history[replace?'replaceState':'pushState']({},'',url);
}
function enterSketchWorkspace({route=true}={}){
  checkDesktopSheetReady();if(isSketchProject(project)){if(route)sketchLocation(true);return;}
  if(imageEditActive)leaveImageEditWorkspace({route:false});
  mainWorkspaceSession=captureWorkspaceSession();
  if(!sketchWorkspaceSession){
    const carryDrawing=project.layers.some(item=>item.kind==='drawing')&&!project.layers.some(item=>item.kind==='raster');
    const draft=createSketchProject(carryDrawing?project:null);
    sketchWorkspaceSession={project:draft,history:new History(draft),selected:null,tool:'pencil',dirty:Boolean(carryDrawing),compare:false,view:{x:0,y:0,zoom:1},brushSettings:{...brushSettings,pencil:6},brushColors:{...brushColors,pencil:'#252525'}};
  }
  const next=sketchWorkspaceSession;sketchWorkspaceSession=null;restoreWorkspaceSession(next);fit();if(route)sketchLocation(true);
  toast('Sketch workspace ready. Draw, then highlight subjects or use Auto detect.');
}
function leaveSketchWorkspace({route=true}={}){
  checkDesktopSheetReady();if(!isSketchProject(project))return;
  sketchWorkspaceSession=captureWorkspaceSession();
  const blank=newProject(),next=mainWorkspaceSession||{project:blank,history:new History(blank),selected:null,tool:'move',dirty:false,compare:false,view:{x:0,y:0,zoom:1},brushSettings:{...brushSettings},brushColors:{pencil:'#eba76f',highlight:'#ffff00'}};
  mainWorkspaceSession=null;restoreWorkspaceSession(next);if(route)sketchLocation(false);
  toast('Back in the editor. Your sketch is kept here; use Draw / sketch reference to continue it.');
}
function workflowControlsBusy(){
  return busy||copying||Boolean(gesture)||localDetection.running||guidedSelection.active||desktopImageGeneration.bridge.state().working||desktopSheetCreation.bridge.state().working||Boolean(desktopSheetCreation.sheet.state?.().busy)||Boolean(desktopSheetCreation.sheet.state?.().photoEditing);
}
function workflowSettings(){return Object.fromEntries(['image','sheet'].map(kind=>{const state=jobBridge(kind).state();return [kind,{model:state.model,quality:state.quality,complexity:state.complexity}];}));}
function captureWorkflow(){
  const options={reuseHistoryEntries:true};
  return {workspace:encodeWorkspaceSession(captureWorkspaceSession(),options),main:encodeWorkspaceSession(mainWorkspaceSession,options),sketch:encodeWorkspaceSession(sketchWorkspaceSession,options),imageEditActive,sheetOpen:Boolean(desktopSheetCreation.sheet.state?.().opened),settings:workflowSettings(),textDefaults:{...textDefaults},promptDraft:$('prompt').value};
}
function snapshotActiveWorkflow(){
  const tab=workflowEntries.find(tab=>tab.id===activeWorkflowId);if(!tab)return;
  tab.session=captureWorkflow();tab.name=project.name;tab.dirty=dirty||$('prompt').value!==project.prompt;
}
function allWorkflowJobs(){return [...desktopImageGeneration.bridge.state().jobs,...desktopSheetCreation.bridge.state().jobs];}
function renderWorkflowTabs(){
  if(!workflowReady||!workflowTabs)return;
  const jobs=allWorkflowJobs();
  const tabs=workflowEntries.map(tab=>{
    const mapped=(tab.jobIds||[]).map(job=>jobs.find(item=>item.id===job.id&&(item.kind||item.mode)===job.kind)).filter(Boolean);
    const status=mapped.some(job=>job.status==='running')?'running':mapped.some(job=>job.status==='queued')?'queued':mapped.at(-1)?.status||((tab.jobIds||[]).length?'checking':'draft');
    return {id:tab.id,name:tab.id===activeWorkflowId?project.name:tab.name,dirty:tab.id===activeWorkflowId?dirty||$('prompt').value!==project.prompt:tab.dirty,status,jobCount:(tab.jobIds||[]).length,hasResult:mapped.some(job=>job.status==='completed')};
  });
  workflowTabs.update({tabs,activeId:activeWorkflowId,busy:workflowControlsBusy(),savingMessage:workflowSaveMessage});
}
function workflowSignature(){
  // Compare identities and small controls, never serialize image bytes to find an edit.
  return [activeWorkflowId,project,history,history.index,history.entries.length,history.entries.at(-1),mainWorkspaceSession,sketchWorkspaceSession,
    JSON.stringify([selected,tool,dirty,compare,view,brushSettings,brushColors,textDefaults,imageEditActive,$('prompt').value,Boolean(desktopSheetCreation.sheet.state?.().opened),workflowSettings(),workflowEntries.map(tab=>[tab.id,tab.jobIds])])];
}
function noteWorkflowChanges(){
  const current=workflowSignature();
  if(workflowSignatureBefore&&current.every((value,index)=>value===workflowSignatureBefore[index]))return false;
  workflowSignatureBefore=current;workflowRevision++;return true;
}
function scheduleWorkflowSave(){
  clearTimeout(workflowSaveTimer);
  if(workflowIdleSave!==null){globalThis.cancelIdleCallback?.(workflowIdleSave);workflowIdleSave=null;}
  if(workflowStorageBlocked)return;
  workflowSaveTimer=setTimeout(()=>{
    workflowSaveTimer=null;
    if(typeof requestIdleCallback==='function')workflowIdleSave=requestIdleCallback(()=>{workflowIdleSave=null;void persistWorkflows();},{timeout:2500});
    else void persistWorkflows();
  },1200);
}
function workflowChanged(){
  if(!workflowReady||workflowRestoring)return;
  renderWorkflowTabs();
  if(noteWorkflowChanges())scheduleWorkflowSave();
}
function scheduleWorkflowViewChange(){
  if(!workflowReady||workflowRestoring||gesture)return;
  clearTimeout(workflowViewTimer);
  // Pointer-up captures pans immediately; wheel/keyboard view changes settle
  // here without rebuilding the workflow strip for every display frame.
  workflowViewTimer=setTimeout(()=>{workflowViewTimer=null;workflowChanged();},250);
}
async function persistWorkflows(){
  clearTimeout(workflowSaveTimer);workflowSaveTimer=null;
  if(workflowIdleSave!==null){globalThis.cancelIdleCallback?.(workflowIdleSave);workflowIdleSave=null;}
  if(!workflowReady||workflowRestoring||workflowStorageBlocked)return;
  noteWorkflowChanges();if(workflowRevision===workflowSavedRevision)return;
  // Never copy or persist a half-finished stroke while the user is interacting.
  if(gesture||busy||copying||textDraft){scheduleWorkflowSave();return;}
  if(workflowSaving){workflowSaveAgain=true;return;}
  const revision=workflowRevision;
  workflowSaving=true;workflowSaveMessage='Saving tabs…';renderWorkflowTabs();
  try{snapshotActiveWorkflow();await workflowStore.save({tabs:workflowEntries,activeId:activeWorkflowId},{detachedTabSessions:true});workflowSavedRevision=revision;workflowSaveMessage='Tabs saved on this PC';}
  catch(error){workflowSaveMessage=error.message;workflowStorageBlocked=error.code==='WORKFLOW_STORAGE_CONFLICT'||error.code==='WORKFLOW_STORAGE_INVALID';toast(error.message,true);}
  finally{workflowSaving=false;renderWorkflowTabs();if(workflowSaveAgain||workflowRevision!==revision){workflowSaveAgain=false;scheduleWorkflowSave();}}
}
function checkWorkflowSwitch(){
  if(workflowControlsBusy())throw new Error('Wait for the current upload, drawing, detection or photo edit to finish. Background generations can keep running.');
  desktopSheetCreation.sheet.flush();checkDesktopSheetReady();
}
function setWorkflowGenerationContext(tab){
  const session=tab.session;
  void desktopImageGeneration.switchWorkflow({jobIds:tab.jobIds||[],settings:session.settings?.image}).catch(error=>toast(error.message,true));
  void desktopSheetCreation.sheet.switchWorkflow({jobIds:tab.jobIds||[],settings:session.settings?.sheet}).catch(error=>toast(error.message,true));
}
function openRestoredWorkflowSheet(id){
  const root=document.documentElement;
  if(root.dataset.startup!=='playing'){if(activeWorkflowId===id)desktopSheetCreation.sheet.open();return;}
  // Let startup release its inert/focus ownership before the sheet takes over.
  const observer=new MutationObserver(()=>{
    if(root.dataset.startup==='playing')return;
    observer.disconnect();
    if(activeWorkflowId===id)desktopSheetCreation.sheet.open();
  });
  observer.observe(root,{attributes:true,attributeFilter:['data-startup']});
}
function restoreWorkflow(tab,{fitView=false}={}){
  const session=tab.session,next=decodeWorkspaceSession(session.workspace),main=decodeOptionalWorkspace(session.main),sketch=decodeOptionalWorkspace(session.sketch);
  workflowRestoring=true;
  try{
    desktopSheetCreation.sheet.close({preserveProject:true});
    mainWorkspaceSession=main;sketchWorkspaceSession=sketch;imageEditActive=Boolean(session.imageEditActive)&&!isSketchProject(next.project);
    activeWorkflowId=tab.id;Object.assign(textDefaults,session.textDefaults||{});restoreWorkspaceSession(next);
    if(typeof session.promptDraft==='string'){$('prompt').value=session.promptDraft;editSummaryView.update({...project,prompt:session.promptDraft},selected);}
    setWorkflowGenerationContext(tab);sketchLocation(isSketchProject(project),true);
    if(session.sheetOpen)openRestoredWorkflowSheet(tab.id);
    const restoredId=tab.id,restoredView={...next.view};requestAnimationFrame(()=>requestAnimationFrame(()=>{if(activeWorkflowId===restoredId){if(fitView)fit();else{view=restoredView;updateView();}}}));
  }finally{workflowRestoring=false;renderWorkflowTabs();}
}
function decodeOptionalWorkspace(value){return value?decodeWorkspaceSession(value):null;}
function selectWorkflow(id){
  if(id===activeWorkflowId)return;
  const next=workflowEntries.find(tab=>tab.id===id);if(!next)return;
  checkWorkflowSwitch();snapshotActiveWorkflow();restoreWorkflow(next);void persistWorkflows();
}
function newWorkflowSession(next=newProject(),{dirty:isDirty=false,imageEdit=false,sheet=false}={}){
  return {workspace:encodeWorkspaceSession({project:next,history:new History(next),selected:next.layers.at(-1)?.id||null,tool:imageEdit?'select':isSketchProject(next)?'pencil':'move',dirty:isDirty,compare:false,view:{x:0,y:0,zoom:1,angle:0},brushSettings:{...brushSettings},brushColors:{...brushColors}}),main:null,sketch:null,imageEditActive:imageEdit,sheetOpen:sheet,settings:workflowSettings(),textDefaults:{...textDefaults},promptDraft:next.prompt};
}
function addWorkflow(next=newProject(),options={}){
  snapshotActiveWorkflow();
  const tab={id:crypto.randomUUID(),name:next.name,dirty:Boolean(options.dirty),jobIds:options.jobIds||[],session:newWorkflowSession(next,options)};
  if(options.settings)tab.session.settings={...tab.session.settings,...options.settings};
  workflowEntries.push(tab);restoreWorkflow(tab,{fitView:true});fit();void persistWorkflows();return tab;
}
function newWorkflow(){checkWorkflowSwitch();addWorkflow();toast('New tab ready. Your other workflows and queued jobs are kept.');}
function closeWorkflow(id){
  checkWorkflowSwitch();snapshotActiveWorkflow();const tab=workflowEntries.find(item=>item.id===id);if(!tab)return;
  const remove=()=>{
    $('dialog').close();const index=workflowEntries.findIndex(item=>item.id===id);
    workflowEntries.splice(index,1);
    if(id===activeWorkflowId){activeWorkflowId=null;if(workflowEntries.length)restoreWorkflow(workflowEntries[Math.min(index,workflowEntries.length-1)]);else addWorkflow();}
    renderWorkflowTabs();void persistWorkflows();
  };
  if(tab.dirty||tab.session.main?.dirty||tab.session.sketch?.dirty)modal('Close this workflow tab?',`<p class="dialog-note">${esc(tab.name)} has edits that have not been saved as a project file. Closing this tab removes its current draft. Running jobs keep going, and their submitted setup stays in Job queue.</p>`,'Close tab',remove);else remove();
}
function beforeWorkflowGenerate(kind){
  if(!workflowReady)return;
  if(jobBridge(kind==='sheet'?'image':'sheet').state().working)throw new Error('Wait for the other job to finish uploading. Once queued, you can start another generation.');
  checkDesktopSheetReady();
  let tab=workflowEntries.find(item=>item.id===activeWorkflowId);snapshotActiveWorkflow();
  if(tab.jobIds?.length){
    const session=cloneWorkflowData(tab.session);
    tab={id:crypto.randomUUID(),name:project.name,dirty,jobIds:[],session};workflowEntries.push(tab);activeWorkflowId=tab.id;
    // Fork the mutable history object too: later Undo/Redo belongs to this job.
    history=decodeWorkspaceSession(session.workspace).history;
    mainWorkspaceSession=decodeOptionalWorkspace(session.main);sketchWorkspaceSession=decodeOptionalWorkspace(session.sketch);
    setWorkflowGenerationContext(tab);renderWorkflowTabs();
  }
  workflowGenerationOwners[kind]=tab.id;void persistWorkflows();
}
function jobQueued(kind,record){
  const tab=workflowEntries.find(item=>item.jobIds?.some(job=>job.id===record.id&&job.kind===kind))||workflowEntries.find(item=>item.id===workflowGenerationOwners[kind])||workflowEntries.find(item=>item.id===activeWorkflowId);
  if(tab&&!tab.jobIds.some(job=>job.id===record.id&&job.kind===kind))tab.jobIds.push({id:record.id,kind});
  if(tab?.id===activeWorkflowId){snapshotActiveWorkflow();setWorkflowGenerationContext(tab);}
  workflowGenerationOwners[kind]=null;workflowChanged();void persistWorkflows();void generationQueue?.refresh();
}
async function openWorkflowResult(id){
  const tab=workflowEntries.find(item=>item.id===id);if(!tab)return;
  if(id!==activeWorkflowId)selectWorkflow(id);
  const records=allWorkflowJobs(),job=[...(tab.jobIds||[])].reverse().find(job=>records.some(record=>record.id===job.id&&record.status==='completed'));
  if(!job)return;
  desktopSheetCreation.sheet.close({preserveProject:true});await openQueueJob(job,'view');
}
async function initializeWorkflows(){
  workflowStore=createWorkflowSessionStore();
  let saved;
  try{
    saved=await workflowStore.load();
    if(saved?.tabs.length){for(const tab of saved.tabs){decodeWorkspaceSession(tab.session?.workspace);decodeOptionalWorkspace(tab.session.main);decodeOptionalWorkspace(tab.session.sketch);if(!Array.isArray(tab.jobIds))throw new Error('Saved workflow job links are invalid.');}workflowEntries=saved.tabs;activeWorkflowId=saved.activeId;}
  }catch(error){workflowStorageBlocked=true;workflowSaveMessage=error.message;toast(error.message,true);}
  if(!workflowEntries.length){activeWorkflowId=crypto.randomUUID();workflowEntries=[{id:activeWorkflowId,name:project.name,dirty,jobIds:[],session:captureWorkflow()}];}
  workflowTabs=mountWorkflowTabs({onSelect:selectWorkflow,onNew:newWorkflow,onClose:closeWorkflow,onOpenQueue:()=>generationQueue.open(),onOpenResult:openWorkflowResult,onError:error=>toast(error?.message||String(error),true)});
  workflowReady=true;restoreWorkflow(workflowEntries.find(tab=>tab.id===activeWorkflowId),{fitView:!saved?.tabs.length});
  for(const bridge of [desktopImageGeneration.bridge,desktopSheetCreation.bridge])bridge.subscribe(event=>{if(event.type==='settings')workflowChanged();else renderWorkflowTabs();});
  const openFile=$('projectInput').onchange;
  $('openProject').onclick=()=>{try{checkWorkflowSwitch();choose('projectInput');}catch(error){toast(error.message,true);}};
  $('projectInput').onchange=event=>{
    if(!event.target.files?.length)return;
    try{checkWorkflowSwitch();openFile(event);}catch(error){toast(error.message,true);}
  };
  $('prompt').addEventListener('input',workflowChanged);
  document.addEventListener('pointerup',()=>{if(workflowReady&&!workflowRestoring)workflowChanged();});
  document.addEventListener('visibilitychange',()=>{if(document.hidden)void persistWorkflows();});window.addEventListener('pagehide',()=>void persistWorkflows());
  if(!saved?.tabs.length&&!workflowStorageBlocked)void persistWorkflows();
}
const legacyCreateBlankCanvas=$('newProject').onclick;
const createBlankCanvas=()=>{
  if(!workflowReady){legacyCreateBlankCanvas();return;}
  try{
    checkWorkflowSwitch();const sketch=isSketchProject(project);
    modal('Create a canvas','<label class="dialog-field">Project name<input id="nameField" value="Untitled" maxlength="200"></label><div class="dialog-grid"><label class="dialog-field">Width (px)<input id="widthField" type="number" min="1" max="8192" value="1600" required></label><label class="dialog-field">Height (px)<input id="heightField" type="number" min="1" max="8192" value="1000" required></label></div><p class="dialog-note">Opens a new workflow tab. Your current work and queued jobs stay available.</p>','Create canvas',()=>{
      let next=newProject(Number($('widthField').value),Number($('heightField').value),$('nameField').value.trim()||'Untitled');if(sketch)next=createSketchProject(next);
      $('dialog').close();addWorkflow(next);
    });
  }catch(error){toast(error.message,true);}
};
const desktopSheetCreation=mountDesktopSheetCreation({editor:desktopSheetEditor,showCanvasCreator:createBlankCanvas,onStatus:toast,
  download(blob,name){download(blob,name);return {initiated:true,status:'requested',name};},
  onQueued:record=>jobQueued('sheet',record),beforeGenerate:()=>beforeWorkflowGenerate('sheet'),onOpenQueue:()=>generationQueue?.open(),
});
const desktopImageGeneration=mountDesktopImageGeneration({editor:desktopSheetEditor,onStatus:toast,onQueued:record=>jobQueued('image',record),beforeGenerate:()=>beforeWorkflowGenerate('image'),download(blob,name){download(blob,name);}});
const jobBridge=kind=>kind==='sheet'?desktopSheetCreation.bridge:desktopImageGeneration.bridge;
async function openQueueJob({kind,id},action){
  if(action==='workflow'){
    const existing=workflowEntries.find(tab=>tab.jobIds.some(job=>job.id===id&&job.kind===kind));
    if(existing){if(existing.id!==activeWorkflowId)selectWorkflow(existing.id);return;}
    checkWorkflowSwitch();const expectedId=activeWorkflowId,expected=JSON.stringify(desktopSheetEditor.peek());
    const record=await loadGenerationRecord(id,{kind}),source=await loadGenerationProject(record,{kind});
    if(activeWorkflowId!==expectedId||JSON.stringify(desktopSheetEditor.peek())!==expected)throw new Error('Your workflow changed while loading this job. Open it again.');
    addWorkflow(source,{jobIds:[{kind,id}],settings:{[kind]:record.settings},sheet:kind==='sheet'});return;
  }
  const expected=action==='view'?null:JSON.stringify(desktopSheetEditor.snapshot());
  const record=await loadGenerationRecord(id,{kind});
  if(expected!==null&&JSON.stringify(desktopSheetEditor.peek())!==expected)throw new Error('Your project changed while opening this job. Choose the job action again.');
  if(action==='view'){desktopImageGeneration.showResult(record,{kind,generationBridge:jobBridge(kind)});return;}
  if(action==='edit'){await jobBridge(kind).editOutput(record);return;}
  await jobBridge(kind).restoreSource(record);
  if(kind==='sheet')desktopSheetCreation.sheet.open();
}
generationQueue=mountGenerationQueue({
  onOpenResult:job=>openQueueJob(job,'view'),onEditOutput:job=>openQueueJob(job,'edit'),onRedo:job=>openQueueJob(job,'redo'),
  onOpenWorkflow:job=>openQueueJob(job,'workflow'),onNewProject:newWorkflow,
  onError:error=>toast(error?.message||String(error),true),
});
sketchWorkspace=mountSketchWorkspace({onOpen:enterSketchWorkspace,onBack:leaveSketchWorkspace,onTool:next=>setTool(next,false),onError:message=>toast(message,true)});
imageEditGeneration=desktopImageGeneration.bridge;
imageEditWorkspace=mountImageEditWorkspace({onOpen:enterImageEditWorkspace,onBack:leaveImageEditWorkspace,onImport:()=>choose('imageInput'),onAutoDetect:()=>runDetection(),onTool:next=>setTool(next,false),onBrushSize:size=>{$('brushSize').value=size;$('brushSize').oninput();},onErase:eraseEditSelection,onRemoveFill:removeAndFillSelection,onReferences:()=>{const area=editSelectedArea();if(area)openReferenceDialog(area.id);},onSelectArea:id=>{checkDesktopSheetReady();selected=id;setTool('select',false);refresh();},onClear:()=>{checkDesktopSheetReady();selected=null;setTool('select',false);refresh();},onError:message=>toast(message,true)});
imageEditGeneration.subscribe(syncImageEditWorkspace);
rotationControls=mountRotationControls({onViewChange:changeViewRotation,onLayerChange:changeLayerRotation,onError:message=>toast(message,true)});syncRotationControls();
mainImageSearch=mountMainImageSearch({getProject:()=>project,beforeOpen:checkDesktopSheetReady,onError:message=>toast(message,true),
  async onImport(files,expectedProject,canCommit){
    if(busy||project!==expectedProject)throw new Error('The canvas changed. Close image search and try again.');
    busy=true;document.body.classList.add('busy');refresh();
    try{await importRasterFiles(files,false,false,canCommit);toast('Image ready. Use Auto detect, or Highlight subjects and choose Detect marked area.');}
    finally{busy=false;document.body.classList.remove('busy');refresh();}
  },
});
window.addEventListener('popstate',()=>{try{const workspace=new URL(location.href).searchParams.get('workspace');if(workspace==='sketch')enterSketchWorkspace({route:false});else if(workspace==='edit')enterImageEditWorkspace({route:false});else{leaveSketchWorkspace({route:false});if(imageEditActive)leaveImageEditWorkspace({route:false});}}catch(error){sketchLocation(isSketchProject(project),true);toast(error.message,true);}});
if(new URL(location.href).searchParams.get('workspace')==='sketch')enterSketchWorkspace({route:false});
if(new URL(location.href).searchParams.get('workspace')==='edit')enterImageEditWorkspace({route:false});
new ResizeObserver(()=>fit()).observe(stage);refresh();fit();await initializeWorkflows();document.documentElement.dataset.ready='true';
async function openHistoryGeneration(){
  const params=new URL(location.href).searchParams,id=params.get('generation'),action=params.get('action'),kind=params.get('kind')==='sheet'?'sheet':'image';
  if(!id||!['edit','redo'].includes(action))return;
  const initial=project;let next,record;
  busy=true;document.body.classList.add('busy');refresh();
  try{
    record=await loadGenerationRecord(id,{kind});
    next=action==='redo'?await loadGenerationProject(record,{kind}):await buildOutputProject(record.image);
    if(project!==initial||$('prompt').value!==initial.prompt)throw new Error('The canvas changed while opening this generation. Open it from History again.');
  }catch(error){toast(error.message,true);return;}
  finally{busy=false;document.body.classList.remove('busy');refresh();}
  try{
    applyGenerationProject(next,action==='redo'?'Restore generation setup':'Edit generated output');
    if(action==='redo'){
      desktopImageGeneration.bridge.useSettings(record);
      if(kind==='sheet')desktopSheetCreation.sheet.useGenerationSettings?.(record);
    }
    const url=new URL(location.href);for(const key of ['generation','kind','action'])url.searchParams.delete(key);window.history.replaceState({},'',url);
  }catch(error){toast(error.message,true);}
}
void openHistoryGeneration();

