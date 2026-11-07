import {getSheetPreset, getSheetSource, getSheetSources, getSheetSubjectSources, getSheetPhoto, withSheetPhotoEdits, withSheetPreset, buildSheetPrompt, sheetAngles} from './sheet-preset.mjs';
import {exportSheetPack} from './sheet-pack.mjs';
import {originalBlob,readOriginalImage} from './image-source.mjs';
import {createSheetPhotoEditor} from './sheet-photo-editor.mjs';
import {clipboardImageFiles,readClipboardImages} from './clipboard.mjs';
import {referenceSearchUrl} from './reference-search.mjs';
import {sheetDropInput,sheetWebPhotoFile} from './sheet-photo-drop.mjs';
import {referenceProject} from './core.mjs';
import {renderProjectPreview} from './render.mjs';
import {renderGenerationDetails} from './generation-details.mjs';
import {DEFAULT_GENERATION_QUALITY,generationQualityOptions} from './generation-settings.mjs';
import {missingSourceMessage} from './generation-result-actions.mjs';
import {openGeneratedImageInspector} from './generated-image-inspector.mjs';
import {mountGenerationComplexity} from './generation-complexity-controls.mjs';

const escape = value => String(value ?? '').replace(/[&<>"']/g, character => ({'&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;'}[character]));
const glyph = () => `<span class="sheet-creation-glyph" aria-hidden="true">${Array.from({length:9}, () => '<i></i>').join('')}</span>`;
const imageSource = asset => asset?.preview?.source || asset?.source || '';
const nextPaint = () => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
const webSearch = section => `<div class="sheet-web-search"><label for="sheetSearch-${section}">Search the web</label><div><input id="sheetSearch-${section}" data-sheet-search="${section}" type="search" maxlength="200" placeholder="Find photos of your subject"><button type="button" class="sheet-button sheet-secondary" data-sheet-web="${section}">Search images ↗</button></div><p class="sheet-help">Search opens in a new tab. Drag an image here, or copy the image and choose Paste photos.</p></div>`;

/** Shared by the phone, desktop and ChatGPT surfaces; the project remains native. */
export function mountSheetCreator({editor, bridge = {}, download, pickPhoto, onStatus = () => {}, onQueued = () => {}, onOpenQueue, beforeGenerate}) {
  const panel = document.createElement('section');
  panel.id = 'asunSheetCreator';
  panel.className = 'sheet-creator';
  panel.hidden = true;
  panel.setAttribute('role', 'region');
  panel.setAttribute('aria-label', 'Character / item sheet');
  panel.innerHTML = `<div class="sheet-creator-shell">
    <header class="sheet-creator-header"><div class="sheet-creator-heading"><span class="sheet-eyebrow">ASUN IMG · CREATE</span><h1>Character / item sheet</h1><p>One subject. Every angle. All together.</p></div><button type="button" class="sheet-close sheet-button" data-sheet-action="close" aria-label="Close sheet creator">×</button></header>
    <nav class="sheet-creation-choices" aria-label="Creation type"><button type="button" class="sheet-mode-card" data-sheet-action="image-edit"><span class="sheet-edit-glyph" aria-hidden="true">✎</span><span><strong>Image edit</strong><small>Make a change to your photo</small></span><span aria-hidden="true">→</span></button><div class="sheet-mode-card is-selected"><span class="sheet-mini-glyph" aria-hidden="true">▦</span><span><strong>Character / item sheet</strong><small>7 or 9 views · white background</small></span><span class="sheet-mode-check" aria-hidden="true">✓</span></div></nav>
    <div class="sheet-creator-layout"><div class="sheet-creator-settings">
      <section class="sheet-section"><div class="sheet-section-title"><span class="sheet-step">1</span><h2>Choose your subject</h2></div><p class="sheet-help">Add one or more photos of the same character, item or building. Click a photo to enlarge, mark it and add instructions.</p><div class="sheet-photo-zone" data-sheet-drop="subjects" tabindex="0" aria-label="Subject photos: drop or paste images here"><div data-sheet-source></div><div class="sheet-photo-actions"><button type="button" class="sheet-button sheet-secondary" data-sheet-action="upload">＋ Add subject photos</button><button type="button" class="sheet-button sheet-secondary" data-sheet-paste="subjects">Paste photos</button></div><p class="sheet-drop-hint">↓ Drop photos here · PNG, JPEG or WebP · multiple photos welcome</p><label class="sheet-select-label">Add an existing project photo<select data-sheet-add-existing="subjects" aria-label="Add an existing subject photo"></select></label>${webSearch('subjects')}</div><fieldset class="sheet-fieldset"><legend>What are we showing?</legend><div class="sheet-segments" data-sheet-subjects>${[['character','Character'],['item','Item / object'],['building','Building']].map(([value,label]) => `<button type="button" data-sheet-subject="${value}" aria-pressed="false">${label}</button>`).join('')}</div></fieldset></section>
      <section class="sheet-section"><div class="sheet-section-title"><span class="sheet-step">2</span><h2>Pick your views</h2></div><div class="sheet-view-options" aria-label="Number of views"><button type="button" data-sheet-views="9" aria-pressed="true"><strong>9 views</strong><small>The complete set</small><span class="sheet-recommended">Recommended</span></button><button type="button" data-sheet-views="7" aria-pressed="false"><strong>7 views</strong><small>A simpler sheet</small></button></div><div class="sheet-fixed-settings"><span>✓ White background</span><span>✓ One finished image</span></div></section>
      <section class="sheet-section"><div class="sheet-section-title"><span class="sheet-step">3</span><h2>Add the details</h2><span class="sheet-optional">Optional</span></div><p class="sheet-help">Add detail references, then click any photo to mark the part to use. Select only the references you want included.</p><div class="sheet-photo-zone" data-sheet-drop="details" tabindex="0" aria-label="Detail reference photos: drop or paste images here"><div class="sheet-reference-list" data-sheet-references></div><div class="sheet-photo-actions"><button type="button" class="sheet-button sheet-secondary" data-sheet-action="add-references">＋ Add reference photos</button><button type="button" class="sheet-button sheet-secondary" data-sheet-paste="details">Paste photos</button></div><p class="sheet-drop-hint">↓ Drop detail photos here · or paste copied images</p>${webSearch('details')}</div><label class="sheet-notes-label">Anything to keep in mind?<textarea data-sheet-notes maxlength="2000" rows="3" placeholder="For example: Only use the circled building. Exclude the surrounding buildings."></textarea></label><p class="sheet-help">Your photo markings, photo instructions and these notes are included in the sheet request.</p></section>
    </div><aside class="sheet-creator-preview" aria-label="Sheet layout preview"><div class="sheet-preview-heading"><div><span class="sheet-eyebrow">YOUR SHEET LAYOUT</span><h2 data-sheet-preview-title>9 views, one image</h2></div>${glyph()}</div><div class="sheet-layout-grid" data-sheet-layout></div><p class="sheet-help sheet-layout-caption">Layout guide · your AI app creates the finished views.</p><div class="sheet-summary"><span aria-hidden="true">✦</span><p>Matching appearance, clear view labels, and a clean white background.</p></div><details class="sheet-prompt-details"><summary>View automatic instructions</summary><pre data-sheet-prompt></pre></details></aside></div>
    <footer class="sheet-creator-footer"><div class="sheet-status" data-sheet-status role="status" aria-live="polite"></div><div class="sheet-delivery-actions"><button type="button" class="sheet-button sheet-secondary" data-sheet-action="save" hidden>Save project</button><button type="button" class="sheet-button sheet-secondary" data-sheet-action="download">Download sheet pack</button><button type="button" class="sheet-button sheet-primary" data-sheet-action="generate" hidden><span aria-hidden="true">✦</span> Generate sheet</button></div><p class="sheet-help" data-sheet-delivery-help></p><button type="button" class="sheet-button sheet-secondary" data-sheet-action="reveal" hidden>Show in folder</button></footer>
    <input type="file" accept="image/png,image/jpeg,image/webp" multiple data-sheet-source-input hidden><input type="file" accept="image/png,image/jpeg,image/webp" multiple data-sheet-reference-input hidden>
  </div>`;
  panel.querySelector('[data-sheet-views="9"] .sheet-recommended')?.remove();
  panel.querySelector('[data-sheet-views="7"] small').textContent = 'Seven distinct angles';
  panel.querySelector('[data-sheet-views="7"]').insertAdjacentHTML('beforeend','<span class="sheet-recommended">Default</span>');
  panel.querySelector('.sheet-creator-footer').insertAdjacentHTML('afterbegin',`<section data-sheet-connection hidden><label class="sheet-select-label">Image model<select data-sheet-model aria-label="Image model"></select></label><div class="sheet-connection-row"><p class="sheet-help" data-sheet-connection-message></p><button type="button" class="sheet-button sheet-secondary" data-sheet-action="connection">Check connection</button></div></section>`);
  panel.querySelector('.sheet-creator-preview').insertAdjacentHTML('afterbegin',`<section class="sheet-result" data-sheet-result hidden><span class="sheet-eyebrow">GENERATED SHEET</span><h2>Your sheet is ready</h2><img data-sheet-result-image alt="Generated character or item sheet"><p data-sheet-result-caption></p><p class="sheet-help">Check the identity and angles before using your sheet. Unseen sides are inferred from your references.</p><div class="sheet-result-actions"><button type="button" class="sheet-button sheet-primary" data-sheet-action="result-download">Save sheet image</button><button type="button" class="sheet-button sheet-secondary" data-sheet-action="result-reference">Add to references</button></div></section>`);
  panel.querySelector('[data-sheet-connection]>.sheet-select-label').insertAdjacentHTML('afterend','<label class="sheet-select-label">Quality<select data-sheet-quality aria-label="Sheet image quality" aria-describedby="sheetQualityMessage"></select></label><p id="sheetQualityMessage" class="sheet-quality-error" data-sheet-quality-message role="alert" hidden></p>');
  const complexityControls=mountGenerationComplexity({host:panel.querySelector('[data-sheet-connection]'),before:panel.querySelector('.sheet-connection-row'),bridge,id:'sheetComplexity',onStatus:(message,error)=>status(message,error)});
  panel.querySelector('[data-sheet-connection] .sheet-connection-row').insertAdjacentHTML('beforeend','<a class="sheet-button sheet-secondary sheet-history-link" href="./generation-history.html" target="_blank" rel="noopener">Generation history ↗</a>');
  if(onOpenQueue)panel.querySelector('.sheet-delivery-actions').insertAdjacentHTML('afterbegin','<button type="button" class="sheet-button sheet-secondary" data-sheet-action="queue">Job queue</button>');
  panel.querySelector('[data-sheet-result]').insertAdjacentHTML('beforeend','<section data-sheet-generation-details></section>');
  panel.querySelector('[data-sheet-result] .sheet-result-actions').insertAdjacentHTML('afterend','<div class="sheet-result-edit-actions" data-sheet-result-edit-actions hidden><button type="button" class="sheet-button sheet-primary" data-sheet-action="result-edit">Edit output image</button><button type="button" class="sheet-button sheet-secondary" data-sheet-action="result-redo" aria-describedby="sheetResultRestoreHelp">Redo with all references</button><p class="sheet-help">Edit the finished image, or return to the original setup to add more changes. Neither button starts a generation.</p><p id="sheetResultRestoreHelp" class="sheet-help" data-sheet-result-restore-help></p></div>');
  document.body.append(panel);
  const find = selector => panel.querySelector(selector);
  const resultPreview = panel.querySelector('[data-sheet-result-image]');
  const inspectButton = document.createElement('button');
  inspectButton.type = 'button';inspectButton.className = 'sheet-result-inspect';inspectButton.dataset.sheetAction = 'result-inspect';
  inspectButton.setAttribute('aria-label', 'Enlarge and inspect generated sheet');
  resultPreview.replaceWith(inspectButton);inspectButton.append(resultPreview);
  inspectButton.insertAdjacentHTML('beforeend', '<span>⛶ Enlarge / inspect</span>');
  let opened = false, busy = false, disposed = false, notesTimer = null, notesDraft = null, returnFocus = null, inertElements = [], renderKey = '', savedReceipt = null, busyButtonMarkup = null, pasteSection = 'subjects', resultDetails=null, displayedResult=null, resultInspector=null, resultLoadKey='', workflowStripPosition=null, previewProject=null, previewRevision=null;
  const status = (message, error = false) => {
    const target = find('[data-sheet-status]');
    target.textContent = message;
    target.classList.toggle('is-error', error);
    try { onStatus(message, error); } catch { /* The sheet status remains visible. */ }
  };
  const project = () => editor.peek();
  const source = getSheetSource;
  const photoEditor = createSheetPhotoEditor({
    onSave(id, patch) {editor.apply(withSheetPhotoEdits(project(),id,patch),'Annotate sheet photo');savedReceipt=null;refresh();status('Photo markings and instructions saved for your sheet.');},
    onError:error=>status(error.message,true),
  });
  const isTextInput = target => target?.matches?.('input,textarea,select,[contenteditable="true"]');
  function commit(patch, label = 'Update character / item sheet') {
    const next = withSheetPreset(project(), patch);
    editor.apply(next, label);
    savedReceipt = null;
    find('[data-sheet-action="reveal"]').hidden = true;
  }
  function flushNotes() {
    if (notesTimer) clearTimeout(notesTimer);
    notesTimer = null;
    if (notesDraft === null) return;
    const value = notesDraft;
    notesDraft = null;
    if (getSheetPreset(project()).notes !== value) commit({notes:value});
  }
  function resetWorkflowView() {
    previewProject=null;previewRevision=null;
    if(notesTimer)clearTimeout(notesTimer);notesTimer=null;notesDraft=null;renderKey='';savedReceipt=null;resultLoadKey='';displayedResult=null;
    resultInspector?.close();resultInspector=null;resultDetails?.dispose();resultDetails=null;
    find('[data-sheet-result]').hidden=true;resultPreview.removeAttribute('src');delete resultPreview.dataset.job;
    find('[data-sheet-generation-details]').replaceChildren();find('[data-sheet-status]').textContent='';find('[data-sheet-status]').classList.remove('is-error');
  }
  function loadWorkflowResult() {
    const state=bridge.state?.();if(!opened||!state?.workflowScoped||!state.resultReady||state.result?.image||typeof bridge.fetchResult!=='function')return;
    const key=state.workflowVersion+':'+state.resultId;if(key===resultLoadKey)return;resultLoadKey=key;
    void bridge.fetchResult(state.resultId).then(()=>{if(bridge.state().workflowVersion===state.workflowVersion)refresh({projectChanged:false});}).catch(error=>{if(opened&&bridge.state().workflowVersion===state.workflowVersion)status(error.message,true);});
  }
  async function switchWorkflow(context) {
    if(typeof bridge.setWorkflowContext!=='function')return;
    const version=bridge.setWorkflowContext(context);resetWorkflowView();refresh();
    try{await bridge.refreshJobs?.({notify:false});}catch(error){if(opened&&bridge.state().workflowVersion===version)status(error.message,true);}
    if(bridge.state().workflowVersion===version){refresh({projectChanged:false});loadWorkflowResult();}
  }
  function setBusy(value, action = '') {
    busy = value;
    panel.setAttribute('aria-busy', String(value));
    for (const control of panel.querySelectorAll('button,input,textarea,select')) control.disabled = value;
    const target = find(`[data-sheet-action="${action || 'download'}"]`);
    if (target && value) {
      busyButtonMarkup = [target, target.innerHTML];
      target.innerHTML = `<span class="sheet-spinner" aria-hidden="true"></span> ${action === 'generate' ? (bridge.state?.().direct ? 'Adding job…' : 'Sending…') : action === 'save' ? 'Saving…' : action === 'upload' ? 'Adding photo…' : 'Preparing…'}`;
    }
    if (!value) {
      if (busyButtonMarkup?.[0].isConnected) busyButtonMarkup[0].innerHTML = busyButtonMarkup[1];
      busyButtonMarkup = null;
      find('[data-sheet-action="download"]').textContent = 'Download sheet pack';
      find('[data-sheet-action="generate"]').innerHTML = '<span aria-hidden="true">✦</span> Generate sheet';
      find('[data-sheet-action="save"]').textContent = 'Save project';
    }
    refresh();
  }
  async function run(action, work) {
    if (busy || disposed) return;
    try {
      flushNotes();
      setBusy(true, action);
      await nextPaint();
      await work();
    } catch (error) {
      status(error?.message || String(error), true);
    } finally {
      setBusy(false);
    }
  }
  function photoCard(current, photo, role, mainId) {
    const info=getSheetPhoto(current,photo.id), selected=role==='subject'||getSheetPreset(current).referenceIds.includes(photo.id);
    const marks=info.annotations.length, badge=[marks?`${marks} mark${marks===1?'':'s'}`:'',info.notes.trim()?'Photo instructions':''].filter(Boolean).join(' · ');
    return `<div class="sheet-photo-card ${role==='subject'?'sheet-source-card':'sheet-reference-card'} ${selected?'is-selected':''}" data-sheet-role="${role}">${role==='detail'?`<input type="checkbox" data-sheet-reference="${escape(photo.id)}" aria-label="Include ${escape(photo.name)} in sheet" ${selected?'checked':''}>`:''}<button type="button" class="sheet-photo-open" data-sheet-photo="${escape(photo.id)}" aria-label="Enlarge and annotate ${escape(photo.name)}"><img src="${escape(imageSource(photo))}" alt="${role==='subject'?'Subject photo':'Detail reference'}"><span><span class="sheet-eyebrow">${role==='subject'?(photo.id===mainId?'MAIN REFERENCE':'SUBJECT PHOTO'):(selected?'INCLUDED DETAIL':'OPTIONAL DETAIL')}</span><strong>${escape(photo.name || 'Photo')}</strong><small>${badge?escape(badge):`${photo.width} × ${photo.height} · Original kept intact`}</small><b>⛶ Enlarge & annotate</b></span></button>${role==='subject'&&photo.id!==mainId?`<div class="sheet-photo-card-actions"><button type="button" data-sheet-main="${escape(photo.id)}" title="Use this photo as the main subject reference">Make main</button><button type="button" data-sheet-remove-subject="${escape(photo.id)}" aria-label="Remove ${escape(photo.name)} from subject photos">×</button></div>`:''}</div>`;
  }
  async function thumbnailPreviews(current) {
    for(const button of panel.querySelectorAll('[data-sheet-photo]')) {
      const photo=getSheetPhoto(current,button.dataset.sheetPhoto),image=button.querySelector('img');
      if(!photo?.annotations.length)continue;
      try {const canvas=await renderProjectPreview(referenceProject(photo),document.createElement('canvas'),{maxSide:360});if(image.isConnected)image.src=canvas.toDataURL('image/png');}
      catch { /* The full editor reports errors; originals remain available. */ }
    }
  }
  function refresh({projectChanged=true}={}) {
    if (!opened || disposed) return;
    try {
      // Queue/connection events and selection changes do not change source pixels.
      // Keep one read-only display snapshot rather than copying every photo on
      // each poll. Older hosts invalidate it through editor notifications.
      const revision=editor.state?.().projectRevision;
      if(!previewProject||(Number.isSafeInteger(revision)?revision!==previewRevision:projectChanged)){
        previewProject=project();previewRevision=revision;
      }
      const current = previewProject, settings = getSheetPreset(current), main = source(current);
      const choices = getSheetSources(current), subjects=getSheetSubjectSources(current), subjectIds=new Set(subjects.map(photo=>photo.id));
      const key = JSON.stringify({main:main?.id, name:main?.name, sources:choices.map(ref => [ref.id,ref.name,ref.annotations,ref.notes]), ids:settings.referenceIds,subjects:settings.subjectIds,edits:settings.photoEdits});
      if (renderKey !== key) {
        renderKey = key;
        find('[data-sheet-source]').innerHTML = subjects.length
          ? `<div class="sheet-subject-list">${subjects.map(photo=>photoCard(current,photo,'subject',main?.id)).join('')}</div>`
          : '<p class="sheet-empty-references">Choose, drop or paste your subject photos here.</p>';
        if(choices.length)find('[data-sheet-source]').insertAdjacentHTML('beforeend',`<label class="sheet-select-label">Main subject reference<select data-sheet-primary aria-label="Main subject reference">${!main?'<option value="" disabled selected>Choose your subject</option>':''}${choices.map(ref=>`<option value="${escape(ref.id)}" ${ref.id===main?.id?'selected':''}>${escape(ref.name||'Photo')}</option>`).join('')}</select></label>`);
        const addExisting=find('[data-sheet-add-existing="subjects"]'),unused=choices.filter(photo=>!subjectIds.has(photo.id));
        addExisting.innerHTML='<option value="">Choose another project photo…</option>'+unused.map(photo=>`<option value="${escape(photo.id)}">${escape(photo.name||'Photo')}</option>`).join('');
        addExisting.closest('label').hidden=!unused.length;
        const extraRefs = current.references.filter(ref => !subjectIds.has(ref.id));
        find('[data-sheet-references]').innerHTML = extraRefs.length
          ? extraRefs.map(ref => photoCard(current,ref,'detail',main?.id)).join('')
          : '<p class="sheet-empty-references">Your subject photos are enough to start. Add detail references here if needed.</p>';
        void thumbnailPreviews(current);
      }
      for (const button of panel.querySelectorAll('[data-sheet-subject]')) button.setAttribute('aria-pressed', String(button.dataset.sheetSubject === settings.subject));
      for (const button of panel.querySelectorAll('[data-sheet-views]')) button.setAttribute('aria-pressed', String(Number(button.dataset.sheetViews) === settings.views));
      const notes = find('[data-sheet-notes]');
      if (document.activeElement !== notes && notesDraft === null) notes.value = settings.notes;
      find('[data-sheet-preview-title]').textContent = `${settings.views} views, one image`;
      const layout = find('[data-sheet-layout]');
      layout.classList.toggle('is-seven', settings.views === 7);
      const layoutKey=settings.subject+':'+settings.views;
      if(layout.dataset.layout!==layoutKey){layout.dataset.layout=layoutKey;layout.innerHTML = sheetAngles(settings).map((angle,index) => `<div class="sheet-layout-tile"><span class="sheet-layout-subject ${escape(settings.subject)}" aria-hidden="true"><i></i><b></b></span><small>${escape(angle)}</small><span class="sheet-layout-number" aria-hidden="true">${index + 1}</span></div>`).join('');}
      find('[data-sheet-prompt]').textContent = buildSheetPrompt(current);
      const hostState = bridge.state?.() || {}, canGenerate = Boolean(hostState.canAttach && typeof bridge.generate === 'function');
      find('[data-sheet-action="generate"]').hidden = !canGenerate && !hostState.direct;
      const recovering=hostState.direct?hostState.uncertainRequestId:hostState.pending;
      find('[data-sheet-action="generate"]').disabled = busy || Boolean(hostState.working) || (!recovering && (!main || !canGenerate || Boolean(hostState.settingsError)));
      if (!busy) find('[data-sheet-action="generate"]').innerHTML = `<span aria-hidden="true">✦</span> ${recovering ? 'Check submission' : 'Generate sheet'}`;
      find('[data-sheet-connection]').hidden = !hostState.direct;
      const modelSelect = find('[data-sheet-model]');
      const availableModels = (hostState.models || []).filter(model => model.available);
      const optionsKey = JSON.stringify([hostState.model,availableModels.map(model => [model.id,model.label])]);
      if (modelSelect.dataset.options !== optionsKey) {
        modelSelect.dataset.options = optionsKey;
        modelSelect.innerHTML = availableModels.length ? availableModels.map(model => `<option value="${escape(model.id)}">${escape(model.label || model.id)}</option>`).join('') : '<option value="">No image model connected</option>';
        if(hostState.model && !availableModels.some(model=>model.id===hostState.model))modelSelect.insertAdjacentHTML('beforeend',`<option value="${escape(hostState.model)}" disabled>${escape(hostState.model)} (unavailable)</option>`);
      }
      modelSelect.value = hostState.model || '';
      modelSelect.disabled = busy || Boolean(hostState.working) || !availableModels.length || (!hostState.direct&&hostState.pending);
      const qualitySelect=find('[data-sheet-quality]'),qualityValue=hostState.quality??DEFAULT_GENERATION_QUALITY,qualities=hostState.qualityOptions||generationQualityOptions(hostState.model),qualityKey=JSON.stringify([qualities,qualityValue]);
      if(qualitySelect.dataset.options!==qualityKey){qualitySelect.dataset.options=qualityKey;qualitySelect.innerHTML=qualities.map(value=>`<option value="${escape(value)}">${escape(value==='high'?'high (default)':value)}</option>`).join('');if(!qualities.includes(qualityValue))qualitySelect.insertAdjacentHTML('beforeend',`<option value="${escape(qualityValue)}" disabled>${escape(qualityValue)} (unsupported)</option>`);}
      qualitySelect.value=qualityValue;qualitySelect.disabled=busy||Boolean(hostState.working)||(!hostState.direct&&hostState.pending)||!hostState.model;
      complexityControls.sync(hostState,{disabled:busy||(!hostState.direct&&hostState.pending)||!hostState.model});
      find('[data-sheet-quality-message]').textContent=hostState.settingsError||'';find('[data-sheet-quality-message]').hidden=!hostState.settingsError;
      find('[data-sheet-connection-message]').textContent = hostState.message || '';
      const completed = hostState.result;
      find('[data-sheet-result]').hidden = !completed?.image;
      if(!completed?.image){displayedResult=null;resultPreview.removeAttribute('src');delete resultPreview.dataset.job;resultDetails?.dispose();resultDetails=null;find('[data-sheet-generation-details]').replaceChildren();loadWorkflowResult();}
      const resultActions = find('[data-sheet-result-edit-actions]'), canEditOutput = typeof bridge.editOutput === 'function', canRestore = typeof bridge.restoreSource === 'function';
      resultActions.hidden = !canEditOutput && !canRestore;
      find('[data-sheet-action="result-edit"]').hidden = !canEditOutput;
      find('[data-sheet-action="result-edit"]').disabled = busy || Boolean(hostState.working) || !completed?.image;
      find('[data-sheet-action="result-redo"]').hidden = !canRestore;
      find('[data-sheet-action="result-redo"]').disabled = busy || Boolean(hostState.working) || completed?.sourceProjectAvailable !== true;
      find('[data-sheet-result-restore-help]').textContent = completed?.sourceProjectAvailable === true ? 'Redo restores the original image, selected areas, references and instructions saved with this generation.' : completed?.sourceProjectMessage || missingSourceMessage;
      if (completed?.image && (find('[data-sheet-result-image]').dataset.job !== completed.id || !resultDetails)) {
        displayedResult = completed;
        const image = find('[data-sheet-result-image]');image.src = completed.image.source;image.dataset.job = completed.id;
        find('[data-sheet-result-caption]').textContent = 'Last generated sheet · ' + (completed.sourceName || completed.image.name || 'Character / item sheet');
        resultDetails?.dispose();resultDetails=renderGenerationDetails(find('[data-sheet-generation-details]'),completed,{kind:'sheet'});
      }
      find('.sheet-layout-caption').textContent = hostState.direct ? 'Layout guide · Generate sheet creates the finished image.' : 'Layout guide · your AI app creates the finished views.';
      const downloadButton = find('[data-sheet-action="download"]');
      downloadButton.classList.toggle('sheet-primary', !canGenerate);
      downloadButton.classList.toggle('sheet-secondary', canGenerate);
      downloadButton.disabled = busy || !main;
      find('[data-sheet-action="save"]').hidden = typeof bridge.save !== 'function';
      find('[data-sheet-action="save"]').disabled = busy || Boolean(hostState.working) || hostState.canSave === false;
      find('[data-sheet-delivery-help]').textContent = hostState.direct
        ? 'Generate saves this setup in Job queue. You can close this page and start another project while it runs. Uses your connected API account; API charges apply.'
        : canGenerate
        ? 'Generate sends your source photos and automatic instructions to ChatGPT. You can also download a pack for another AI app.'
        : 'Download one ZIP with your source photos and ready-to-use instructions, then attach it to your AI app to create the sheet.';
      if (busy) for (const control of panel.querySelectorAll('button,input,textarea,select')) control.disabled = true;
    } catch (error) { status(error?.message || String(error), true); }
  }
  async function addFiles(files, references) {
    const list=Array.from(files||[]);if(!list.length)return;
    if(list.some(file=>!/^image\/(png|jpeg|webp)$/i.test(file.type||'') && !(!file.type&&/\.(png|jpe?g|webp)$/i.test(file.name||''))))throw new Error('Choose PNG, JPEG or WebP photos.');
    const current=project(),before=new Set(getSheetSources(current).map(photo=>photo.id));
    if(!references&&!source(current)&&!current.layers.length&&!Object.keys(current.assets).length) {
      // This path needs two editor imports (canvas source, then references).
      // Validate the complete batch before either can commit. The existing
      // decoder cache reuses decoded originals when the editor imports them.
      if(list.length>1)for(const file of list){
        try{await readOriginalImage(file);}
        catch(error){const detail=error?.message||'This photo could not be read. Choose another PNG, JPEG or WebP image.';throw new Error(`${detail.includes(file.name)?detail:file.name+': '+detail} No photos from this batch were added.`);}
      }
      await editor.importImages(list.slice(0,1),{references:false});
      if(list.length>1)await editor.importImages(list.slice(1),{references:true});
    } else await editor.importImages(list,{references:true});
    const after=project(),existing=getSheetPreset(after),added=getSheetSources(after).filter(photo=>!before.has(photo.id));
    if(references)commit({active:true,referenceIds:[...new Set([...existing.referenceIds,...added.map(photo=>photo.id)])]});
    else {
      const main=source(after)||added[0],ids=[...new Set([...(existing.subjectIds||[]),...added.map(photo=>photo.id)])].filter(id=>id!==main.id);
      commit({active:true,sourceId:main.id,subjectIds:ids,referenceIds:existing.referenceIds.filter(id=>id!==main.id&&!ids.includes(id))});
    }
    status(`${added.length} ${references?'detail reference':'subject'} photo${added.length===1?'':'s'} added. Click a photo to enlarge and annotate it.`);
  }
  async function importFiles(files, references) {
    const list=Array.from(files||[]);if(!list.length)return;
    await run('upload',()=>addFiles(list,references));
  }
  async function pastePhotos(section) {
    pasteSection=section;
    await run('upload',async()=>addFiles(await readClipboardImages(),section==='details'));
  }
  function makeMain(id) {
    const current=project(),settings=getSheetPreset(current),previous=getSheetSubjectSources(current).map(photo=>photo.id);
    commit({sourceId:id,subjectIds:[...new Set(previous)].filter(photoId=>photoId!==id),referenceIds:settings.referenceIds.filter(photoId=>photoId!==id)},'Choose main sheet subject');
    refresh();status('Main subject updated. The other subject photos remain included.');
  }
  async function chooseFiles(references) {
    if (busy) return;
    try {
      flushNotes();
      if (pickPhoto) {
        const picked = await pickPhoto();
        if (picked !== null && picked !== undefined) { await importFiles(picked, references); return; }
      }
      find(references ? '[data-sheet-reference-input]' : '[data-sheet-source-input]').click();
    } catch (error) { status(error?.message || String(error), true); }
  }
  async function downloadPack() {
    await run('download', async () => {
      status('Preparing your photos and sheet instructions…');
      const pack = await exportSheetPack(project());
      let receipt;
      if (download) receipt = await download(pack.blob, pack.filename);
      else {
        const url = URL.createObjectURL(pack.blob), anchor = document.createElement('a');
        anchor.href = url; anchor.download = pack.filename; anchor.textContent = 'Save sheet pack';
        document.body.append(anchor); anchor.click(); anchor.remove(); setTimeout(() => URL.revokeObjectURL(url), 60000);
        receipt = {initiated:true};
      }
      if (receipt?.cancelled || receipt?.initiated === false) { status('Save canceled. Your sheet settings are still here.'); return; }
      savedReceipt = receipt;
      const path = receipt?.absolutePath || receipt?.path || receipt?.receipt?.absolutePath;
      status(path ? `Sheet pack saved: ${path}. Attach the ZIP to your AI app and ask it to follow request.txt.` : `${receipt?.saved ? 'Sheet pack ready.' : 'Download requested.'} Attach the ZIP to your AI app and ask it to follow request.txt. If ZIPs are unsupported, extract it and attach the source photos with the instructions.`);
      find('[data-sheet-action="reveal"]').hidden = !(receipt?.packId && path && typeof bridge.revealSavedPack === 'function');
    });
  }
  function open() {
    if (disposed || busy) return;
    try {
      if (!opened) {
        returnFocus = document.activeElement;
        if (!getSheetPreset(project()).active || !project().sheetPreset) commit({active:true}, 'Create character / item sheet');
        opened = true; panel.hidden = false; renderKey = '';
        const strip=document.getElementById('workflowTabStrip');if(strip&&strip.parentElement!==document.body){workflowStripPosition={element:strip,parent:strip.parentNode,next:strip.nextSibling};document.body.append(strip);}
        inertElements = Array.from(document.body.children).filter(element => element !== panel && element!==strip && !['SCRIPT','STYLE','LINK','DIALOG'].includes(element.tagName)).map(element => [element, element.inert]);
        for (const [element] of inertElements) element.inert = true;
        document.body.classList.add('sheet-creator-open');
      }
      refresh();
      status(source(project()) ? 'Choose your subject reference, then generate its sheet. Seven angles and a white background are ready.' : 'Choose a subject photo to begin.');
      requestAnimationFrame(() => find('[data-sheet-action="close"]').focus());
      const version=bridge.state?.().workflowVersion;
      if (bridge.prepare) void bridge.prepare().then(() => {if(bridge.state?.().workflowVersion===version)refresh({projectChanged:false});}).catch(error => {if(opened&&bridge.state?.().workflowVersion===version)status(error.message, true);});
    } catch (error) { status(error?.message || String(error), true); }
  }
  function close({preserveProject = false, allowBusy = false} = {}) {
    if (!opened || (busy && !allowBusy)) return false;
    if(photoEditor.isOpen())photoEditor.close();
    try {
      flushNotes();
      if (!preserveProject && project().sheetPreset?.active) commit({active:false}, 'Return to image editing');
    } catch (error) { status(error?.message || String(error), true); return false; }
    opened = false; panel.hidden = true; document.body.classList.remove('sheet-creator-open');
    previewProject=null;previewRevision=null;
    resultInspector?.close();resultInspector=null;
    resultDetails?.dispose();resultDetails=null;
    for (const [element, wasInert] of inertElements) if (element.isConnected) element.inert = wasInert;
    inertElements = [];
    if(workflowStripPosition){const {element,parent,next}=workflowStripPosition;if(parent.isConnected)parent.insertBefore(element,next?.parentNode===parent?next:null);workflowStripPosition=null;}
    if (returnFocus?.isConnected) returnFocus.focus();
    return true;
  }
  panel.addEventListener('click', event => {
    const button = event.target.closest('button');
    if (!button || busy) return;
    const section=button.closest('[data-sheet-drop]')?.dataset.sheetDrop;if(section)pasteSection=section;
    if(button.dataset.sheetPhoto) {
      try{flushNotes();const photo=getSheetPhoto(project(),button.dataset.sheetPhoto);if(photo)void photoEditor.open(photo).catch(error=>status(error.message,true));}catch(error){status(error.message,true);}return;
    }
    if(button.dataset.sheetPaste){void pastePhotos(button.dataset.sheetPaste);return;}
    if(button.dataset.sheetWeb){const query=find(`[data-sheet-search="${button.dataset.sheetWeb}"]`).value;window.open(referenceSearchUrl(query),'_blank','noopener,noreferrer');status('Drag a photo from the search results into this section, or copy the image and use Paste photos.');return;}
    if(button.dataset.sheetRemoveSubject){try{flushNotes();commit({subjectIds:(getSheetPreset(project()).subjectIds||[]).filter(id=>id!==button.dataset.sheetRemoveSubject)});refresh();status('Photo removed from the sheet subjects. It is still saved in your project.');}catch(error){status(error.message,true);}return;}
    if(button.dataset.sheetMain){try{flushNotes();makeMain(button.dataset.sheetMain);}catch(error){status(error.message,true);}return;}
    if (button.dataset.sheetSubject || button.dataset.sheetViews) {
      try { flushNotes(); commit(button.dataset.sheetSubject ? {subject:button.dataset.sheetSubject} : {views:Number(button.dataset.sheetViews)}); refresh(); } catch (error) { status(error.message, true); }
      return;
    }
    const action = button.dataset.sheetAction;
    if (action === 'close') close();
    else if (action === 'queue') {if(close({preserveProject:true}))onOpenQueue?.();}
    else if (action === 'image-edit') { try { flushNotes(); commit({active:false}, 'Return to image editing'); close(); } catch (error) { status(error.message, true); } }
    else if (action === 'upload') void chooseFiles(false);
    else if (action === 'add-references') void chooseFiles(true);
    else if (action === 'download') void downloadPack();
    else if (action === 'save') void run('save', async () => { await bridge.save(); status('Project saved with your sheet settings and original photos.'); });
    else if (action === 'reveal') void run('reveal', async () => { await bridge.revealSavedPack(savedReceipt); });
    else if (action === 'generate') void run('generate', async () => {
      status(bridge.state?.().direct ? 'Saving this sheet job and its subject photos…' : 'Sending your sheet request and references to ChatGPT…');
      if(!bridge.state?.().uncertainRequestId)await beforeGenerate?.();
      const result = await bridge.generate();
      if (result?.status && !['sent','complete','completed',...(bridge.state?.().direct?['queued','running']:[])].includes(result.status)) throw new Error(result.message || 'The sheet request was not sent. Download the pack to use it in your AI app.');
      if(bridge.state?.().direct){status(result?.image?'Your sheet is ready in Job queue.':'Added to Job queue. You can close this page and start a new project; this job keeps its photos and instructions.');onQueued(result);}
      else status(result?.message || 'Sheet request sent. The generated image will appear in your AI conversation.');
      if (result?.image) find('[data-sheet-result]').scrollIntoView({block:'nearest',behavior:'smooth'});
    });
    else if (action === 'connection') void run('connection', async () => { await bridge.prepare?.();status(bridge.state?.().uncertainRequestId ? 'Choose Check submission to recover the existing job.' : bridge.state?.().activeCount ? 'Sheets are processing in Job queue. You can keep working.' : bridge.state?.().message || 'Connection checked.'); });
    else if (action === 'result-inspect') {
      const image = displayedResult?.image;if (!image) return;
      resultInspector?.close();
      resultInspector = openGeneratedImageInspector(image, {title:'Inspect generated sheet', returnFocus:button, onSave:async () => {
        await download?.(originalBlob(image), image.name || 'Character item sheet.png');
        status('Sheet image download requested.');
      }});
    }
    else if (action === 'result-download') void run('result-download', async () => {
      const image = bridge.state?.().result?.image;if (!image) return;
      const blob = originalBlob(image);
      await download?.(blob, image.name || 'Character item sheet.png');status('Sheet image download requested.');
    });
    else if (action === 'result-reference') void run('result-reference', async () => {
      const image = bridge.state?.().result?.image;if (!image) return;
      const blob = originalBlob(image);
      await editor.importImages([new File([blob],image.name || 'Character item sheet.png',{type:blob.type})],{references:true});
      status('Generated sheet added to your project references. Save your project to keep it with your editable work.');
    });
    else if (action === 'result-edit') void run('result-edit', async () => {
      const completed = bridge.state?.().result;
      if (!completed?.image || typeof bridge.editOutput !== 'function') throw new Error('The generated image is not available for editing.');
      if (!close({preserveProject:true, allowBusy:true})) throw new Error('Finish your current photo edits before opening the output.');
      await bridge.editOutput(completed);
      status('The generated sheet is ready to edit. Use Auto detect or Highlight to select what to change.');
    });
    else if (action === 'result-redo') void run('result-redo', async () => {
      const completed = bridge.state?.().result;
      if (completed?.sourceProjectAvailable !== true || typeof bridge.restoreSource !== 'function') throw new Error(completed?.sourceProjectMessage || missingSourceMessage);
      status('Opening the original image, areas and references…');
      await bridge.restoreSource(completed, {beforeApply:() => {
        if (!close({preserveProject:true, allowBusy:true})) throw new Error('Finish your current photo edits before returning to this setup.');
      }});
      status('Your saved setup is ready. Add more edits or references, then generate when you are ready.');
    });
  });
  panel.addEventListener('change', event => {
    const target = event.target;
    if (target.matches('[data-sheet-source-input],[data-sheet-reference-input]')) { void importFiles(target.files, target.matches('[data-sheet-reference-input]')); target.value = ''; }
    else if (target.matches('[data-sheet-primary]')) {
      try { flushNotes();makeMain(target.value); } catch (error) { status(error.message, true); }
    } else if(target.matches('[data-sheet-add-existing]')&&target.value) {
      try {flushNotes();const current=project(),settings=getSheetPreset(current),id=target.value;commit({...(source(current)?{subjectIds:[...new Set([...(settings.subjectIds||[]),id])]}:{sourceId:id}),referenceIds:settings.referenceIds.filter(value=>value!==id)});refresh();status('Subject photo included. Click it to enlarge and annotate.');}catch(error){status(error.message,true);}
    } else if (target.matches('[data-sheet-model]')) { bridge.selectModel?.(target.value); }
    else if(target.matches('[data-sheet-quality]')){try{bridge.selectQuality?.(target.value);status('Quality set to '+target.value+'. This setting will be sent unchanged.');}catch(error){status(error.message,true);}refresh();}
    else if (target.matches('[data-sheet-reference]')) {
      try { flushNotes(); const ids = new Set(getSheetPreset(project()).referenceIds); target.checked ? ids.add(target.dataset.sheetReference) : ids.delete(target.dataset.sheetReference); commit({referenceIds:[...ids]}); refresh(); } catch (error) { status(error.message, true); }
    } else if (target.matches('[data-sheet-notes]')) { try { flushNotes(); } catch (error) { status(error.message, true); } }
  });
  find('[data-sheet-notes]').addEventListener('input', event => {
    notesDraft = event.target.value;
    if (notesTimer) clearTimeout(notesTimer);
    notesTimer = setTimeout(() => { try { flushNotes(); refresh(); } catch (error) { status(error.message, true); } }, 220);
  });
  panel.addEventListener('focusin',event=>{const section=event.target.closest('[data-sheet-drop]')?.dataset.sheetDrop;if(section)pasteSection=section;});
  panel.addEventListener('paste', event => {
    event.stopPropagation();if(isTextInput(event.target))return;event.preventDefault();if(busy)return;
    try {const files=clipboardImageFiles(event.clipboardData),section=event.target.closest('[data-sheet-drop]')?.dataset.sheetDrop||pasteSection;void importFiles(files,section==='details');}catch(error){status(error.message,true);}
  });
  panel.addEventListener('dragover',event=>{event.preventDefault();event.stopPropagation();if(busy)return;const zone=event.target.closest('[data-sheet-drop]');for(const item of panel.querySelectorAll('[data-sheet-drop]'))item.classList.toggle('is-dragging',item===zone);if(event.dataTransfer)event.dataTransfer.dropEffect=zone?'copy':'none';});
  panel.addEventListener('dragleave',event=>{const zone=event.target.closest('[data-sheet-drop]');if(zone&&!zone.contains(event.relatedTarget))zone.classList.remove('is-dragging');});
  panel.addEventListener('drop',event=>{
    event.preventDefault();event.stopPropagation();for(const item of panel.querySelectorAll('[data-sheet-drop]'))item.classList.remove('is-dragging');
    if(busy)return;const section=event.target.closest('[data-sheet-drop]')?.dataset.sheetDrop;
    if(!section){status('Drop photos inside Choose your subject or Add the details.',true);return;}
    pasteSection=section;
    try {const pending=sheetDropInput(event.dataTransfer);void run('upload',async()=>{const input=await pending,files=[...input.files];for(const url of input.urls){status('Importing your web photo…');files.push(await sheetWebPhotoFile(url));}await addFiles(files,section==='details');});}catch(error){status(error.message,true);}
  });
  panel.addEventListener('keydown', event => {
    event.stopPropagation();
    if (document.querySelector('dialog[open]')) return;
    if(event.key==='Enter'&&event.target.matches('[data-sheet-search]')){event.preventDefault();find(`[data-sheet-web="${event.target.dataset.sheetSearch}"]`).click();return;}
    if (event.key === 'Escape') { event.preventDefault(); close(); return; }
    if (event.key !== 'Tab') return;
    const focusable = [...panel.querySelectorAll('button:not(:disabled),input:not(:disabled),textarea:not(:disabled),select:not(:disabled),summary,a[href]')].filter(element => !element.hidden && !element.closest('[hidden]') && element.getClientRects().length);
    const first = focusable[0], last = focusable.at(-1);
    if (event.shiftKey && (document.activeElement === first || !panel.contains(document.activeElement))) { event.preventDefault(); last?.focus(); }
    else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
  });
  const unsubscribe = editor.subscribe?.(refresh);
  const unsubscribeBridge = bridge.subscribe?.(event=>{if(event?.type==='workflow')resetWorkflowView();refresh({projectChanged:false});const state=bridge.state?.(),belongs=!state?.workflowScoped||state.workflowJobIds.includes(event?.record?.id);if(opened&&belongs&&event?.type==='completed')status('A sheet is ready in Job queue. Your current setup has not changed.');else if(opened&&belongs&&event?.type==='failed')status(event.record?.message||'A sheet job failed. Open Job queue for its details.',true);});
  function card() {
    const element = document.createElement('button');
    element.type = 'button'; element.className = 'sheet-creation-card'; element.dataset.sheetCreationCard = '';
    element.innerHTML = `${glyph()}<span class="sheet-card-copy"><strong>Character / item sheet</strong><span>One subject. 7 views. One sheet.</span><small>White background · No prompt to write</small><b>Create sheet <span aria-hidden="true">→</span></b></span>`;
    element.addEventListener('click', () => { element.closest('dialog')?.close(); open(); });
    return element;
  }
  return {open, close, card, refresh, switchWorkflow, state:()=>({opened,busy,photoEditing:photoEditor.isOpen()}), flush:flushNotes, useGenerationSettings(record) {bridge.useSettings?.(record);}, dispose() { if (disposed) return; busy = false; close(); disposed = true; if (notesTimer) clearTimeout(notesTimer); unsubscribe?.();unsubscribeBridge?.(); photoEditor.dispose();panel.remove(); }};
}
