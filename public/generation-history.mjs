import {generationAPI, generationDate, generationDimensions, generationJSON, renderGenerationDetails, blockoutReviewDisplay} from './generation-details.mjs';
import {isLocalGenerationAuthError,isLocalGenerationAuthResponse} from './local-generation-auth.mjs';
import {missingSourceMessage} from './generation-result-actions.mjs';
import {openGeneratedImageInspector} from './generated-image-inspector.mjs';

const byId = id => document.getElementById(id);
const list = byId('generationHistoryList'), status = byId('generationHistoryStatus'), filter = byId('generationHistoryFilter');
const more = byId('generationHistoryMore'), refresh = byId('generationHistoryRefresh'), dialog = byId('generationHistoryDetail');
const detailStatus = byId('generationHistoryDetailStatus'), output = byId('generationHistoryOutput'), outputFrame = byId('generationHistoryOutputFrame');
const save = byId('generationHistorySave'), detailRefresh = byId('generationHistoryDetailRefresh');
const inspect = byId('generationHistoryInspect');
const editOutput = byId('generationHistoryEditOutput'), redoSource = byId('generationHistoryRedo'), restoreHelp = byId('generationHistoryRestoreHelp');
const streams = Object.fromEntries(['image', 'sheet'].map(kind => [kind, {token:null, cursor:null, loaded:false, done:false, error:null}]));
const records = new Map(), thumbnailURLs = new Map(), thumbnailQueue = [];
let loading = false, epoch = 0, listController = new AbortController(), thumbnailWorkers = 0;
let detailController, detailMount, selected = null, selectedOutput = null, outputURL = null, detailEpoch = 0, resultInspector = null;
const kindName = kind => kind === 'sheet' ? 'Character / item sheet' : 'Image';
const recorded = value => value === undefined || value === null || value === '' ? 'Not recorded' : String(value);
const keyFor = (kind, id) => `${kind}:${id}`;
const relevantKinds = () => filter.value === 'all' ? ['image', 'sheet'] : [filter.value];
function element(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}
function setStatus(node, text, {busy = false, error = false} = {}) {
  node.textContent = text;node.classList.toggle('is-loading', busy);node.dataset.error = String(error);
}
function theme(value) {
  document.documentElement.dataset.theme = value === 'dark' ? 'dark' : 'light';
  byId('generationHistoryTheme').textContent = value === 'dark' ? 'Light mode' : 'Dark mode';
}
try {theme(localStorage.getItem('asun-image-appearance'));} catch {theme('light');}
byId('generationHistoryTheme').addEventListener('click', () => {
  const value = document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark';theme(value);
  try {localStorage.setItem('asun-image-appearance', value);} catch {}
});
window.addEventListener('storage', event => {if (event.key === 'asun-image-appearance') theme(event.newValue);});

