import {getBlockoutReview,BLOCKOUT_REVIEW_MODEL,BLOCKOUT_REVIEW_EFFORT,blockoutOutputSize} from './blockout-review-settings.mjs';

export function mountBlockoutReview({editor,host,getModel=()=>'',onStatus=()=>{}}) {
  const button=document.createElement('button');button.id='blockoutReview';button.type='button';button.textContent='Blockout review · Off';
  button.title='Have Astra review the generated scene against your original Blender blockout';host.append(button);
  const dialog=document.createElement('dialog');dialog.id='blockoutReviewDialog';dialog.setAttribute('aria-labelledby','blockoutReviewTitle');
  dialog.innerHTML=`<form><header><h2 id="blockoutReviewTitle">Review against your blockout</h2><button type="button" data-close aria-label="Close blockout review">×</button></header>
    <label class="blockout-review-enable"><input type="checkbox" name="enabled"> Use a second agent to check this project</label>
    <p>GPT-6 Astra · Max reasoning. The desktop API supports Max; Ultra is a separate Codex host setting.</p>
    <label>Original Blender blockout<select name="source" required aria-label="Original Blender blockout"></select></label>
    <img class="blockout-review-preview" alt="Selected original blockout" hidden>
    <p class="blockout-review-source-info"></p>
    <p>This saved original controls camera view, framing, placement and relative size. It stays the same across retries, even when you edit the canvas.</p>
    <label>Allowed changes to the blockout <span>(optional)</span><textarea name="exceptions" maxlength="2000" rows="3" placeholder="For example: remove the left chair. Leave blank to keep the original structure."></textarea></label>
    <label>Total generation attempts<select name="attempts" aria-label="Total generation attempts"><option value="1">1 · Review only</option><option value="2">2 · Up to one corrected generation</option><option value="3">3 · Up to two corrected generations</option></select></label>
    <p>Rejected images are regenerated with corrections and the same source and references. Uncertain or failed reviews stop for inspection. Each generation and review uses paid API billing.</p>
    <p class="blockout-review-limit">Checks visible image geometry. Exact 3D measurements and camera parameters cannot be certified from a blockout image.</p>
    <p class="blockout-review-error" role="alert"></p><footer><button type="button" data-close>Cancel</button><button type="submit" class="primary">Save review settings</button></footer></form>`;
  document.body.append(dialog);
  const form=dialog.querySelector('form'),enabled=form.elements.enabled,source=form.elements.source,attempts=form.elements.attempts,exceptions=form.elements.exceptions;
  const preview=dialog.querySelector('img'),error=dialog.querySelector('[role=alert]');
  let snapshot=null,lastRevision=-1,lastEnabled=false;
  function sync() {
    const state=editor.state();button.disabled=state.busy;
    if(state.projectRevision===lastRevision)return;lastRevision=state.projectRevision;
    const review=getBlockoutReview(editor.peek());lastEnabled=review.enabled;
    button.textContent=review.enabled?'Blockout review · Astra Max':'Blockout review · Off';
    button.classList.toggle('is-enabled',review.enabled);
  }
  function previewSource() {
    const asset=snapshot?.assets[source.value];preview.hidden=!asset;
    if(asset)preview.src=asset.source;else preview.removeAttribute('src');
    let sizeInfo='Choose an image model to see its output dimensions.';
    if(asset&&getModel())try{sizeInfo='Output requested: '+blockoutOutputSize(getModel(),asset.width,asset.height).replace('x',' × ')+' px · same aspect ratio, no crop or stretch.';}catch(cause){sizeInfo=cause.message;}
    dialog.querySelector('.blockout-review-source-info').textContent=asset?`${asset.name} · ${asset.width} × ${asset.height} px · original bytes preserved. ${sizeInfo}`:'Import the Blender blockout into this project first, then choose it here.';
    source.required=enabled.checked;source.disabled=!enabled.checked;attempts.disabled=!enabled.checked;exceptions.disabled=!enabled.checked;
  }
  button.addEventListener('click',()=>{
    try {
      snapshot=editor.snapshot();const review=getBlockoutReview(snapshot);
      source.replaceChildren(new Option('Choose the original blockout…',''));
      for(const asset of Object.values(snapshot.assets))source.add(new Option(asset.name+(asset.id===snapshot.original?.assetId?' (original import)':''),asset.id));
      source.value=review.assetId;enabled.checked=Object.hasOwn(snapshot,'blockoutReview')?review.enabled:true;
      attempts.value=String(review.maxAttempts);exceptions.value=review.authorizedChanges;error.textContent='';previewSource();dialog.showModal();source.focus();
    } catch(cause){onStatus(cause.message,true);}
  });
  enabled.addEventListener('change',previewSource);source.addEventListener('change',previewSource);
  dialog.querySelectorAll('[data-close]').forEach(close=>close.addEventListener('click',()=>dialog.close()));
  dialog.addEventListener('close',()=>{snapshot=null;preview.removeAttribute('src');button.focus();});
  form.addEventListener('submit',event=>{
    event.preventDefault();error.textContent='';
    try {
      const current=editor.peek();
      if(enabled.checked&&(!source.value||current.assets[source.value]?.source!==snapshot.assets[source.value]?.source))throw new Error('Choose the original Blender blockout to review against.');
      current.blockoutReview={version:1,enabled:enabled.checked,assetId:source.value,model:BLOCKOUT_REVIEW_MODEL,effort:BLOCKOUT_REVIEW_EFFORT,maxAttempts:Number(attempts.value),authorizedChanges:exceptions.value};
      // One explicit MAIN choice governs both scene rules and independent review.
      if(enabled.checked&&current.sceneConsistency?.enabled){
        if(current.sceneConsistency.mainAssetId!==source.value)for(const object of current.sceneConsistency.objects)delete object.anchor;
        current.sceneConsistency.mainAssetId=source.value;
      }
      dialog.close();editor.apply(current,'Update blockout review');onStatus(enabled.checked?'Blockout review enabled. Generate will run Astra Max after each image, with up to '+attempts.value+' total attempts.':'Blockout review is off for this project.');
    }catch(cause){if(dialog.open)error.textContent=cause.message;else onStatus(cause.message,true);}
  });
  editor.subscribe(sync);sync();
  return {enabled:()=>lastEnabled};
}
