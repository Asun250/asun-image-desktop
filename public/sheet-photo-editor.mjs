import {createReferenceEditor} from './reference-editor.mjs';

let instanceCount = 0;

/** An isolated annotation draft. Saving never changes the original photo bytes. */
export function createSheetPhotoEditor({onSave, onError = () => {}} = {}) {
  if (typeof onSave !== 'function') throw new TypeError('A save callback is required for the sheet photo editor.');
  const instance = ++instanceCount, prefix = `sheetPhoto${instance}_`;
  const stylesheet = new URL('./sheet-photo-editor.css', import.meta.url).href;
  let styleLink = [...document.querySelectorAll('link[rel~="stylesheet"]')].find(link => link.href === stylesheet);
  if (!styleLink) {styleLink = document.createElement('link');styleLink.rel = 'stylesheet';styleLink.href = stylesheet;document.head.append(styleLink);}
  const styleReady = styleLink.sheet ? Promise.resolve() : new Promise((resolve, reject) => {
    styleLink.addEventListener('load', resolve, {once:true});
    styleLink.addEventListener('error', () => reject(new Error('The photo editor could not load its layout. Refresh Asun IMG and try again.')), {once:true});
  });
  void styleReady.catch(() => {}); // Report a failed stylesheet when open() is requested.
  const dialog = document.createElement('dialog');
  dialog.id = instance === 1 ? 'sheetPhotoDialog' : `sheetPhotoDialog${instance}`;
  dialog.className = 'sheet-photo-dialog';dialog.dataset.sheetPhotoEditor = '';
  dialog.setAttribute('aria-labelledby', prefix + 'title');
  dialog.innerHTML = `<header class="sheet-photo-header"><div><h2 id="${prefix}title" data-sheet-photo-title>Edit reference photo</h2><p data-sheet-photo-name></p></div><div class="sheet-photo-header-actions"><button type="button" data-sheet-photo-save class="sheet-photo-primary">Save and back</button><button type="button" data-sheet-photo-close aria-label="Cancel photo edits and close">×</button></div></header><div class="sheet-photo-workspace" data-sheet-photo-workspace></div><div class="sheet-photo-notes"><label for="${prefix}notes">Instructions for this photo</label><textarea id="${prefix}notes" data-sheet-photo-notes maxlength="2000" rows="2" placeholder="Only use the circled building; exclude everything else."></textarea><p>Circle or highlight what to use, then describe it here. The original photo stays intact.</p></div><footer class="sheet-photo-footer"><p data-sheet-photo-status role="status" aria-live="polite">Your marks and notes stay editable.</p><div><button type="button" data-sheet-photo-cancel>Cancel</button><button type="button" data-sheet-photo-save class="sheet-photo-primary">Save and back</button></div></footer>`;
  document.body.append(dialog);
  const workspace = dialog.querySelector('[data-sheet-photo-workspace]'), notes = dialog.querySelector('[data-sheet-photo-notes]');
  let photo = null, saving = false, disposed = false, returnFocus = null, returnPhotoId = null, internalCloses = 0, openGeneration = 0;
  const status = (message, failed = false) => {
    const target = dialog.querySelector('[data-sheet-photo-status]');
    target.textContent = message;target.classList.toggle('is-error', failed);
  };
  const report = cause => {
    const error = cause instanceof Error ? cause : new Error(String(cause));status(error.message, true);
    try {onError(error);} catch { /* The editor still shows the error. */ }
  };
  const editor = createReferenceEditor(workspace, {idPrefix:prefix, dialogParent:dialog,
    onError:report, onChange:() => {if (!saving) status('Unsaved photo edits. Choose Save and back to keep them.');}});
  editor.setExpanded(true);

  function restoreFocus() {
    // Saving may rebuild the thumbnail list, replacing the original button.
    const target = returnFocus?.isConnected ? returnFocus : returnPhotoId === null ? null : document.querySelector(`[data-sheet-photo="${CSS.escape(returnPhotoId)}"]`);
    if (target?.isConnected && !target.inert) target.focus({preventScroll:true});
  }
  function hide() {if (dialog.open) {internalCloses++;dialog.close();}}
  function clear() {photo = null;openGeneration++;editor.clear();notes.value = '';}
  function close() {
    if (disposed || saving) return false;
    hide();clear();restoreFocus();return true;
  }
  function setBusy(value) {
    saving = value;dialog.setAttribute('aria-busy', String(value));
    for (const button of dialog.querySelectorAll('[data-sheet-photo-save],[data-sheet-photo-cancel],[data-sheet-photo-close]')) button.disabled = value;
    notes.disabled = value;
    for (const button of dialog.querySelectorAll('[data-sheet-photo-save]')) button.textContent = value ? 'Saving…' : 'Save and back';
  }
  async function save() {
    if (saving || disposed || !photo) return;
    let patch;
    try {patch = {annotations:editor.flush(), notes:notes.value};}
    catch {return;} // The reference editor reports validation and preserves its draft.
    const id = photo.id;
    setBusy(true);status('Saving photo edits…');
    // The application intentionally rejects mutations while a dialog is open.
    // Keep the draft loaded so a failed parent commit can reopen it unchanged.
    hide();
    try {
      await onSave(id, patch);
      if (!disposed) {clear();restoreFocus();}
    } catch (error) {
      if (!disposed) {
        dialog.showModal();report(error);
        workspace.querySelector('[data-ref-id="refCanvasStage"]')?.focus({preventScroll:true});
      }
    } finally {if (!disposed) setBusy(false);}
  }
  dialog.addEventListener('click', event => {
    const button = event.target.closest('button');
    if (button?.matches('[data-sheet-photo-save]')) {void save();return;}
    if (button?.matches('[data-sheet-photo-close],[data-sheet-photo-cancel]')) close();
  });
  notes.addEventListener('input', () => status('Unsaved photo edits. Choose Save and back to keep them.'));
  dialog.addEventListener('cancel', event => {event.preventDefault();event.stopPropagation();close();});
  dialog.addEventListener('close', () => {
    if (internalCloses) {internalCloses--;return;}
    if (!disposed && !saving) {clear();restoreFocus();}
  });
  // Child editor handlers consume Escape while a text/stroke draft exists.
  // Only the next Escape reaches this listener and cancels the photo session.
  dialog.addEventListener('keydown', event => {
    event.stopPropagation();
    if (event.key === 'Escape' && !event.defaultPrevented) {event.preventDefault();close();}
  });
  for (const type of ['paste','copy','cut']) dialog.addEventListener(type, event => event.stopPropagation());

  return {
    async open(next) {
      if (disposed) throw new Error('This photo editor has been disposed.');
      if (saving) throw new Error('Wait for the photo edits to finish saving.');
      if (!next || typeof next.id !== 'string') throw new Error('Choose a reference photo to edit.');
      if (!dialog.open) {returnFocus = document.activeElement;returnPhotoId = returnFocus?.closest?.('[data-sheet-photo]')?.getAttribute('data-sheet-photo') ?? null;}
      const candidate = structuredClone({...next, annotations:next.annotations || [], notes:next.notes || ''});
      photo = candidate;const generation = ++openGeneration;
      dialog.querySelector('[data-sheet-photo-name]').textContent = `${candidate.name || 'Reference photo'} · ${candidate.width} × ${candidate.height}`;
      notes.value = candidate.notes;status('Circle or highlight the subject, add notes, then Save and back.');
      try {
        // Fit-dependent brush/text defaults must see the final enlarged layout.
        await styleReady;
        if (disposed || generation !== openGeneration) return;
        if (!dialog.open) dialog.showModal();
        await editor.load(candidate);
        if (disposed || generation !== openGeneration || !dialog.open) return;
        workspace.querySelector('[data-ref-id="refCanvasStage"]')?.focus({preventScroll:true});
      } catch (error) {if (!disposed && generation === openGeneration) {hide();clear();restoreFocus();} throw error;}
    },
    close,
    isOpen:() => photo !== null || dialog.open || saving,
    dispose() {if (disposed) return;hide();disposed = true;openGeneration++;photo = null;editor.destroy();dialog.remove();restoreFocus();},
  };
}