async function authorize(kind, signal) {
  const stream = streams[kind], api = generationAPI(kind);
  if (!stream.token) {
    const response = await generationJSON(fetch, api.endpoint + '/status', {signal});
    if (!response.token) throw new Error('Restart Asun IMG to authorize its local history.');
    stream.token = response.token;
  }
  return {[api.tokenHeader]:stream.token};
}
async function protectedJSON(kind, suffix, signal) {
  const api = generationAPI(kind);
  try {return await generationJSON(fetch, api.endpoint + suffix, {signal, headers:await authorize(kind, signal)});}
  catch (error) {
    if (!isLocalGenerationAuthError(error)) throw error;
    streams[kind].token = null;
    return generationJSON(fetch, api.endpoint + suffix, {signal, headers:await authorize(kind, signal)});
  }
}
async function protectedBlob(kind, suffix, signal) {
  const api = generationAPI(kind);
  let response = await fetch(api.endpoint + suffix, {cache:'no-store', signal, headers:await authorize(kind, signal)});
  if (await isLocalGenerationAuthResponse(response)) {
    streams[kind].token = null;
    response = await fetch(api.endpoint + suffix, {cache:'no-store', signal, headers:await authorize(kind, signal)});
  }
  if (!response.ok) throw new Error(response.status === 404 || response.status === 410 ? 'This image is no longer stored.' : 'This saved image could not be loaded.');
  const blob = await response.blob();
  if (!/^image\/(png|jpeg|webp)(?:;|$)/i.test(blob.type) || !blob.size || blob.size > 50 * 1024 * 1024) throw new Error('The saved file is not a supported image.');
  return blob;
}
function visibleRecords() {
  const kinds = relevantKinds();
  return [...records.values()].filter(record => kinds.includes(record.kind)).sort((a, b) => {
    const time = record => Date.parse(record.createdAt || record.finishedAt || '') || 0;
    return time(b) - time(a) || a.id.localeCompare(b.id);
  });
}
function updateStatus() {
  const kinds = relevantKinds(), errors = kinds.filter(kind => streams[kind].error).map(kind => `${kindName(kind)} history: ${streams[kind].error}`);
  const count = visibleRecords().length;
  if (loading) setStatus(status, count ? `Loading more generations… ${count} shown.` : 'Loading your generation history…', {busy:true});
  else if (errors.length) setStatus(status, `${count ? `${count} generations shown. ` : ''}${errors.join(' ')}`, {error:true});
  else setStatus(status, count ? `${count} ${count === 1 ? 'generation' : 'generations'} shown. Open a card to see its prompt and input photos.` : 'No generations have been saved yet.');
  more.hidden = kinds.every(kind => streams[kind].done);
  more.disabled = loading;refresh.disabled = loading;filter.disabled = loading;
}
const intersection = typeof IntersectionObserver === 'function' ? new IntersectionObserver(entries => {
  for (const entry of entries) if (entry.isIntersecting) {intersection.unobserve(entry.target);queueThumbnail(entry.target);}
}, {rootMargin:'200px'}) : null;
function showThumbnail(frame, url, record) {
  const image = element('img', 'generation-history-thumbnail');image.src = url;image.alt = `${kindName(record.kind)}: ${record.sourceName || 'Generated result'}`;image.loading = 'lazy';
  frame.replaceChildren(image);
}
async function thumbnail(blob) {
  // Only retain a small preview for each list card, not every full-size output.
  let source, temporaryURL;
  try {
    if (typeof createImageBitmap === 'function') source = await createImageBitmap(blob);
    else {
      temporaryURL = URL.createObjectURL(blob);source = new Image();source.src = temporaryURL;await source.decode();
    }
    const scale = Math.min(1, 480 / Math.max(source.width, source.height));
    const canvas = document.createElement('canvas');canvas.width = Math.max(1, Math.round(source.width * scale));canvas.height = Math.max(1, Math.round(source.height * scale));
    canvas.getContext('2d').drawImage(source, 0, 0, canvas.width, canvas.height);
    const small = await new Promise(resolve => canvas.toBlob(resolve, 'image/png'));
    if (!small) throw new Error('Preview unavailable.');
    return URL.createObjectURL(small);
  } finally {source?.close?.();if (temporaryURL) URL.revokeObjectURL(temporaryURL);}
}
function queueThumbnail(frame) {
  const record = records.get(frame.dataset.key);
  if (!record || !record.outputAvailable || frame.dataset.queued) return;
  const cached = thumbnailURLs.get(frame.dataset.key);
  if (cached) {showThumbnail(frame, cached, record);return;}
  frame.dataset.queued = 'true';thumbnailQueue.push({frame, record, epoch});pumpThumbnails();
}
function pumpThumbnails() {
  while (thumbnailWorkers < 2 && thumbnailQueue.length) {
    const task = thumbnailQueue.shift();
    if (task.epoch !== epoch || !task.frame.isConnected) continue;
    thumbnailWorkers++;
    (async () => {
      try {
        const blob = await protectedBlob(task.record.kind, `/jobs/${encodeURIComponent(task.record.id)}/output`, listController.signal);
        const url = await thumbnail(blob);
        if (task.epoch !== epoch) {URL.revokeObjectURL(url);return;}
        const key = keyFor(task.record.kind, task.record.id), old = thumbnailURLs.get(key);
        if (old) URL.revokeObjectURL(old);thumbnailURLs.set(key, url);
        for (const frame of list.querySelectorAll('.history-card-frame')) if (frame.dataset.key === key) showThumbnail(frame, url, task.record);
      } catch (error) {
        if (task.epoch === epoch && error.name !== 'AbortError' && task.frame.isConnected) task.frame.replaceChildren(element('span', 'history-card-placeholder', error.message));
      } finally {thumbnailWorkers--;pumpThumbnails();}
    })();
  }
}
function renderList() {
  intersection?.disconnect();list.replaceChildren();
  const items = visibleRecords();
  if (!items.length && !loading) {
    const empty = element('div', 'history-empty');empty.append(element('h2', '', relevantKinds().some(kind => streams[kind].error) ? 'History could not be loaded' : 'Your next creation starts here'), element('p', '', 'Images and character / item sheets generated in this desktop version appear here.'));
    list.append(empty);
  }
  for (const record of items) {
    const reviewDisplay = blockoutReviewDisplay(record);
    const card = element('button', 'generation-history-card');card.type = 'button';card.dataset.jobId = record.id;card.dataset.kind = record.kind;
    const frame = element('span', 'history-card-frame');frame.dataset.key = keyFor(record.kind, record.id);
    const cached = thumbnailURLs.get(frame.dataset.key);
    if (cached) showThumbnail(frame, cached, record);
    else frame.append(element('span', 'history-card-placeholder', record.outputAvailable ? 'Loading preview…' : record.status === 'expired' ? 'Output no longer stored' : record.status === 'failed' ? 'Generation failed' : record.status === 'cancelled' ? 'Canceled before generation' : record.status === 'queued' ? 'Waiting in job queue' : record.status === 'completed' ? 'Preview unavailable' : 'Generation in progress'));
    const copy = element('span', 'history-card-copy'), topline = element('span', 'history-card-topline'), state = element('span', 'history-card-state', record.outputCheck?.matches===false?'Output size mismatch':reviewDisplay?.label || recorded(record.status));state.dataset.status = record.status;
    topline.append(element('span', 'history-card-kind', kindName(record.kind)), state);
    copy.append(topline, element('strong', '', record.sourceName || 'Generated result'), element('span', 'history-card-settings', `Model: ${recorded(record.settings?.model || record.model)} · Quality: ${recorded(record.settings?.quality)}`), element('span', 'history-card-dimensions', `Requested: ${recorded(record.settings?.size)} · Actual: ${generationDimensions(record.output)}`), element('span', 'history-card-date', generationDate(record.createdAt || record.finishedAt)));
    card.append(frame, copy);card.addEventListener('click', () => openDetail(record.kind, record.id));list.append(card);
    if (!cached && record.outputAvailable) {if (intersection) intersection.observe(frame);else queueThumbnail(frame);}
  }
  updateStatus();
}
async function loadPage(reset = false) {
  if (loading) return;
  loading = true;
  if (reset) {
    epoch++;listController.abort();listController = new AbortController();records.clear();thumbnailQueue.length = 0;
    for (const url of thumbnailURLs.values()) URL.revokeObjectURL(url);thumbnailURLs.clear();
    for (const stream of Object.values(streams)) Object.assign(stream, {cursor:null, loaded:false, done:false, error:null});
    renderList();
  }
  updateStatus();
  const requestedEpoch = epoch;
  await Promise.all(relevantKinds().map(async kind => {
    const stream = streams[kind];if (stream.done) return;
    try {
      const cursor = stream.loaded && stream.cursor ? `&cursor=${encodeURIComponent(stream.cursor)}` : '';
      const result = await protectedJSON(kind, '/history?limit=20' + cursor, listController.signal);
      if (requestedEpoch !== epoch) return;
      if (!Array.isArray(result.items)) throw new Error('The local service returned an incomplete history. Restart Asun IMG and try again.');
      for (const record of result.items) if (record && typeof record.id === 'string') records.set(keyFor(kind, record.id), {...record, kind});
      const next = typeof result.nextCursor === 'string' && result.nextCursor ? result.nextCursor : null;
      stream.done = !next || next === stream.cursor;stream.cursor = next;stream.loaded = true;stream.error = null;
    } catch (error) {if (requestedEpoch === epoch && error.name !== 'AbortError') stream.error = error.message;}
  }));
  if (requestedEpoch === epoch) {loading = false;renderList();}
}
function disposeDetail() {
  resultInspector?.close();resultInspector = null;
  detailEpoch++;detailController?.abort();detailMount?.dispose();detailMount = null;
  if (outputURL) URL.revokeObjectURL(outputURL);outputURL = null;selectedOutput = null;
  output.removeAttribute('src');outputFrame.hidden = true;save.disabled = true;inspect.disabled = true;
  for (const link of [editOutput, redoSource]) {link.removeAttribute('href');link.setAttribute('aria-disabled', 'true');link.tabIndex = -1;}
  restoreHelp.textContent = '';
}
function resultEditorLink(link, record, kind, action, available) {
  const validId = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(record?.id || '');
  const enabled = available && validId;
  link.setAttribute('aria-disabled', String(!enabled));link.tabIndex = enabled ? 0 : -1;
  if (!enabled) {link.removeAttribute('href');return;}
  const url = new URL('./', location.href);
  url.search = new URLSearchParams({generation:record.id,kind,action}).toString();
  link.href = url.href;
}
async function openDetail(kind, id) {
  disposeDetail();selected = {kind, id};detailController = new AbortController();
  const thisEpoch = detailEpoch, signal = detailController.signal;
  byId('generationHistoryDetails').replaceChildren();byId('generationHistoryKind').textContent = kindName(kind);
  byId('generationHistoryTitle').textContent = records.get(keyFor(kind, id))?.sourceName || 'Generation';
  detailRefresh.disabled = true;setStatus(detailStatus, 'Loading the saved result and its request settings…', {busy:true});
  if (!dialog.open) dialog.showModal();
  try {
    const record = await protectedJSON(kind, `/jobs/${encodeURIComponent(id)}`, signal);
    if (thisEpoch !== detailEpoch) return;
    byId('generationHistoryTitle').textContent = record.sourceName || 'Generation';
    // Keep list metadata small when a full-size data URL arrives in job details.
    const {image:discardedImage, ...metadata} = record;
    records.set(keyFor(kind, id), {...metadata, kind});renderList();
    detailMount = renderGenerationDetails(byId('generationHistoryDetails'), record, {kind, token:streams[kind].token});
    resultEditorLink(redoSource, record, kind, 'redo', record.sourceProjectAvailable === true);
    restoreHelp.textContent = record.sourceProjectAvailable === true ? 'Redo restores the original image, selected areas, references and instructions saved with this generation.' : record.sourceProjectMessage || missingSourceMessage;
    const source = record.image?.source;
    if (typeof source === 'string' && /^data:image\/(png|jpeg|webp);base64,/i.test(source)) {
      selectedOutput = {source, name:record.output?.name || record.image?.name || 'Asun IMG result.png'};
    } else if (record.outputAvailable) {
      const blob = await protectedBlob(kind, `/jobs/${encodeURIComponent(id)}/output`, signal);
      if (thisEpoch !== detailEpoch) return;
      outputURL = URL.createObjectURL(blob);selectedOutput = {source:outputURL, name:record.output?.name || 'Asun IMG result.png'};
    }
    if (thisEpoch !== detailEpoch) return;
    if (selectedOutput) {output.src = selectedOutput.source;output.alt = `${kindName(kind)}: ${record.sourceName || 'Generated result'}`;outputFrame.hidden = false;save.disabled = false;inspect.disabled = false;}
    resultEditorLink(editOutput, record, kind, 'edit', Boolean(selectedOutput));
    const reviewDisplay = blockoutReviewDisplay(record);
    const message = reviewDisplay && !reviewDisplay.pending ? `${reviewDisplay.label}. ${record.message || 'Inspect the recorded checks and attempts below.'}` : record.status === 'expired' ? 'This output is no longer stored. Any recorded request settings remain below.' : record.status === 'failed' ? record.message || 'This generation failed. Its recorded request settings are below.' : record.status === 'completed' ? selectedOutput ? 'Your saved result and the settings used to create it.' : 'The output is unavailable. Any recorded request settings remain below.' : record.message || 'This generation is still in progress. Refresh this result to check for its output.';
    setStatus(detailStatus, record.outputCheck?.matches===false?record.outputCheck.message:message, {error:record.status === 'failed'||record.outputCheck?.matches===false});
  } catch (error) {if (thisEpoch === detailEpoch && error.name !== 'AbortError') setStatus(detailStatus, error.message, {error:true});}
  finally {if (thisEpoch === detailEpoch) detailRefresh.disabled = false;}
}
byId('generationHistoryClose').addEventListener('click', () => dialog.close());
dialog.addEventListener('close', () => {disposeDetail();selected = null;});
detailRefresh.addEventListener('click', () => {if (selected) openDetail(selected.kind, selected.id);});
function saveImage(image) {
  if (!image) return;
  const link = document.createElement('a');link.href = image.source;link.download = image.name;document.body.append(link);link.click();link.remove();
}
save.addEventListener('click', () => saveImage(selectedOutput));
inspect.addEventListener('click', () => {
  const image = selectedOutput;if (!image) return;
  resultInspector?.close();
  resultInspector = openGeneratedImageInspector(image, {title:'Inspect saved image', returnFocus:inspect, onSave:() => saveImage(image)});
});
filter.addEventListener('change', () => {renderList();if (relevantKinds().some(kind => !streams[kind].loaded)) loadPage();});
more.addEventListener('click', () => loadPage());refresh.addEventListener('click', () => loadPage(true));
byId('generationHistoryBack').addEventListener('click', () => {
  try {window.opener?.focus();} catch {}
  window.close();
  setTimeout(() => {
    byId('generationHistoryOpenEditor').hidden = false;
    setStatus(status, 'Switch to your existing editor tab to continue. You can also open an editor in a new tab below.');
  }, 150);
});
window.addEventListener('pagehide', () => {
  epoch++;listController.abort();intersection?.disconnect();disposeDetail();thumbnailQueue.length = 0;
  for (const url of thumbnailURLs.values()) URL.revokeObjectURL(url);thumbnailURLs.clear();
});
window.addEventListener('pageshow', event => {
  if (!event.persisted) return;
  // Back/forward cache restores this document after its preview URLs were freed.
  if (dialog.open) dialog.close();loading = false;loadPage(true);
});
loadPage();
