import {referenceProject,addText,updateText,addDrawing,updateLayer,removeLayer,History,dimensions} from './core.mjs';
import {renderProject} from './render.mjs';
import {createColorWheel} from './color-wheel.mjs';
import {referenceIcon} from './reference-icons.mjs';

const clone=value=>structuredClone(value);

// A reference has its own immutable source photo and editable annotation layers.
// Loading a different photo deliberately starts a new local history. The caller
// flushes first and decides whether those edits belong in its unsaved session.
export function createReferenceEditor(container,{onChange,onError,onExpand,idPrefix='',dialogParent=document.body}={}){
  if(!container)throw new TypeError('A container for the reference editor is required.');
  if(typeof idPrefix!=='string'||!/^[A-Za-z0-9_-]*$/.test(idPrefix))throw new TypeError('Use a valid reference-editor ID prefix.');
  if(!dialogParent?.append)throw new TypeError('A parent for the reference color dialog is required.');
  const stylesheetUrl=new URL('./reference-editor.css',import.meta.url).href;
  if(!Array.from(document.querySelectorAll('link[rel~="stylesheet"]')).some(link=>link.href===stylesheetUrl)){
    const style=document.createElement('link');style.rel='stylesheet';style.href=stylesheetUrl;style.dataset.referenceEditorStyle='true';document.head.append(style);
  }
  container.classList.add('reference-editor');
  container.innerHTML=`<div id="referenceAnnotationToolbar" aria-label="Reference photo annotation tools">
    <div class="ref-tools"><button type="button" data-ref-tool="move" aria-pressed="true">${referenceIcon('move')}<span>Move</span></button><button type="button" data-ref-tool="text" aria-pressed="false">${referenceIcon('text')}<span>Text / number</span></button><button type="button" data-ref-tool="pencil" aria-pressed="false">${referenceIcon('pencil')}<span>Pencil</span></button><button type="button" data-ref-tool="highlight" aria-pressed="false">${referenceIcon('highlight')}<span>Highlight</span></button><button type="button" data-ref-tool="pan" aria-pressed="false" title="Pan the reference photo (H)"><span aria-hidden="true">✋</span><span>Pan</span></button></div>
    <div class="ref-style"><label>Text size <input id="refTextSize" type="number" min="8" max="500" value="24" aria-label="Reference text size"></label><label>Brush <input id="refBrushSize" type="number" min="1" max="500" value="5" aria-label="Reference brush size"></label><label>Color <input id="refColor" type="color" value="#f28a31" aria-label="Reference annotation color"></label><button id="refColorWheel" type="button">${referenceIcon('colorWheel')}<span>Color wheel</span></button></div>
    <div class="ref-actions"><button id="refEdit" type="button" disabled>${referenceIcon('edit')}<span>Edit text</span></button><button id="refUndo" type="button" disabled aria-label="Undo reference annotation">${referenceIcon('undo')}<span>↶</span></button><button id="refRedo" type="button" disabled aria-label="Redo reference annotation">${referenceIcon('redo')}<span>↷</span></button><button id="refDelete" type="button" disabled>${referenceIcon('delete')}<span>Delete</span></button></div>
  </div><div id="referenceViewToolbar" aria-label="Reference photo view controls"><button id="refBackToReferences" type="button" hidden>← Back to references</button><button id="refExpandPhoto" type="button" aria-expanded="false" hidden>⛶ Expand photo</button><div class="ref-zoom-controls"><button id="refZoomOut" type="button" aria-label="Zoom out reference photo">−</button><button id="refZoomPercent" type="button" title="Show reference photo at 100%" aria-label="Show reference photo at 100%">100%</button><button id="refZoomIn" type="button" aria-label="Zoom in reference photo">+</button><button id="refFit" type="button" aria-pressed="true">Fit</button></div></div><div id="refCanvasStage" tabindex="0" aria-label="Annotate this reference photo"><div id="refCanvasBoard"><canvas id="refCanvas"></canvas><canvas id="refDrawingPreview" hidden></canvas><div id="refSelection" hidden></div><textarea id="refTextEditor" aria-label="Reference text annotation" maxlength="10000" spellcheck="false" placeholder="Type a number or label…" hidden></textarea></div><span id="refCanvasEmpty">Choose a reference photo to annotate.</span></div><p id="refAnnotationHint">These edits stay on this reference photo. Its original image stays intact.</p>`;
  // Standalone editors can share the page without colliding with the main
  // References dialog. Defaults preserve the existing public control IDs.
  for(const element of container.querySelectorAll('[id]')){element.dataset.refId=element.id;element.id=idPrefix+element.id;}
  const $=id=>container.querySelector('#'+CSS.escape(idPrefix+id)),stage=$('refCanvasStage'),board=$('refCanvasBoard'),canvas=$('refCanvas'),input=$('refTextEditor');
  const abort=new AbortController(),listen=(target,type,handler,options={})=>target.addEventListener(type,handler,{...options,signal:abort.signal});
  const colors={text:'#f28a31',pencil:'#f44336',highlight:'#ffeb3b'},brushSizes={pencil:5,highlight:24};
  const explicitSizes={text:false,pencil:false,highlight:false};
  let project=null,history=null,selected=null,tool='move',draft=null,gesture=null,view={x:0,y:0,zoom:1},fitMode=true,viewport={width:0,height:0},expanded=false,generation=0,renderGeneration=0,destroyed=false,wheelSession=null,fittedDefaultsPending=false,textDefaultSize=24;
  const colorDialog=document.createElement('dialog');colorDialog.id=idPrefix+'referenceEditorColorDialog';colorDialog.dataset.refId='referenceEditorColorDialog';colorDialog.setAttribute('aria-labelledby',idPrefix+'refcolorPickerTitle');dialogParent.append(colorDialog);
  const report=error=>onError?.(error instanceof Error?error:new Error(String(error)));
  const annotations=()=>project?clone(project.layers.filter(layer=>layer.kind!=='raster')):[];
  const current=()=>project?.layers.find(layer=>layer.id===selected&&layer.kind!=='raster');
  const attempt=action=>{try{return action();}catch(error){report(error);return false;}};
  const emit=()=>{try{onChange?.(annotations());}catch(error){report(error);}};
  let wheel=createColorWheel(colorDialog,{
    idPrefix:idPrefix+'ref',
    onPreview(color){if(wheelSession?.generation!==generation)return;$('refColor').value=color;layoutDraft();},
    onApply(color){if(wheelSession?.generation!==generation)return;wheelSession=null;$('refColor').value=color;applyColor();if(draft)input.focus();},
    onCancel(color){if(wheelSession?.generation!==generation)return;wheelSession=null;$('refColor').value=color;layoutDraft();if(draft)input.focus();}
  });

  function updateSelection(){const layer=current();$('refSelection').hidden=!layer||!layer.visible||tool!=='move'||Boolean(draft);if(layer)Object.assign($('refSelection').style,{left:layer.x+'px',top:layer.y+'px',width:layer.width+'px',height:layer.height+'px'});}
  function syncViewControls(){
    const ready=Boolean(project);
    $('refExpandPhoto').hidden=typeof onExpand!=='function'||expanded;$('refExpandPhoto').disabled=!ready;$('refExpandPhoto').setAttribute('aria-expanded',String(expanded));
    $('refBackToReferences').hidden=typeof onExpand!=='function'||!expanded;
    for(const id of ['refZoomOut','refZoomPercent','refZoomIn','refFit'])$(id).disabled=!ready;
    $('refZoomPercent').textContent=ready?`${Math.round(view.zoom*1000)/10}%`:'100%';$('refFit').setAttribute('aria-pressed',String(fitMode));
    container.dataset.refExpanded=String(expanded);
  }
  function applyView(){
    syncViewControls();if(!project)return;
    board.style.width=project.width+'px';board.style.height=project.height+'px';board.style.transform=`translate(${view.x}px,${view.y}px) scale(${view.zoom})`;board.style.setProperty('--ref-inverse-zoom',1/view.zoom);updateSelection();layoutDraft();
  }
  function fit(){
    if(!project||!stage.clientWidth||!stage.clientHeight)return;
    fitMode=true;viewport={width:stage.clientWidth,height:stage.clientHeight};
    view.zoom=Math.min(2,(stage.clientWidth-24)/project.width,(stage.clientHeight-24)/project.height);
    if(fittedDefaultsPending&&view.zoom>0){
      if(!explicitSizes.text)textDefaultSize=Math.max(8,Math.min(500,Math.round(24/view.zoom)));
      $('refTextSize').value=textDefaultSize;
      for(const mode of ['pencil','highlight'])if(!explicitSizes[mode])brushSizes[mode]=Math.max(1,Math.min(500,Math.round((mode==='pencil'?5:24)/view.zoom)));
      if(['pencil','highlight'].includes(tool))$('refBrushSize').value=brushSizes[tool];
      fittedDefaultsPending=false;
    }
    view.x=(stage.clientWidth-project.width*view.zoom)/2;view.y=(stage.clientHeight-project.height*view.zoom)/2;
    applyView();
  }
  function resizeView(){
    const width=stage.clientWidth,height=stage.clientHeight;if(!project||!width||!height)return;
    if(fitMode){fit();return;}
    if(viewport.width&&viewport.height){view.x+=(width-viewport.width)/2;view.y+=(height-viewport.height)/2;}
    viewport={width,height};applyView();
  }
  function zoomTo(value,anchor={x:stage.clientWidth/2,y:stage.clientHeight/2}){
    if(!project||gesture)return;const minZoom=Math.min(.01,(stage.clientWidth-24)/project.width,(stage.clientHeight-24)/project.height),zoom=Math.max(Math.max(.0001,minZoom),Math.min(16,value));
    const x=(anchor.x-view.x)/view.zoom,y=(anchor.y-view.y)/view.zoom;fitMode=false;view={x:anchor.x-x*zoom,y:anchor.y-y*zoom,zoom};viewport={width:stage.clientWidth,height:stage.clientHeight};applyView();
  }
  async function redraw(){
    if(!project||destroyed)return;const token=++renderGeneration,loaded=generation;
    const snapshot=draft?.id?{...project,layers:project.layers.filter(layer=>layer.id!==draft.id)}:project;
    try{const temp=document.createElement('canvas');await renderProject(snapshot,temp);if(destroyed||loaded!==generation||token!==renderGeneration)return;canvas.width=temp.width;canvas.height=temp.height;canvas.getContext('2d').drawImage(temp,0,0);container.dataset.refReady='true';}
    catch(error){if(!destroyed&&loaded===generation&&token===renderGeneration)report(error);}
  }
  function refresh(){
    if(!current())selected=null;const layer=current(),ready=Boolean(project);
    $('refCanvasEmpty').hidden=ready;board.hidden=!ready;
    for(const button of container.querySelectorAll('[data-ref-tool]')){button.disabled=!ready;button.classList.toggle('active',button.dataset.refTool===tool);button.setAttribute('aria-pressed',String(button.dataset.refTool===tool));}
    $('refUndo').disabled=!history?.canUndo;$('refRedo').disabled=!history?.canRedo;$('refDelete').disabled=!layer;$('refEdit').disabled=layer?.kind!=='text';
    $('refTextSize').disabled=!ready;$('refBrushSize').disabled=!ready;$('refColor').disabled=!ready;$('refColorWheel').disabled=!ready;
    $('refTextSize').closest('label').hidden=!ready||!(tool==='text'||layer?.kind==='text'||draft);$('refBrushSize').closest('label').hidden=!['pencil','highlight'].includes(tool);
    $('refAnnotationHint').textContent=(tool==='text'?'Click the photo, type, then Enter to place. Shift+Enter adds a line; Esc cancels.':tool==='pencil'?'Draw or circle an area. Each stroke stays editable.':tool==='highlight'?'Highlight an area while keeping the photo visible.':tool==='pan'?'Drag to move around the photo. Choose a drawing tool to edit.':'Select or move annotations. Double-click text to edit.')+' Use + / − or Ctrl + scroll to zoom; Fit shows the whole photo.';
    stage.style.cursor=tool==='pan'?'grab':tool==='move'?'default':'crosshair';updateSelection();if(fitMode)fit();else applyView();syncViewControls();redraw();
  }
  function commit(next,label){if(history.commit(next,label)){project=history.project;emit();}refresh();}
  function measure(content,size,fontFamily='Arial'){
    if(!Number.isFinite(size)||size<8||size>500)throw new Error('Choose a reference text size from 8 to 500 px.');
    const ctx=document.createElement('canvas').getContext('2d');ctx.font=`600 ${size}px ${fontFamily}`;
    const padding=Math.ceil(size*.2),lines=content.split('\n'),width=Math.max(1,Math.ceil(Math.max(...lines.map(line=>ctx.measureText(line).width))+padding*2)),height=Math.max(1,Math.ceil(lines.length*size*1.25+padding*2));
    dimensions(width,height);return {width,height,padding};
  }
  function layoutDraft(){if(!draft)return;const size=Number($('refTextSize').value);let m;try{m=measure(input.value,size,draft.fontFamily);}catch{return;}Object.assign(input.style,{left:draft.x+'px',top:draft.y+'px',width:Math.max(m.width,100/view.zoom/draft.scaleX)+'px',height:m.height+'px',padding:m.padding+'px',fontSize:size+'px',lineHeight:'1.25',fontFamily:draft.fontFamily,color:$('refColor').value,transform:`scale(${draft.scaleX},${draft.scaleY})`});}
  function startText(p,id=null){
    finishText();const layer=id?project.layers.find(layer=>layer.id===id):null;if(layer){$('refTextSize').value=layer.text.fontSize;$('refColor').value=layer.text.color;selected=id;}
    draft={id,x:layer?layer.x:p.x,y:layer?layer.y:p.y,fontFamily:layer?.text.fontFamily||'Arial',scaleX:layer?layer.width/layer.text.baseWidth:1,scaleY:layer?layer.height/layer.text.baseHeight:1};input.value=layer?.text.content||'';input.hidden=false;layoutDraft();updateSelection();redraw();input.focus();if(layer)input.select();
  }
  function cancelText(){if(!draft)return;draft=null;input.hidden=true;refresh();}
  function finishText(){
    if(!draft)return;if(!input.value.trim()){cancelText();return;}
    const pending=draft,size=Number($('refTextSize').value),m=measure(input.value,size,pending.fontFamily),style={content:input.value,fontSize:size,color:$('refColor').value,fontFamily:pending.fontFamily,width:m.width,height:m.height};
    let next;if(pending.id)next=updateText(project,pending.id,style);else{const result=addText(project,{...style,x:pending.x,y:pending.y});next=result.project;selected=result.layerId;}
    draft=null;input.hidden=true;commit(next,pending.id?'Edit reference text':'Add reference text');
  }
  function finishGesture(cancel=false){
    if(!gesture)return;const action=gesture;gesture=null;$('refDrawingPreview').hidden=true;
    if(action.generation!==generation)return;
    if(action.mode==='pan'){if(cancel){view=action.view;fitMode=action.fitMode;}stage.style.cursor=tool==='pan'?'grab':'default';applyView();return;}
    if(cancel){project=action.before;refresh();return;}
    if(action.mode==='drawing'){const result=addDrawing(action.before,action.stroke);selected=result.layerId;commit(result.project,action.stroke.mode==='highlight'?'Highlight reference':'Draw on reference');}
    else commit(project,'Move reference annotation');
  }
  function setTool(next){finishText();finishGesture();tool=next;if(['text','pencil','highlight'].includes(next))$('refColor').value=colors[next];if(['pencil','highlight'].includes(next))$('refBrushSize').value=brushSizes[next];refresh();}
  function canvasPoint(event){const rect=stage.getBoundingClientRect();return {x:(event.clientX-rect.left-view.x)/view.zoom,y:(event.clientY-rect.top-view.y)/view.zoom};}
  const inside=p=>project&&p.x>=0&&p.y>=0&&p.x<=project.width&&p.y<=project.height;
  function drawPreview(){if(gesture?.mode!=='drawing')return;const c=$('refDrawingPreview'),stroke=gesture.stroke;c.width=project.width;c.height=project.height;c.hidden=false;const ctx=c.getContext('2d');ctx.globalAlpha=stroke.mode==='highlight'?.35:1;ctx.strokeStyle=stroke.color;ctx.lineWidth=stroke.size;ctx.lineCap='round';ctx.lineJoin='round';ctx.beginPath();ctx.moveTo(...stroke.points[0]);if(stroke.points.length===1)ctx.lineTo(stroke.points[0][0]+.01,stroke.points[0][1]);else for(const p of stroke.points.slice(1))ctx.lineTo(...p);ctx.stroke();}
  function applyColor(){if(['text','pencil','highlight'].includes(tool))colors[tool]=$('refColor').value;if(draft){layoutDraft();return;}const layer=current();if(layer?.kind==='text')commit(updateText(project,layer.id,{color:$('refColor').value}),'Color reference text');}
  function changeTextSize(){if(draft){layoutDraft();return;}const layer=current();if(layer?.kind==='text'){const size=Number($('refTextSize').value),m=measure(layer.text.content,size,layer.text.fontFamily);commit(updateText(project,layer.id,{fontSize:size,width:m.width,height:m.height}),'Size reference text');}}
  function undo(){cancelText();finishGesture(true);if(history?.canUndo){project=history.undo();emit();refresh();}}
  function redo(){cancelText();finishGesture(true);if(history?.canRedo){project=history.redo();emit();refresh();}}
  function remove(){finishText();finishGesture();if(current()){const id=selected;selected=null;commit(removeLayer(project,id),'Delete reference annotation');}}

  for(const button of container.querySelectorAll('[data-ref-tool]'))listen(button,'click',()=>attempt(()=>setTool(button.dataset.refTool)));
  listen($('refExpandPhoto'),'click',()=>attempt(()=>onExpand?.(true)));listen($('refBackToReferences'),'click',()=>attempt(()=>onExpand?.(false)));
  listen($('refZoomOut'),'click',()=>zoomTo(view.zoom/1.25));listen($('refZoomIn'),'click',()=>zoomTo(view.zoom*1.25));listen($('refZoomPercent'),'click',()=>zoomTo(1));listen($('refFit'),'click',()=>{if(!gesture)fit();});
  listen($('refUndo'),'click',undo);listen($('refRedo'),'click',redo);listen($('refDelete'),'click',()=>attempt(remove));listen($('refEdit'),'click',()=>attempt(()=>{if(current()?.kind==='text')startText(null,selected);}));
  listen($('refTextSize'),'input',()=>{const size=Number($('refTextSize').value);if(size>=8&&size<=500){explicitSizes.text=true;textDefaultSize=size;}layoutDraft();});listen($('refTextSize'),'change',()=>attempt(changeTextSize));
  listen($('refColor'),'input',layoutDraft);listen($('refColor'),'change',()=>attempt(applyColor));
  listen($('refBrushSize'),'input',()=>{if(['pencil','highlight'].includes(tool)){const size=Number($('refBrushSize').value);brushSizes[tool]=size;if(size>=1&&size<=500)explicitSizes[tool]=true;}});
  listen($('refColorWheel'),'click',()=>{wheelSession={generation};wheel.open($('refColor').value,{title:'Choose reference annotation color'});});
  listen(input,'input',layoutDraft);
  listen(input,'keydown',event=>{if(event.isComposing)return;if(event.key==='Enter'&&!event.shiftKey){event.preventDefault();event.stopPropagation();if(attempt(finishText)!==false)stage.focus();}if(event.key==='Escape'){event.preventDefault();event.stopPropagation();cancelText();stage.focus();}});
  listen(stage,'pointerdown',event=>{
    if(!project||gesture||event.button!==0||event.target===input)return;const p=canvasPoint(event);if(tool!=='pan'&&!inside(p))return;
    event.preventDefault();event.stopPropagation();stage.focus();attempt(()=>{
      finishText();if(tool==='pan'){gesture={mode:'pan',generation,start:{x:event.clientX,y:event.clientY},view:{...view},fitMode};fitMode=false;stage.style.cursor='grabbing';stage.setPointerCapture(event.pointerId);syncViewControls();return;}const before=clone(project);
      if(tool==='text'){startText(p);return;}
      if(['pencil','highlight'].includes(tool)){const size=Number($('refBrushSize').value);if(!Number.isFinite(size)||size<1||size>500)throw new Error('Choose a reference brush size from 1 to 500 px.');gesture={mode:'drawing',before,generation,stroke:{mode:tool,color:$('refColor').value,size,points:[[p.x,p.y]]}};drawPreview();}
      else{const hit=[...project.layers].reverse().find(layer=>layer.kind!=='raster'&&layer.visible&&layer.opacity>0&&p.x>=layer.x&&p.y>=layer.y&&p.x<=layer.x+layer.width&&p.y<=layer.y+layer.height);selected=hit?.id||null;if(hit){if(hit.kind==='text'){$('refTextSize').value=hit.text.fontSize;$('refColor').value=hit.text.color;}gesture={mode:'move',before,generation,start:p,id:hit.id,layer:clone(hit)};}refresh();}
      if(gesture)stage.setPointerCapture(event.pointerId);
    });
  });
  listen(stage,'pointermove',event=>{if(!gesture||gesture.generation!==generation)return;if(gesture.mode==='pan'){view.x=gesture.view.x+event.clientX-gesture.start.x;view.y=gesture.view.y+event.clientY-gesture.start.y;applyView();return;}const p=canvasPoint(event);if(gesture.mode==='drawing'){const points=gesture.stroke.points;if(points.length<50000)points.push([Math.max(0,Math.min(project.width,p.x)),Math.max(0,Math.min(project.height,p.y))]);drawPreview();}
    else{const initial=gesture.layer,x=Math.max(0,Math.min(Math.max(0,project.width-initial.width),initial.x+p.x-gesture.start.x)),y=Math.max(0,Math.min(Math.max(0,project.height-initial.height),initial.y+p.y-gesture.start.y));project={...project,layers:project.layers.map(layer=>layer.id===gesture.id?{...layer,x,y}:layer)};updateSelection();redraw();}
  });
  listen(stage,'pointerup',()=>attempt(()=>finishGesture()));listen(stage,'pointercancel',()=>finishGesture(true));listen(stage,'lostpointercapture',()=>attempt(()=>finishGesture()));
  listen(stage,'wheel',event=>{if(!project||!(event.ctrlKey||event.metaKey))return;event.preventDefault();event.stopPropagation();const rect=stage.getBoundingClientRect();zoomTo(view.zoom*Math.exp(-Math.max(-300,Math.min(300,event.deltaY))*.002),{x:event.clientX-rect.left,y:event.clientY-rect.top});},{passive:false});
  listen(stage,'dblclick',event=>{if(!project||tool==='pan'||event.target===input)return;const p=canvasPoint(event);if(!inside(p))return;const hit=[...project.layers].reverse().find(layer=>layer.kind==='text'&&layer.visible&&p.x>=layer.x&&p.y>=layer.y&&p.x<=layer.x+layer.width&&p.y<=layer.y+layer.height);if(hit){event.preventDefault();event.stopPropagation();attempt(()=>startText(null,hit.id));}});
  listen(container,'keydown',event=>{
    if(!project||event.isComposing)return;const typing=/INPUT|TEXTAREA|SELECT/.test(event.target.tagName),command=event.ctrlKey||event.metaKey,key=event.key.toLowerCase();
    if(event.key==='Escape'&&(draft||gesture)){event.preventDefault();event.stopPropagation();cancelText();finishGesture(true);return;}
    // Enter accepts an annotation control, not the surrounding References form.
    if(event.key==='Enter'&&event.target.tagName==='INPUT'){event.preventDefault();event.stopPropagation();event.target.blur();stage.focus();return;}
    if(typing)return;
    if(command&&['z','y'].includes(key)){event.preventDefault();event.stopPropagation();(key==='y'||event.shiftKey?redo:undo)();return;}
    if(event.key==='Delete'||event.key==='Backspace'){event.preventDefault();event.stopPropagation();attempt(remove);return;}
    if(event.key==='Enter'&&event.target===stage&&current()?.kind==='text'){event.preventDefault();event.stopPropagation();attempt(()=>startText(null,selected));return;}
    const shortcuts={v:'move',t:'text',p:'pencil',l:'highlight',h:'pan'};if(!command&&shortcuts[key]){event.preventDefault();event.stopPropagation();attempt(()=>setTool(shortcuts[key]));return;}
    if(['ArrowLeft','ArrowRight','ArrowUp','ArrowDown'].includes(event.key)&&current()){event.preventDefault();event.stopPropagation();const layer=current(),delta=event.shiftKey?10:1;attempt(()=>commit(updateLayer(project,layer.id,{x:Math.max(0,Math.min(Math.max(0,project.width-layer.width),layer.x+(event.key==='ArrowRight'?delta:event.key==='ArrowLeft'?-delta:0))),y:Math.max(0,Math.min(Math.max(0,project.height-layer.height),layer.y+(event.key==='ArrowDown'?delta:event.key==='ArrowUp'?-delta:0)))}),'Move reference annotation'));}
  });
  const observer=new ResizeObserver(resizeView);observer.observe(stage);refresh();
  function clear(){generation++;renderGeneration++;wheelSession=null;wheel?.close();draft=null;gesture=null;project=null;history=null;selected=null;view={x:0,y:0,zoom:1};viewport={width:0,height:0};fitMode=true;fittedDefaultsPending=false;input.hidden=true;$('refDrawingPreview').hidden=true;canvas.width=1;canvas.height=1;container.dataset.refReady='false';refresh();}
  return {
    load(reference){if(destroyed)throw new Error('This reference editor has been destroyed.');clear();if(!reference)return Promise.resolve();try{project=referenceProject(clone(reference));history=new History(project);selected=null;tool='move';fittedDefaultsPending=true;canvas.width=project.width;canvas.height=project.height;refresh();return redraw();}catch(error){clear();report(error);return Promise.reject(error);}},
    flush(){if(destroyed)return [];try{finishText();finishGesture();return annotations();}catch(error){report(error);throw error;}},
    clear,hasPending:()=>Boolean(draft||gesture),setExpanded(value){expanded=Boolean(value);syncViewControls();},isExpanded:()=>expanded,
    destroy(){if(destroyed)return;clear();destroyed=true;abort.abort();observer.disconnect();colorDialog.remove();wheel=null;container.replaceChildren();container.classList.remove('reference-editor');}
  };
}
