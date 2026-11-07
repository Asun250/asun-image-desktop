import {newProject,addRaster,validateProject} from './core.mjs';
import {isSketchProject,sketchSurfaceLayer} from './sketch-project.mjs';

function paper(width,height) {
  const canvas=document.createElement('canvas');canvas.width=width;canvas.height=height;
  const context=canvas.getContext('2d');context.fillStyle='#ffffff';context.fillRect(0,0,width,height);
  return {name:'Sketch drawing surface',width,height,source:canvas.toDataURL('image/png')};
}
export function createSketchProject(existing=null) {
  if(isSketchProject(existing))return structuredClone(existing);
  const base=existing?structuredClone(existing):newProject(1600,1000,'Sketch reference');
  delete base.sheetPreset;
  const result=addRaster(base,paper(base.width,base.height),{fitDocument:false}),surface=result.project.layers.pop();
  result.project.layers.unshift(surface);
  result.project.sketch={version:1,background:'#ffffff',surfaceLayerId:surface.id};
  if(result.project.name==='Untitled')result.project.name='Sketch reference';
  return validateProject(result.project);
}
// A white raster anchors native selection masks. The actual drawing remains
// independent editable strokes, never baked into this surface.
export function normalizeSketchSurface(project) {
  if(!isSketchProject(project))return project;
  const surface=sketchSurfaceLayer(project),asset=project.assets[surface?.assetId];
  if(!surface||!asset)throw new Error('Keep the sketch drawing surface. Use a new canvas to start again.');
  const resized=surface.width!==project.width||surface.height!==project.height||asset.width!==project.width||asset.height!==project.height||surface.x!==0||surface.y!==0;
  if(resized&&project.layers.some(layer=>layer.objectRegion))throw new Error('Remove numbered selections before resizing or cropping the sketch. Your drawing stays editable.');
  if(!resized&&surface.visible&&surface.opacity===1&&!surface.mask.length)return project;
  const next=structuredClone(project),layer=next.layers.find(item=>item.id===surface.id);
  if(resized){
    const image=paper(next.width,next.height),id=crypto.randomUUID();next.assets[id]={...image,id};layer.assetId=id;
    if(next.original?.assetId===surface.assetId)next.original={assetId:id,width:next.width,height:next.height};
  }
  Object.assign(layer,{x:0,y:0,width:next.width,height:next.height,visible:true,opacity:1,mask:[]});
  return next;
}
export function mountSketchWorkspace({onOpen,onBack,onTool,onError}) {
  const entry=document.createElement('button');entry.id='drawSketchReference';entry.type='button';entry.textContent='✎ Draw / sketch reference';entry.title='Draw a scene, select its subjects and add references';
  document.querySelector('.header-tabs').insertBefore(entry,document.getElementById('characterItemSheet'));
  const bar=document.createElement('section');bar.id='sketchWorkspaceBar';bar.hidden=true;bar.setAttribute('aria-label','Draw / sketch reference workspace');
  bar.innerHTML='<div class="sketch-workspace-heading"><button id="sketchBack" type="button">← Back to editor</button><div><h1>Draw / sketch reference</h1><p>Draw your scene → highlight subjects or Auto detect → add references to each number.</p></div></div><div class="sketch-workspace-actions"><button id="sketchDraw" type="button">✎ Draw</button><button id="sketchHighlight" type="button">▰ Highlight subjects</button><button id="sketchSelect" type="button">◎ Select areas</button><span>Your strokes stay editable. Save keeps the whole sketch.</span></div>';
  document.querySelector('#app > .header').after(bar);
  const safe=action=>()=>{try{action();}catch(error){onError(error.message);}};
  entry.onclick=safe(onOpen);bar.querySelector('#sketchBack').onclick=safe(onBack);
  for(const [id,tool] of [['sketchDraw','pencil'],['sketchHighlight','highlight'],['sketchSelect','detect']])bar.querySelector('#'+id).onclick=safe(()=>onTool(tool));
  const card=document.createElement('button');card.type='button';card.className='desktop-create-image-edit';card.id='createSketchCard';
  card.innerHTML='<span class="desktop-create-canvas-icon" aria-hidden="true">✎</span><span><strong>Draw / sketch reference</strong><small>Draw your own scene. Detect or highlight subjects, then attach photos and instructions.</small></span><span aria-hidden="true">→</span>';
  card.onclick=()=>{document.getElementById('desktopCreateDialog')?.close();safe(onOpen)();};
  document.querySelector('.desktop-create-options')?.append(card);
  return {sync(active,tool){
    document.body.classList.toggle('sketch-workspace',active);bar.hidden=!active;entry.setAttribute('aria-pressed',String(active));
    document.getElementById('editTab').classList.toggle('active',!active);entry.classList.toggle('active',active);
    for(const [id,value] of [['sketchDraw','pencil'],['sketchHighlight','highlight'],['sketchSelect','detect']])bar.querySelector('#'+id).setAttribute('aria-pressed',String(tool===value));
    document.getElementById('prompt').placeholder=active?'Describe how your sketch should become a finished scene…':'Describe the edit you have in mind…';
  }};
}
