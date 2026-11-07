// The Edit image page reuses the main editor canvas and its native project.
// Selection, masking, history and paid generation remain owned by editor.mjs.
export function mountImageEditWorkspace({onOpen,onBack,onImport,onAutoDetect,onTool,onBrushSize,onErase,onRemoveFill,onReferences,onSelectArea,onClear,onError=()=>{}}) {
  if(!document.querySelector('link[data-image-edit-workspace]')) {
    const style=document.createElement('link');style.rel='stylesheet';style.href=new URL('./image-edit-workspace.css',import.meta.url).href;style.dataset.imageEditWorkspace='';document.head.append(style);
  }
  let current={active:false,areas:[]},areaSignature='';
  const safe=action=>async()=>{try{await action?.();}catch(error){onError(error?.message||String(error));}};
  const entry=document.getElementById('editTab');
  entry.textContent='Edit image';entry.title='Select and erase objects, or remove them and fill the background';entry.setAttribute('aria-pressed','false');entry.onclick=safe(onOpen);
  const bar=document.createElement('section');bar.id='imageEditWorkspaceBar';bar.hidden=true;bar.setAttribute('aria-labelledby','imageEditWorkspaceTitle');
  bar.innerHTML=`<button id="imageEditBack" type="button">← Back to editor</button><div class="image-edit-heading"><h1 id="imageEditWorkspaceTitle">Edit image</h1><p>Select an area, erase or remove it, then review the result.</p></div><span class="image-edit-preserved"><span aria-hidden="true">↶</span> Undo keeps your edits reversible</span>`;
  document.querySelector('#app > .header').after(bar);
  const panel=document.createElement('section');panel.id='imageEditTools';panel.hidden=true;panel.setAttribute('aria-label','Select and remove objects');
  panel.innerHTML=`
    <section class="image-edit-section">
      <h2><span class="image-edit-step">1</span> Select an area</h2>
      <div id="imageEditEmpty"><p>Open a photo or generated image to start editing.</p><button id="imageEditImport" class="primary" type="button">Choose image</button></div>
      <div id="imageEditSelectionTools">
        <div class="image-edit-tool-grid">
          <button id="imageEditPaint" type="button" aria-pressed="false"><span aria-hidden="true">▰</span> Paint selection</button>
          <button id="imageEditSubtract" type="button" aria-pressed="false"><span aria-hidden="true">−</span> Subtract</button>
          <button id="imageEditAutoDetect" type="button"><span aria-hidden="true">◎</span> Auto detect</button>
          <button id="imageEditDetected" type="button" aria-pressed="false">Select objects</button>
        </div>
        <label class="image-edit-brush-label" for="imageEditBrushSize"><span>Brush size</span><output id="imageEditBrushValue">70 px</output></label>
        <input id="imageEditBrushSize" type="range" min="1" max="500" value="70" aria-describedby="imageEditBrushHelp">
        <p id="imageEditBrushHelp" class="image-edit-note">Paint over the object. Subtract removes parts of the selection.</p>
        <div class="image-edit-areas-heading"><h3>Selected areas <span id="imageEditAreaCount">0</span></h3><button id="imageEditClear" type="button" title="Keep your areas and start a new selection">New selection</button></div>
        <div id="imageEditAreas" role="group" aria-label="Editable selected areas"></div>
        <p id="imageEditAreaEmpty" class="image-edit-note">Paint an area, or run Auto detect and click an object.</p>
      </div>
    </section>
    <section class="image-edit-section">
      <h2><span class="image-edit-step">2</span> Choose what happens</h2>
      <button id="imageEditErase" class="image-edit-action" type="button"><span class="image-edit-action-symbol" aria-hidden="true">◇</span><span><strong>Erase selected</strong><small>Instant · leaves a transparent area</small></span></button>
      <button id="imageEditRemoveFill" class="image-edit-action primary" type="button"><span class="image-edit-action-symbol" aria-hidden="true">✦</span><span><strong>Remove &amp; fill</strong><small>AI · rebuilds the background</small></span></button>
      <p id="imageEditGenerationHelp" class="image-edit-note">Remove &amp; fill uses the model and quality below. API charges apply.</p>
      <button id="imageEditReferences" type="button">References / instructions</button>
      <p class="image-edit-note">For replacement or appearance edits, add references here and use Generate below.</p>
    </section>
    <section class="image-edit-section image-edit-review-note"><h2><span class="image-edit-step">3</span> Review your edit</h2><p class="image-edit-note">Use Before / after to check local edits. AI results open in a preview before you save or edit them.</p></section>
    <p id="imageEditStatus" role="status" aria-live="polite" hidden></p>`;
  document.querySelector('.panels').prepend(panel);
  const find=id=>panel.querySelector('#'+id);
  bar.querySelector('#imageEditBack').onclick=safe(onBack);
  find('imageEditImport').onclick=safe(onImport);
  find('imageEditAutoDetect').onclick=safe(onAutoDetect);
  find('imageEditErase').onclick=safe(onErase);
  find('imageEditRemoveFill').onclick=safe(onRemoveFill);
  find('imageEditReferences').onclick=safe(onReferences);
  find('imageEditClear').onclick=safe(onClear);
  for(const [id,tool] of [['imageEditPaint','select'],['imageEditSubtract','subtract'],['imageEditDetected','detect']])find(id).onclick=safe(()=>onTool?.(tool));
  find('imageEditBrushSize').oninput=event=>{
    const value=Math.max(1,Math.min(500,Number(event.target.value)||1));find('imageEditBrushValue').textContent=`${value} px`;safe(()=>onBrushSize?.(value))();
  };
  find('imageEditAreas').onclick=event=>{
    const button=event.target.closest('[data-image-edit-area]');if(button&&!button.disabled)safe(()=>onSelectArea?.(button.dataset.imageEditArea))();
  };
  const card=document.createElement('button');card.type='button';card.id='createImageEditPageCard';card.className='desktop-create-image-edit';
  card.innerHTML='<span class="desktop-create-canvas-icon" aria-hidden="true">◇</span><span><strong>Edit image</strong><small>Select objects, erase them, or use AI to fill the background. Keep your original and editable history.</small></span><span aria-hidden="true">→</span>';
  card.onclick=()=>{document.getElementById('desktopCreateDialog')?.close();safe(onOpen)();};
  document.querySelector('.desktop-create-options')?.append(card);
  function sync(state={}) {
    current={active:false,areas:[],...state};const {active,busy,hasImage,tool,areas,selectedId}=current,generation=current.generation||{};
    const working=Boolean(busy||generation.working||generation.pending),hasSelection=current.hasSelection??areas.some(area=>area.id===selectedId||area.selected);
    document.body.classList.toggle('image-edit-workspace',Boolean(active));bar.hidden=!active;panel.hidden=!active;entry.classList.toggle('active',Boolean(active));entry.setAttribute('aria-pressed',String(Boolean(active)));
    bar.querySelector('#imageEditBack').disabled=working;
    find('imageEditEmpty').hidden=Boolean(hasImage);find('imageEditSelectionTools').hidden=!hasImage;find('imageEditImport').disabled=working;
    for(const id of ['imageEditPaint','imageEditAutoDetect','imageEditDetected'])find(id).disabled=working||!hasImage;
    find('imageEditSubtract').disabled=working||!hasImage||!hasSelection;
    find('imageEditBrushSize').disabled=working||!hasImage;
    const size=Math.max(1,Math.min(500,Number(current.brushSize)||70));find('imageEditBrushSize').value=String(size);find('imageEditBrushValue').textContent=`${size} px`;
    for(const [id,value] of [['imageEditPaint','select'],['imageEditSubtract','subtract'],['imageEditDetected','detect']])find(id).setAttribute('aria-pressed',String(tool===value));
    find('imageEditClear').disabled=working||!hasSelection;
    find('imageEditErase').disabled=working||!hasImage||!hasSelection;
    find('imageEditRemoveFill').disabled=working||!hasImage||!hasSelection||!generation.canAttach||Boolean(generation.settingsError);
    find('imageEditReferences').disabled=working||!hasSelection;
    find('imageEditAreaCount').textContent=String(areas.length);find('imageEditAreaEmpty').hidden=areas.length>0;
    const signature=JSON.stringify([areas.map(area=>[area.id,area.label,area.name,area.selected]),selectedId,working]);
    if(signature!==areaSignature){
      areaSignature=signature;const fragment=document.createDocumentFragment();
      for(const area of areas){
        const button=document.createElement('button');button.type='button';button.dataset.imageEditArea=area.id;button.disabled=working;button.setAttribute('aria-pressed',String(area.id===selectedId||Boolean(area.selected)));
        const label=document.createElement('span');label.className='image-edit-area-number';label.textContent=String(area.label||'•');
        const name=document.createElement('span');name.textContent=area.name&&String(area.name)!==String(area.label)?area.name:`Area ${area.label||''}`;button.append(label,name);fragment.append(button);
      }
      find('imageEditAreas').replaceChildren(fragment);
    }
    const generationHelp=find('imageEditGenerationHelp');
    generationHelp.textContent=generation.settingsError||(!generation.canAttach?'Connect an available image model below to use Remove & fill. Erase selected works locally.':'Remove & fill uses the model and quality below. API charges apply.');generationHelp.classList.toggle('is-error',Boolean(generation.settingsError));
    const status=find('imageEditStatus');status.textContent=current.message||'';status.hidden=!current.message;
  }
  sync();return {sync};
}
