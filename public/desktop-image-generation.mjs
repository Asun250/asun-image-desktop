import {createDesktopGeneration} from './desktop-sheet-generation.mjs';
import {buildImageGenerationInput} from './image-generation-request.mjs';
import {originalBlob} from './image-source.mjs';
import {renderGenerationDetails,blockoutReviewDisplay,generationInputPackingDisplay} from './generation-details.mjs';
import {missingSourceMessage} from './generation-result-actions.mjs';
import {openGeneratedImageInspector} from './generated-image-inspector.mjs';
import {mountBlockoutReview} from './blockout-review-ui.mjs';
import {mountSceneConsistency} from './scene-consistency-ui.mjs';
import {mountImageOutputControls} from './image-output-controls.mjs';
import {withImageAspectPreference} from './image-output-preferences.mjs';
import {resolveImageOutput,imageAspectRatio} from './image-output-settings.mjs';
import {mountGenerationComplexity} from './generation-complexity-controls.mjs';

/** Main-page generation operates on a snapshot; results never replace the canvas automatically. */
export function mountDesktopImageGeneration({editor, download, onStatus = () => {}, onQueued = () => {}, beforeGenerate}) {
  const find = id => document.getElementById(id);
  const button = find('generate'), model = find('model'), quality = find('imageQuality'), prompt = find('prompt');
  const bridge = createDesktopGeneration({editor, endpoint:'/api/images', tokenHeader:'x-asun-image-token', storageKey:'asun.desktop.image.last-job.v1', kind:'image', prepareInput:async snapshot => {
    // Freeze the exact choice shown in the controls into this job's source.
    snapshot.imageOutput=withImageAspectPreference(snapshot).imageOutput;
    resolveImageOutput(snapshot,bridge.state().model);
    const input = await buildImageGenerationInput(snapshot), packing = generationInputPackingDisplay(input.inputPacking);
    if (packing) showStatus(packing.summary + ' Uploading this job…');
    return input;
  }});
  const dialog = document.createElement('dialog');dialog.id = 'desktopImageResultDialog';dialog.setAttribute('aria-labelledby','desktopImageResultTitle');
  dialog.innerHTML = `<header class="image-result-header"><div><h2 id="desktopImageResultTitle">Your image is ready</h2><p data-image-result-info></p></div><button type="button" data-image-result-close aria-label="Close generated image">×</button></header><div class="image-result-preview"><img data-image-result alt="Generated image" draggable="false"></div><p class="image-result-help">Review the result, then save it or add it to your project. Your original canvas stays intact.</p><p data-image-result-status role="status" aria-live="polite"></p><footer class="image-result-actions"><button type="button" data-image-result-download class="primary">Save image</button><button type="button" data-image-result-layer>Add as new layer</button><button type="button" data-image-result-reference>Add to references</button><button type="button" data-image-result-close>Back to editing</button></footer>`;
  document.body.append(dialog);
  dialog.querySelector('.image-result-actions').insertAdjacentHTML('afterbegin','<button type="button" data-image-result-edit class="primary">Edit output image</button><button type="button" data-image-result-redo>Redo with all references</button>');
  dialog.querySelector('.image-result-actions').insertAdjacentHTML('beforebegin','<p data-image-result-source-note class="image-result-help"></p>');
  dialog.querySelector('[data-image-result-download]').classList.remove('primary');
  dialog.querySelector('.image-result-help').textContent='Edit the finished image, or return to the original setup with its areas and references. Nothing generates until you press Generate.';
  dialog.querySelector('.image-result-help').insertAdjacentHTML('afterend','<section data-image-generation-details></section>');
  const preview=dialog.querySelector('.image-result-preview'),previewButton=document.createElement('button');
  previewButton.type='button';previewButton.className=preview.className;previewButton.setAttribute('data-image-result-inspect','');
  previewButton.setAttribute('aria-label','Enlarge and inspect generated image');
  previewButton.append(...preview.childNodes);previewButton.insertAdjacentHTML('beforeend','<span class="image-result-expand">⛶ Enlarge / inspect</span>');
  preview.replaceWith(previewButton);
  let resultDetails=null,restoreController=null,inspector=null,displayedKind='image',displayedBridge=bridge;
  let checking = false, message = '', error = false, importing = false, currentResult = null, displayedResult = null, loadingResult=false, preparingWorkflow=false;
  const showStatus = (text, failed = false) => {
    message = text;error = failed;find('imageGenerationStatus').textContent = text;find('imageGenerationStatus').title = text;
    find('imageGenerationStatus').classList.toggle('is-error',failed);
  };
  mountBlockoutReview({editor,host:find('imageGenerationHistory').parentElement,getModel:()=>bridge.state().model,onStatus:showStatus});
  mountSceneConsistency({editor,host:find('imageGenerationHistory').parentElement,onStatus:showStatus});
  const outputControls=mountImageOutputControls({editor,quality,getModel:()=>bridge.state().model,onStatus:showStatus});
  const complexityControls=mountGenerationComplexity({host:quality.closest('.model-section'),bridge,onStatus:showStatus});
  function sync() {
    const state = bridge.state(), app = editor.state();
    const available = state.models.filter(entry => entry.available), optionsKey = JSON.stringify([state.model,available.map(entry => [entry.id,entry.label])]);
    if (model.dataset.options !== optionsKey) {
      model.replaceChildren();model.dataset.options = optionsKey;
      for (const entry of available) {const option = document.createElement('option');option.value = entry.id;option.textContent = entry.label || entry.id;model.append(option);}
      if(state.model && !available.some(entry=>entry.id===state.model)){const option=document.createElement('option');option.value=state.model;option.textContent=state.model+' (unavailable)';option.disabled=true;model.append(option);}
      if (!available.length) {const option = document.createElement('option');option.value = '';option.textContent = checking ? 'Checking models…' : 'No model connected';model.append(option);}
    }
    model.value = state.model;model.title = available.find(entry => entry.id === state.model)?.label || 'Choose image model';
    model.disabled = checking || preparingWorkflow || state.working || !state.canAttach;
    if(available.length && !checking && !preparingWorkflow && !state.working)model.disabled=false;
    const qualityKey=JSON.stringify([state.quality,state.qualityOptions]);
    if(quality.dataset.options!==qualityKey){quality.dataset.options=qualityKey;quality.replaceChildren();for(const value of state.qualityOptions){const option=document.createElement('option');option.value=value;option.textContent=value==='high'?'high (default)':value;quality.append(option);}if(!state.qualityOptions.includes(state.quality)){const option=document.createElement('option');option.value=state.quality;option.textContent=state.quality+' (unsupported)';option.disabled=true;quality.append(option);}}
    quality.value=state.quality;quality.disabled=checking||preparingWorkflow||state.working||!state.model;
    complexityControls.sync(state,{disabled:checking||preparingWorkflow||!state.model});
    const outputState=outputControls.sync({disabled:checking||preparingWorkflow||state.working});
    const settingsError=state.settingsError||outputState.error;
    find('imageQualityMessage').textContent=settingsError||'';
    find('imageQualityMessage').hidden=!settingsError;find('imageGenerationStatus').hidden=Boolean(settingsError);
    button.disabled = checking || preparingWorkflow || state.working || app.busy || (!state.uncertainRequestId && (!state.canAttach || settingsError || !(prompt.value.trim() || app.hasAreaGenerationInstructions)));
    button.setAttribute('aria-busy',String(state.working));
    button.innerHTML = state.working ? '<span class="image-generation-spinner" aria-hidden="true"></span><span>Adding job…</span>' : `<span aria-hidden="true">✦</span><span>${state.uncertainRequestId ? 'Check submission' : 'Generate'}</span>`;
    button.title = state.uncertainRequestId ? 'Check the existing submission without creating another paid request' : 'Add this image to the job queue, then continue editing or start another project. Larger reference sets use labeled boards; individual photos may appear smaller to the model. OpenAI API charges apply.';
    find('imageConnectionState').textContent = checking ? 'Checking…' : state.connected ? 'Connected' : 'Offline';
    find('imageConnectionState').title = state.message;
    find('imageConnectionState').dataset.connected = String(state.canAttach);
    find('imageGenerationRefresh').disabled = checking || preparingWorkflow || state.working;
    find('imageGenerationResult').hidden = !state.resultReady;
    find('imageGenerationResult').disabled = loadingResult;
    currentResult = state.result;
    if (!message && !checking) showStatus(state.uncertainRequestId ? 'The submission could not be confirmed. Choose Check submission to recover the same job.' : state.canAttach ? 'Choose a model, describe your image or edits, then Generate. You can keep working while jobs run.' : 'Image generation is not connected. Check connection to try again.');
    find('imageGenerationStatus').classList.toggle('is-error',error);
  }
  async function check() {
    if (checking || preparingWorkflow || bridge.state().working) return;
    const version=bridge.state().workflowVersion;checking = true;sync();
    try {
      await bridge.prepare();const state = bridge.state();if(state.workflowVersion!==version)return;
      showStatus(state.uncertainRequestId ? 'The submission could not be confirmed. Choose Check submission to recover it.' : state.contextActiveCount ? 'Jobs are processing in the background. Open Job queue to see their progress.' : state.resultReady ? 'Your last generated image is available. Choose View result.' : state.canAttach ? 'Choose a model, describe your image or edits, then Generate.' : state.message, !state.canAttach && !state.uncertainRequestId);
    } catch (cause) {if(bridge.state().workflowVersion===version)showStatus(cause.message,true);} finally {checking = false;sync();}
  }
  function showResult(record=currentResult,{kind='image',generationBridge=bridge}={}) {
    if (!record?.image) return;
    if (document.querySelector('dialog[open]') || document.querySelector('#asunSheetCreator:not([hidden])')) {showStatus('Your image is ready. Finish the open panel, then choose View result.');return;}
    displayedResult = record;displayedKind=kind;displayedBridge=generationBridge;
    const outputMismatch=record.outputCheck?.matches===false;
    dialog.querySelector('#desktopImageResultTitle').textContent=outputMismatch?'Check this output’s dimensions':blockoutReviewDisplay(record)?.label || (kind==='sheet'?'Your sheet is ready':'Your image is ready');
    const image = dialog.querySelector('[data-image-result]');image.src = displayedResult.image.source;
    dialog.querySelector('[data-image-result-info]').textContent = `${displayedResult.sourceName || displayedResult.image.name || 'Generated image'} · ${displayedResult.model || bridge.state().model} · ${displayedResult.image.width} × ${displayedResult.image.height} px · ${imageAspectRatio(displayedResult.image.width,displayedResult.image.height)}`;
    dialog.querySelector('[data-image-result-status]').textContent = outputMismatch?record.outputCheck.message:'';
    const canRestore=displayedResult.sourceProjectAvailable===true;
    dialog.querySelector('[data-image-result-redo]').disabled=!canRestore;
    dialog.querySelector('[data-image-result-source-note]').textContent=canRestore?'Redo restores the original image, editable selections, references and instructions. You can add more edits before generating again.':displayedResult.sourceProjectMessage||missingSourceMessage;
    resultDetails?.dispose();resultDetails=renderGenerationDetails(dialog.querySelector('[data-image-generation-details]'),displayedResult,{kind:displayedKind});
    dialog.showModal();dialog.querySelector('[data-image-result-edit]').focus();
  }
  async function viewWorkflowResult() {
    const state=bridge.state(),id=state.resultId,version=state.workflowVersion;
    if(!id||loadingResult)return;
    if(state.result?.id===id){showResult(state.result);return;}
    loadingResult=true;sync();
    try{const record=await bridge.fetchResult(id);const current=bridge.state();if(current.workflowVersion===version&&current.resultId===id)showResult(record);}
    catch(cause){if(bridge.state().workflowVersion===version)showStatus(cause.message,true);}
    finally{if(bridge.state().workflowVersion===version){loadingResult=false;sync();}}
  }
  function resetWorkflowView() {
    message='';error=false;loadingResult=false;currentResult=null;displayedResult=null;
    inspector?.close();inspector=null;if(dialog.open)dialog.close();resultDetails?.dispose();resultDetails=null;
    dialog.querySelector('[data-image-result]').removeAttribute('src');dialog.querySelector('[data-image-generation-details]').replaceChildren();sync();
  }
  async function switchWorkflow(context) {
    const version=bridge.setWorkflowContext(context);resetWorkflowView();
    try{await bridge.refreshJobs({notify:false});}catch(cause){if(bridge.state().workflowVersion===version)showStatus(cause.message,true);}
    if(bridge.state().workflowVersion===version)sync();
  }
  async function generate(options={}) {
    if(options.prepareProject){
      const state=bridge.state();
      if(checking||preparingWorkflow||state.working||editor.state().busy)throw new Error('Wait for the current upload to finish before removing an object.');
      if(!state.canAttach||state.settingsError)throw new Error(state.settingsError||state.message||'Connect an image model to remove and fill this area.');
      const outputError=outputControls.sync().error;if(outputError)throw new Error(outputError);
    }else if (button.disabled) return;
    preparingWorkflow=true;showStatus(bridge.state().uncertainRequestId ? 'Checking the existing submission…' : 'Saving this job and its original edit setup…');sync();
    try {
      if(!bridge.state().uncertainRequestId)await beforeGenerate?.();
      const result = await bridge.generate(options);
      if(!['queued','running','completed'].includes(result?.status))throw new Error(result?.message||'This job could not be queued. Open Job queue for its details.');
      const packing = generationInputPackingDisplay(result?.settings?.inputPacking);
      const outputMismatch=result?.outputCheck?.matches===false;
      const queuedMessage = outputMismatch?result.outputCheck.message:result?.image?'Your image is ready in Job queue. Choose View result to inspect it.':'Added to Job queue. You can keep editing or start a new project; this job keeps its original setup.';
      showStatus(packing ? packing.summary + ' ' + queuedMessage : queuedMessage,outputMismatch);
      onQueued(result);return result;
    } catch (cause) {showStatus(cause.message,true);onStatus(cause.message,true);} finally {preparingWorkflow=false;sync();}
  }
  dialog.addEventListener('click', async event => {
    const target = event.target.closest('button');if (!target) return;
    if (target.hasAttribute('data-image-result-close')) {if(!importing||restoreController)dialog.close();return;}
    if(importing)return;
    const image = displayedResult?.image;if (!image) return;
    try {
      if(target.hasAttribute('data-image-result-inspect')){
        const record=displayedResult;
        inspector=openGeneratedImageInspector(record.image,{returnFocus:target,onSave:()=>download(originalBlob(record.image),record.image.name||'Generated image.png')});
        return;
      }
      if(target.hasAttribute('data-image-result-edit')){
        importing=true;const record=displayedResult,wasSketch=Boolean(editor.peek().sketch);dialog.close();await displayedBridge.editOutput(record);
        showStatus(bridge.state().workflowScoped?'Generated output opened in a new edit tab. Your original workflow remains in its tab. Select new areas and add references.':wasSketch?'Output opened in the main editor. Your drawing remains in Draw / sketch reference; Undo restores the previous main canvas.':'Generated output opened for editing. Select new areas and add references. Undo restores your previous canvas.');return;
      }
      if(target.hasAttribute('data-image-result-redo')){
        importing=true;const record=displayedResult;restoreController=new AbortController();
        for(const action of dialog.querySelectorAll('.image-result-actions button'))action.disabled=true;
        dialog.querySelector('[data-image-result-status]').textContent='Restoring original image, areas and references…';
        await displayedBridge.restoreSource(record,{signal:restoreController.signal,beforeApply:()=>dialog.close()});
        showStatus('Original setup restored. Add more edits, then press Generate when you are ready.');return;
      }
      const blob = originalBlob(image), name = image.name || 'Generated image.png';
      if (target.hasAttribute('data-image-result-download')) {
        await download(blob,name);dialog.querySelector('[data-image-result-status]').textContent = 'Image download requested.';return;
      }
      const references = target.hasAttribute('data-image-result-reference');
      if (!references && !target.hasAttribute('data-image-result-layer')) return;
      importing = true;dialog.close();
      await editor.importImages([new File([blob],name,{type:blob.type})],{references});
      showStatus(references ? 'Generated image added to references. Save your project to keep it.' : 'Generated image added as a new layer. Your original layers are still editable; Undo removes the new layer.');
    } catch (cause) {if(cause.name!=='AbortError'){showStatus(cause.message,true);onStatus(cause.message,true);if(dialog.open)dialog.querySelector('[data-image-result-status]').textContent=cause.message;}}
    finally {importing = false;restoreController=null;for(const action of dialog.querySelectorAll('.image-result-actions button'))action.disabled=false;dialog.querySelector('[data-image-result-redo]').disabled=displayedResult?.sourceProjectAvailable!==true;sync();}
  });
  dialog.addEventListener('close',()=>{inspector?.close();inspector=null;restoreController?.abort();resultDetails?.dispose();resultDetails=null;if(!importing)find('imageGenerationResult').focus();});
  button.addEventListener('click',()=>generate());
  model.addEventListener('change',()=>bridge.selectModel(model.value));
  quality.addEventListener('change',()=>{try{bridge.selectQuality(quality.value);showStatus('Quality set to '+quality.value+'. This setting will be sent unchanged.');}catch(error){showStatus(error.message,true);}sync();});
  prompt.addEventListener('input',sync);
  find('imageGenerationResult').addEventListener('click',()=>void viewWorkflowResult());
  find('imageGenerationRefresh').addEventListener('click',check);
  bridge.subscribe(event=>{if(event?.type==='workflow')resetWorkflowView();else sync();const state=bridge.state(),belongs=!state.workflowScoped||state.workflowJobIds.includes(event?.record?.id);if(belongs&&event?.type==='completed'){const record=state.result?.id===event.record?.id?state.result:event.record;showStatus(record?.outputCheck?.matches===false?record.outputCheck.message:'An image is ready in Job queue. Your current project has not changed.',record?.outputCheck?.matches===false);}else if(belongs&&event?.type==='failed')showStatus(event.record?.message||'A job failed. Open Job queue for its details.',true);});editor.subscribe(sync);
  void check();
  return {refresh:sync,check,bridge,generate,showResult,switchWorkflow};
}
