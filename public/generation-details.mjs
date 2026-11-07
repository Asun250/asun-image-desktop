// Recorded provider request details. No provider credentials enter this UI.
import {isLocalGenerationAuthResponse} from './local-generation-auth.mjs';
import {checkImageOutputSize,imageAspectRatio} from './image-output-settings.mjs';
import {generationComplexityOptions} from './generation-settings.mjs';
const active = new WeakMap();
const text = value => value === undefined || value === null || value === '' ? 'Not recorded' : String(value);
export function generationDate(value) {
  if (!value) return 'Not recorded';
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? 'Not recorded' : date.toLocaleString(undefined, {dateStyle:'medium', timeStyle:'short'});
}
export function generationDimensions(value) {
  return Number.isFinite(value?.width) && Number.isFinite(value?.height) ? `${value.width} × ${value.height} px (${imageAspectRatio(value.width,value.height)})` : 'Not recorded';
}
/** Only describe recorded packing; legacy and ordinary requests stay unchanged. */
export function generationInputPackingDisplay(packing) {
  if (packing?.version !== 1 || !Number.isSafeInteger(packing.logicalInputCount) || !Number.isSafeInteger(packing.physicalInputCount) || !Number.isSafeInteger(packing.boardCount)
    || packing.physicalInputCount < 1 || packing.physicalInputCount > 16 || packing.logicalInputCount <= packing.physicalInputCount || packing.boardCount < 1 || packing.boardCount > packing.physicalInputCount) return null;
  return {
    summary:`All ${packing.logicalInputCount} inputs included in ${packing.physicalInputCount} images using ${packing.boardCount} labeled reference board${packing.boardCount === 1 ? '' : 's'}.`,
    detail:'Photos and guides in boards may appear smaller to the model. The original reference photos remain in the saved editable project. The boards below show what was sent.',
  };
}
function element(tag, className, content) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (content !== undefined) node.textContent = content;
  return node;
}
/** Approval is explicit; a saved candidate by itself is never an approval. */
export function blockoutReviewDisplay(record = {}) {
  const review = record.review;
  if (!review?.enabled) return null;
  const pixels=record.output||record.image,outputCheck=pixels?checkImageOutputSize(record.settings?.size,pixels):record.outputCheck;
  const accepted = review.status === 'accepted' && record.status === 'completed' && outputCheck?.matches!==false;
  const pending = record.status === 'queued' || record.status === 'running';
  const label = accepted ? 'Visual match passed' : pending
    ? record.phase === 'reviewing' || review.status === 'reviewing' ? 'Reviewing blockout match' : record.status === 'queued' ? 'Blockout review queued' : 'Generating for review'
    : 'Needs review — not approved';
  return {accepted, pending, label, review};
}
function appendBlockoutReview(wrapper, record) {
  const display = blockoutReviewDisplay(record);if (!display) return;
  if (!document.querySelector('link[data-blockout-review-results-style]')) {
    const link = document.createElement('link');link.rel = 'stylesheet';link.href = new URL('./blockout-review-results.css', import.meta.url).href;link.dataset.blockoutReviewResultsStyle = '';document.head.append(link);
  }
  const {review, accepted, pending, label} = display;
  const section = element('section', 'blockout-review-result');section.dataset.reviewState = accepted ? 'accepted' : pending ? 'pending' : 'needs-review';section.setAttribute('aria-label', 'Independent blockout review');
  section.append(element('h4', '', label));
  const attemptCount = Number.isInteger(record.attempt) ? record.attempt : Array.isArray(record.attempts) ? record.attempts.length : 0;
  section.append(element('p', 'blockout-review-meta', `Reviewer: ${text(review.model)} · Reasoning: ${text(review.effort)} · Attempts: ${attemptCount} of ${text(review.maxAttempts)}`));
  if (review.summary) section.append(element('p', '', review.summary));
  section.append(element('p', 'blockout-review-limit', 'This checks the visible camera, framing, placement and proportions against the chosen blockout. It does not certify exact 3D dimensions or camera settings.'));
  const source = record.settings?.review?.source;
  const sourceInput = record.settings?.inputs?.find(input => input.sha256 === (review.sourceSha256 || source?.sha256));
  const sourceDetails = element('details', 'blockout-review-source');sourceDetails.append(element('summary', '', 'Original blockout used for every attempt'));
  sourceDetails.append(element('p', '', `${text(source?.name || sourceInput?.name || record.settings?.review?.sourceName || review.assetId)} · ${generationDimensions(source)}`));
  sourceDetails.append(element('p', 'blockout-review-hash', `Source SHA-256: ${text(review.sourceSha256 || source?.sha256)}`));
  if (review.candidateSha256) sourceDetails.append(element('p', 'blockout-review-hash', `Latest candidate SHA-256: ${review.candidateSha256}`));
  if (record.settings?.review?.authorizedChanges) sourceDetails.append(element('p', '', `Allowed changes: ${record.settings.review.authorizedChanges}`));
  section.append(sourceDetails);
  for (const attempt of Array.isArray(record.attempts) ? record.attempts : []) {
    const reviewResult = attempt.review, verdict = reviewResult?.verdict;
    const attemptCheck=attempt.candidate?checkImageOutputSize(attempt.settings?.size,attempt.candidate):null;
    const attemptLabel = attemptCheck?.matches===false?'Output size mismatch':attempt.status === 'accepted' ? 'Visual match passed' : attempt.status === 'rejected' ? 'Rejected' : attempt.status === 'inconclusive' ? 'Inconclusive' : attempt.status === 'failed' ? 'Needs review' : 'In progress';
    const details = element('details', 'blockout-review-attempt');details.dataset.attempt = String(attempt.number);
    details.append(element('summary', '', `Attempt ${text(attempt.number)} · ${attemptLabel}`));
    if (verdict?.summary) details.append(element('p', 'blockout-review-summary', verdict.summary));
    if (attempt.error) details.append(element('p', 'blockout-review-summary', attempt.error));
    if (Array.isArray(verdict?.checks)) {
      const checks = element('ul', 'blockout-review-checks');
      for (const check of verdict.checks) {
        const item = element('li');item.dataset.checkStatus = text(check.status);
        item.append(element('strong', '', `${text(check.id)} · ${text(check.status).replaceAll('_', ' ')}`));
        if (check.evidence) item.append(element('p', '', check.evidence));
        if (check.correction) item.append(element('p', '', `Correction: ${check.correction}`));checks.append(item);
      }
      details.append(checks);
    }
    if (Array.isArray(verdict?.corrections) && verdict.corrections.length) {
      details.append(element('h4', '', 'Corrections for the next attempt'));
      const corrections = element('ol', 'blockout-review-corrections');
      for (const correction of verdict.corrections) corrections.append(element('li', '', correction.instruction));details.append(corrections);
    }
    for (const limitation of Array.isArray(verdict?.limitations) ? verdict.limitations : []) details.append(element('p', 'blockout-review-limit', limitation));
    if (attempt.settings?.prompt) {
      const exact = element('details');exact.append(element('summary', '', 'Exact generation prompt and settings for this attempt'), element('pre', '', JSON.stringify(attempt.settings, null, 2)));details.append(exact);
    }
    if (attempt.returned && Object.keys(attempt.returned).length) {
      const returned = element('details');returned.append(element('summary', '', 'Settings returned by the image provider for this attempt'), element('pre', '', JSON.stringify(attempt.returned, null, 2)));details.append(returned);
    }
    if (reviewResult) {
      const audit = element('details');audit.append(element('summary', '', 'Recorded reviewer request and verdict'), element('pre', '', JSON.stringify(reviewResult, null, 2)));details.append(audit);
    } else if (attempt.reviewRequest) {
      const audit = element('details');audit.append(element('summary', '', 'Recorded reviewer request (review did not complete)'), element('pre', '', JSON.stringify({model:attempt.reviewModel,effort:attempt.reviewEffort,request:attempt.reviewRequest}, null, 2)));details.append(audit);
    }
    if (attempt.candidate?.sha256) details.append(element('p', 'blockout-review-hash', `Candidate: ${generationDimensions(attempt.candidate)} · SHA-256: ${attempt.candidate.sha256}`));
    section.append(details);
  }
  wrapper.append(section);
}
export async function generationJSON(fetchImpl, url, options = {}) {
  const response = await fetchImpl(url, {cache:'no-store', ...options});
  let data;
  try {data = await response.json();} catch {throw new Error('The local generation service did not respond. Restart Asun IMG to load its update.');}
  if (!response.ok) throw Object.assign(new Error(data.error || data.message || 'Generation history could not be read.'), {status:response.status,code:data.code});
  return data;
}
export function generationAPI(kind) {
  return kind === 'sheet' ? {endpoint:'/api/sheets', tokenHeader:'x-asun-sheet-token'} : {endpoint:'/api/images', tokenHeader:'x-asun-image-token'};
}

