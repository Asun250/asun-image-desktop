const boundedAngle=value=>Math.max(-180,Math.min(180,Math.round((Number(value)||0)*10)/10));
const wrappedAngle=value=>{const angle=((Number(value)+180)%360+360)%360-180;return Math.round(angle*10)/10;};

// View rotation changes the workspace camera. Image rotation changes a selected
// native raster layer; the editor owns preview, commit and Undo semantics.
export function mountRotationControls({onViewChange,onLayerChange,onError=()=>{}}) {
  if(!document.querySelector('link[data-rotation-controls]')){
    const style=document.createElement('link');style.rel='stylesheet';style.href=new URL('./rotation-controls.css',import.meta.url).href;style.dataset.rotationControls='';document.head.append(style);
  }
  let state={viewAngle:0,layerAngle:0,hasRaster:false,busy:false};
  const run=async action=>{try{await action();}catch(error){onError(error?.message||String(error));}};
  const trigger=document.createElement('button');trigger.id='rotateView';trigger.type='button';trigger.setAttribute('aria-label','Rotate view');trigger.setAttribute('aria-controls','viewRotationPanel');trigger.setAttribute('aria-expanded','false');trigger.setAttribute('aria-haspopup','dialog');trigger.title='Rotate the canvas view for easier painting; exported images stay unchanged';
  trigger.innerHTML='<span class="rotation-trigger-icon" aria-hidden="true">↻</span><span class="rotation-trigger-label">Rotate view</span><span id="viewRotationReadout">0°</span>';
  document.getElementById('fit').after(trigger);
  const panel=document.createElement('section');panel.id='viewRotationPanel';panel.hidden=true;panel.setAttribute('role','dialog');panel.setAttribute('aria-modal','false');panel.setAttribute('aria-labelledby','viewRotationTitle');
  panel.innerHTML=`<header><h2 id="viewRotationTitle">Rotate view</h2><button id="closeViewRotation" type="button" aria-label="Close view rotation">×</button></header><p>Turn the canvas to draw or mask comfortably. This does not rotate your saved image.</p><div class="rotation-value-row"><label for="viewRotation">View angle</label><label class="rotation-number"><input id="viewRotationValue" type="number" min="-180" max="180" step="1" value="0" aria-label="View rotation in degrees"><span aria-hidden="true">°</span></label></div><input id="viewRotation" type="range" min="-180" max="180" step="1" value="0" aria-label="View rotation"><div class="rotation-actions"><button id="viewRotationLeft" type="button" title="Rotate view 90 degrees left">↶ −90°</button><button id="resetViewRotation" type="button">Reset 0°</button><button id="viewRotationRight" type="button" title="Rotate view 90 degrees right">↷ +90°</button></div>`;
  document.body.append(panel);
  const layer=document.createElement('section');layer.id='layerRotationControls';layer.setAttribute('aria-labelledby','layerRotationTitle');
  layer.innerHTML=`<h3 id="layerRotationTitle">Rotate image layer</h3><p id="layerRotationHelp">Select an image layer to rotate it in your saved output.</p><fieldset id="layerRotationFields" disabled><div class="rotation-value-row"><label for="layerRotation">Image angle</label><label class="rotation-number"><input id="layerRotationValue" type="number" min="-180" max="180" step="1" value="0" aria-label="Image layer rotation in degrees"><span aria-hidden="true">°</span></label></div><input id="layerRotation" type="range" min="-180" max="180" step="1" value="0" aria-label="Image layer rotation"><div class="rotation-actions"><button id="layerRotationLeft" type="button" title="Rotate image layer 90 degrees left">↶ −90°</button><button id="resetLayerRotation" type="button">Reset 0°</button><button id="layerRotationRight" type="button" title="Rotate image layer 90 degrees right">↷ +90°</button></div></fieldset>`;
  document.querySelector('#transformPanel .property-body').append(layer);
  const byId=id=>document.getElementById(id);
  function position(){
    if(panel.hidden)return;const rect=trigger.getBoundingClientRect(),width=panel.getBoundingClientRect().width||292;
    panel.style.left=`${Math.max(8,Math.min(innerWidth-width-8,rect.right-width))}px`;
    const height=panel.getBoundingClientRect().height;panel.style.top=`${Math.max(8,Math.min(innerHeight-height-8,rect.bottom+8))}px`;
  }
  function close({focus=false}={}){panel.hidden=true;trigger.setAttribute('aria-expanded','false');if(focus)trigger.focus();}
  trigger.onclick=()=>{if(!panel.hidden){close();return;}panel.hidden=false;trigger.setAttribute('aria-expanded','true');position();};
  byId('closeViewRotation').onclick=()=>close({focus:true});
  document.addEventListener('pointerdown',event=>{if(!panel.hidden&&!panel.contains(event.target)&&!trigger.contains(event.target))close();},true);
  document.addEventListener('keydown',event=>{if(event.key==='Escape'&&!panel.hidden){event.preventDefault();event.stopPropagation();close({focus:true});}},true);
  window.addEventListener('resize',position);window.addEventListener('scroll',position,true);
  function emit(kind,value,commit){
    const angle=boundedAngle(value);if(state.busy||(kind==='layer'&&!state.hasRaster))return;
    const callback=kind==='view'?onViewChange:onLayerChange;
    return run(()=>callback?.(angle,{commit}));
  }
  function connect(kind){
    const prefix=kind==='view'?'viewRotation':'layerRotation',slider=byId(prefix),number=byId(prefix+'Value');
    const update=(value,commit)=>{const angle=boundedAngle(value);slider.value=String(angle);if(document.activeElement!==number||commit)number.value=String(angle);return emit(kind,angle,commit);};
    slider.oninput=()=>update(slider.value,false);slider.onchange=()=>update(slider.value,true);
    number.oninput=()=>{if(number.value!==''&&Number.isFinite(number.valueAsNumber))update(number.valueAsNumber,false);};
    number.onchange=()=>update(number.value===''?state[kind+'Angle']:number.valueAsNumber,true);
    number.onkeydown=event=>{if(event.key==='Enter'){event.preventDefault();number.blur();}};
    byId(prefix+'Left').onclick=()=>update(wrappedAngle(state[kind+'Angle']-90),true);
    byId(prefix+'Right').onclick=()=>update(wrappedAngle(state[kind+'Angle']+90),true);
    byId('reset'+prefix[0].toUpperCase()+prefix.slice(1)).onclick=()=>update(0,true);
  }
  connect('view');connect('layer');
  function sync(next={}){
    state={viewAngle:0,layerAngle:0,hasRaster:false,busy:false,...next};
    for(const kind of ['view','layer']){
      const prefix=kind==='view'?'viewRotation':'layerRotation',angle=boundedAngle(state[kind+'Angle']);
      byId(prefix).value=String(angle);if(document.activeElement!==byId(prefix+'Value'))byId(prefix+'Value').value=String(angle);
    }
    byId('viewRotationReadout').textContent=`${boundedAngle(state.viewAngle)}°`;trigger.disabled=Boolean(state.busy);trigger.dataset.rotated=String(Math.abs(state.viewAngle)>0.001);
    for(const control of panel.querySelectorAll('input,.rotation-actions button'))control.disabled=Boolean(state.busy);
    byId('layerRotationFields').disabled=Boolean(state.busy||!state.hasRaster);
    byId('layerRotationHelp').textContent=state.hasRaster?'Rotates this image in the composition and saved output. Undo restores the previous angle.':'Select an image layer to rotate it in your saved output.';
    position();
  }
  sync();return {sync,close};
}