/** Synchronous mount; `.ready` covers protected preview loading. Safe for old jobs. */
export function renderGenerationDetails(container, record = {}, {kind = record?.mode || 'image', fetchImpl = globalThis.fetch, token = null} = {}) {
  active.get(container)?.dispose();
  record ||= {};
  const controller = new AbortController(), urls = new Set(), api = generationAPI(kind), settings = record.settings || null;
  let disposed = false, observer, wasShown = false, currentToken = token, authorization = null;
  async function authorizePreview(rejectedToken) {
    if (currentToken && currentToken !== rejectedToken) return currentToken;
    if (!authorization) authorization = (async () => {
      const status = await generationJSON(fetchImpl, api.endpoint + '/status', {signal:controller.signal});
      if (!status.token) throw new Error('The local connection is unavailable. Try opening this result again.');
      currentToken = status.token;
      return currentToken;
    })().finally(() => {authorization = null;});
    return authorization;
  }
  const wrapper = element('section', 'generation-details');
  const heading = element('h3', 'generation-details-heading', 'Generation details');
  wrapper.append(heading);
  const legacy = record.legacy === true || !settings;
  if (legacy) wrapper.append(element('p', 'generation-detail-legacy', 'This older result has no saved request settings. Its prompt, quality and input photos are not recorded.'));
  const metadata = element('dl', 'generation-detail-metadata');
  const output = record.output || record.image;
  const rows = [
    ['Type', kind === 'sheet' ? 'Character / item sheet' : 'Image'],
    ['Status', text(record.status)], ['Model', text(settings?.model || record.model)],
    ['Quality requested', text(settings?.quality)],
    ['Complexity requested', settings?.complexity!==undefined?text(settings.complexity):generationComplexityOptions(settings?.model||record.model).length?'Not recorded':'Not sent · unavailable for this model'],
    ['Size requested', text(settings?.size)],
    ['Actual image', generationDimensions(output)], ['Created', generationDate(record.createdAt)],
    ['Finished', generationDate(record.finishedAt)],
  ];
  for (const [name, value] of rows) {const row = element('div');row.append(element('dt', '', name), element('dd', '', value));metadata.append(row);}
  wrapper.append(metadata);
  const outputCheck=output?checkImageOutputSize(settings?.size,output):null;
  if(outputCheck){const notice=element('p','generation-detail-message',outputCheck.message);notice.dataset.outputSizeCheck=outputCheck.matches?'matched':'mismatch';if(!outputCheck.matches)notice.setAttribute('role','alert');wrapper.append(notice);}
  if(settings?.outputFraming){const framing=settings.outputFraming;wrapper.append(element('p','generation-detail-message',`Requested aspect ratio: ${framing.ratio} · ${framing.source==='edit-canvas'?'Keep edit canvas':framing.aspect==='source'?'Match source':'Chosen ratio'} · ${framing.sourceName} (${framing.sourceWidth} × ${framing.sourceHeight}).`));}
  appendBlockoutReview(wrapper, record);
  if (record.message && record.status !== 'completed') wrapper.append(element('p', 'generation-detail-message', record.message));
  const promptLabel = record.review?.enabled ? 'Original generation prompt' : 'Exact prompt sent';
  const promptHeading = element('div', 'generation-detail-section-heading');promptHeading.append(element('h4', '', promptLabel));
  const prompt = element('textarea', 'generation-detail-prompt');prompt.readOnly = true;prompt.spellcheck = false;prompt.setAttribute('aria-label', promptLabel);
  prompt.value = typeof settings?.prompt === 'string' ? settings.prompt : 'Not recorded';
  const copy = element('button', 'generation-detail-button', 'Copy prompt');copy.type = 'button';copy.disabled = typeof settings?.prompt !== 'string';
  copy.addEventListener('click', async () => {
    try {await navigator.clipboard.writeText(settings.prompt);if (!disposed) copy.textContent = 'Copied';}
    catch {prompt.focus();prompt.select();copy.textContent = 'Selected — press Ctrl+C';}
  });
  promptHeading.append(copy);wrapper.append(promptHeading, prompt);
  const inputsHeading = element('div', 'generation-detail-section-heading');inputsHeading.append(element('h4', '', 'Input photos and guides'));
  const inputs = Array.isArray(settings?.inputs) ? settings.inputs : null;
  if (inputs) inputsHeading.append(element('span', 'generation-detail-count', `${inputs.length} ${inputs.length === 1 ? 'image' : 'images'}`));
  wrapper.append(inputsHeading);
  const packing = generationInputPackingDisplay(settings?.inputPacking);
  if (packing) {
    const notice = element('div', 'generation-detail-message');notice.dataset.inputPacking = '';
    notice.append(element('strong', '', packing.summary), element('p', '', packing.detail));wrapper.append(notice);
  }
  const gallery = element('div', 'generation-detail-inputs');wrapper.append(gallery);
  if (!inputs) gallery.append(element('p', 'generation-detail-empty', 'Not recorded for this result.'));
  else if (!inputs.length) gallery.append(element('p', 'generation-detail-empty', 'No input images were sent. This request used a text prompt.'));
  const pending = [];
  for (const input of inputs || []) {
    const card = element('article', 'generation-detail-input');card.dataset.inputIndex = text(input.index);
    const figure = element('div', 'generation-input-frame');
    const state = element('p', 'generation-input-state', 'Loading saved input…');state.setAttribute('role', 'status');figure.append(state);
    card.append(figure, element('strong', 'generation-input-name', text(input.name)), element('p', 'generation-input-role', text(input.role)), element('small', 'generation-input-dimensions', generationDimensions(input)));
    const tiles = (Array.isArray(input.roles) ? input.roles : []).filter(role => role.role === 'labeled reference board' && Array.isArray(role.tiles)).flatMap(role => role.tiles);
    if (tiles.length) {
      const contents = element('details', 'generation-input-mapping');contents.dataset.boardContents = '';
      contents.append(element('summary', '', `${tiles.length} labeled inputs in this board`));
      const descriptions = tiles.map(tile => {
        const names = (Array.isArray(tile.roles) ? tile.roles : []).map(role => role.filename || role.name || role.role).filter(Boolean);
        return `${text(tile.label)} — ${names.length ? [...new Set(names)].join('; ') : 'Input ' + text(tile.sourceInput)}`;
      });
      contents.append(element('pre', '', descriptions.join('\n')));card.append(contents);
    }
    if (Array.isArray(input.roles) && input.roles.length) {
      const mapped = element('details', 'generation-input-mapping');mapped.append(element('summary', '', 'Recorded image roles'), element('pre', '', JSON.stringify(input.roles, null, 2)));card.append(mapped);
    }
    gallery.append(card);
    const available = !Array.isArray(record.availableInputs) || record.availableInputs.includes(input.index);
    if (!available) {state.textContent = 'This input is no longer stored.';card.dataset.unavailable = 'true';continue;}
    if (!Number.isInteger(input.index) || input.index < 1 || !record.id) {state.textContent = 'Input preview unavailable.';continue;}
    pending.push(async () => {
      try {
        const inputURL = `${api.endpoint}/jobs/${encodeURIComponent(record.id)}/input/${input.index}`;
        const auth = await authorizePreview();
        let response = await fetchImpl(inputURL, {cache:'no-store', signal:controller.signal, headers:{[api.tokenHeader]:auth}});
        if (await isLocalGenerationAuthResponse(response)) {
          const renewed = await authorizePreview(auth);
          response = await fetchImpl(inputURL, {cache:'no-store', signal:controller.signal, headers:{[api.tokenHeader]:renewed}});
        }
        if (!response.ok) throw new Error(response.status === 404 || response.status === 410 ? 'This input is no longer stored.' : 'The saved input could not be loaded.');
        const blob = await response.blob();
        if (!/^image\/(png|jpeg|webp)(?:;|$)/i.test(blob.type) || !blob.size || blob.size > 50 * 1024 * 1024) throw new Error('The saved input is not a supported image.');
        if (disposed) return;
        const url = URL.createObjectURL(blob);urls.add(url);
        const image = element('img', 'generation-input-preview');image.src = url;image.alt = `${text(input.role)}: ${text(input.name)}`;image.loading = 'lazy';
        const open = element('a', 'generation-input-open', 'Open input image ↗');open.href = url;open.target = '_blank';open.rel = 'noopener';
        image.addEventListener('error', () => {if (!disposed) {figure.replaceChildren(element('p', 'generation-input-state', 'This saved image could not be displayed.'));open.remove();}}, {once:true});
        figure.replaceChildren(image);card.append(open);
      } catch (error) {if (!disposed && error.name !== 'AbortError') state.textContent = error.message;}
    });
  }
  if (settings) {
    const raw = element('details', 'generation-recorded-settings');raw.append(element('summary', '', 'All recorded request settings'), element('pre', '', JSON.stringify(settings, null, 2)));wrapper.append(raw);
  }
  if (record.returned && Object.keys(record.returned).length) {
    const returned = element('details', 'generation-returned-settings');returned.append(element('summary', '', 'Settings returned by the provider'), element('pre', '', JSON.stringify(record.returned, null, 2)));wrapper.append(returned);
  }
  container.replaceChildren(wrapper);
  const ready = (async () => {
    if (!pending.length) return;
    try {
      await authorizePreview();
      let next = 0;
      await Promise.all(Array.from({length:Math.min(3, pending.length)}, async () => {while (!disposed && next < pending.length) await pending[next++]();}));
    } catch (error) {
      if (!disposed && error.name !== 'AbortError') for (const state of wrapper.querySelectorAll('.generation-input-state')) state.textContent = error.message;
    }
  })();
  function dispose() {
    if (disposed) return;disposed = true;controller.abort();observer?.disconnect();
    for (const url of urls) URL.revokeObjectURL(url);urls.clear();
    if (active.get(container)?.dispose === dispose) active.delete(container);
  }
  const mounted = {dispose, ready};active.set(container, mounted);
  // Dialog and sheet hosts may be hidden instead of removed; release full-size
  // input blobs when the result is closed, even if a caller forgets disposal.
  const checkVisible = () => {
    if (!container.isConnected) {dispose();return;}
    const dialog = container.closest('dialog'), hidden = Boolean(container.closest('[hidden]')) || Boolean(dialog && !dialog.open);
    if (!hidden) wasShown = true;
    else if (wasShown) dispose();
  };
  observer = new MutationObserver(checkVisible);
  if (document.body) observer.observe(document.body, {subtree:true, childList:true, attributes:true, attributeFilter:['hidden','open']});
  queueMicrotask(checkVisible);
  return mounted;
}
