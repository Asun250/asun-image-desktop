import {test, before, after, beforeEach, afterEach} from 'node:test';
import assert from 'node:assert/strict';
import {mkdir} from 'node:fs/promises';
import {inflateRawSync} from 'node:zlib';
import path from 'node:path';
import {chromium} from 'playwright';
import {createServer} from '../server.mjs';

let server, browser, context, page, base, errors, main, detectionCalls;
const qa = path.resolve('qa', 'edit-summary');
const cardSelector = '.edit-summary-card[data-layer-id]';
before(async () => {
  await mkdir(qa, {recursive: true}); server = createServer();
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${server.address().port}`; browser = await chromium.launch({headless: true});
});
after(async () => { await browser?.close(); if (server) await new Promise(resolve => server.close(resolve)); });
beforeEach(async () => {
  errors = []; detectionCalls = [];
  context = await browser.newContext({viewport: {width: 1672, height: 941}, acceptDownloads: true});
  await context.grantPermissions(['clipboard-read', 'clipboard-write'], {origin: base});
  page = await context.newPage(); page.on('pageerror', error => errors.push(error.message));
  page.on('request', request => {
    if (![base, 'data:', 'blob:'].some(prefix => request.url().startsWith(prefix))) errors.push('Unexpected remote request: ' + request.url());
  });
  await page.route('**/api/local-detection/status', route => route.fulfill({json: {available: true, token: 'qa-summary-token', model: 'Mock SAM2', device: 'cuda'}}));
  await page.route('**/api/local-detection', route => {
    const body = route.request().postDataJSON(); detectionCalls.push(body);
    return route.fulfill({json: {width: body.width, height: body.height, regions: [{
      id: 'summary-object', segmentation: rectangleMask(body.width, body.height, [40, 50, 150, 120])
    }], model: 'Mock SAM2', device: 'cuda', elapsedMs: 100}});
  });
  await page.goto(base); await page.waitForFunction(() => document.documentElement.dataset.ready === 'true');
  main = await fixture('Immutable MAIN.png', '#dddddd', 480, 320);
  await page.locator('#imageInput').setInputFiles(file(main)); await idle();
  await page.waitForFunction(() => document.querySelectorAll('.layer-row').length === 1);
});
afterEach(async info => {
  try {
    if (info.error) await page.screenshot({path: path.join(qa, 'failure-' + info.name.replace(/\W+/g, '-') + '.png')});
    assert.deepEqual(errors, []);
  } finally { await context?.close(); }
});

function rectangleMask(width, height, [x, y, w, h]) {
  const counts = []; let last = false, run = 0;
  for (let row = 0; row < height; row++) for (let col = 0; col < width; col++) {
    const inside = col >= x && col < x + w && row >= y && row < y + h;
    if (inside === last) run++; else {counts.push(run); run = 1; last = inside;}
  }
  counts.push(run); return {width, height, counts};
}
async function fixture(name, color, width = 240, height = 160) {
  const png = await page.evaluate(({color, width, height}) => {
    const canvas = document.createElement('canvas'); canvas.width = width; canvas.height = height;
    const ctx = canvas.getContext('2d'); ctx.fillStyle = color; ctx.fillRect(0, 0, width, height); return canvas.toDataURL('image/png');
  }, {color, width, height});
  const buffer = Buffer.concat([Buffer.from(png.split(',')[1], 'base64'), Buffer.from('\nUntouched metadata: ' + name)]);
  return {name, width, height, buffer, source: 'data:image/png;base64,' + buffer.toString('base64')};
}
const file = image => ({name: image.name, mimeType: 'image/png', buffer: image.buffer});
const card = id => page.locator(`${cardSelector}[data-layer-id="${id}"]`);
const labels = () => page.locator('#editSummaryList .edit-summary-label').allTextContents();
async function idle() { await page.waitForFunction(() => !document.body.classList.contains('busy')); }
async function control(id, value) {
  await page.locator('#' + id).evaluate((input, value) => {
    input.value = String(value); input.dispatchEvent(new Event('input', {bubbles: true})); input.dispatchEvent(new Event('change', {bubbles: true}));
  }, value);
}
async function point(x, y) {
  const r = await page.locator('#board').boundingBox(), size = await page.locator('#canvas').evaluate(c => ({width: c.width, height: c.height}));
  return {x: r.x + x * r.width / size.width, y: r.y + y * r.height / size.height};
}
async function label(text, x = 20, y = 20) {
  await page.locator('#addText').click(); await control('textSize', 24); const p = await point(x, y);
  await page.mouse.click(p.x, p.y); await page.locator('#textEditor').fill(text); await page.locator('#textEditor').press('Enter');
  await page.locator('#textEditor').waitFor({state: 'hidden'});
  return page.locator('.layer-row.selected').getAttribute('data-id');
}
async function openCard(id, keyboard = false) {
  if (keyboard) await card(id).press('Enter'); else await card(id).click();
  await page.locator('#referenceDialog').waitFor({state: 'visible'}); await idle();
}
async function closeRefs(save = false) {
  await page.evaluate(() => {window.__summaryRefsClosed = new Promise(resolve => document.querySelector('#referenceDialog').addEventListener('close', resolve, {once: true}));});
  await page.locator(save ? '#saveReferenceLink' : '#cancelReferenceLink').click(); await page.evaluate(() => window.__summaryRefsClosed);
}
async function addPhotos(photos) {
  await page.locator('#referenceFileInput').setInputFiles(photos.map(file));
  await page.waitForFunction(() => !document.body.classList.contains('busy') && document.querySelector('#referenceEditorHost').dataset.refReady === 'true');
}
async function refText(text, x = 20, y = 35) {
  await page.locator('#referenceDialog [data-ref-tool=text]').click();
  await page.locator('#refCanvas').evaluate(canvas => canvas.scrollIntoView({block: 'center', inline: 'nearest'}));
  const p = await page.locator('#refCanvas').evaluate((canvas, {x, y}) => {
    const r = canvas.getBoundingClientRect(); return {x: r.x + x * r.width / canvas.width, y: r.y + y * r.height / canvas.height};
  }, {x, y});
  await page.mouse.click(p.x, p.y); await page.locator('#refTextEditor').fill(text); await page.locator('#refTextEditor').press('Enter');
  await page.locator('#refTextEditor').waitFor({state: 'hidden'});
}
async function downloaded(pending) {
  const download = await pending, stream = await download.createReadStream(), chunks = [];
  for await (const chunk of stream) chunks.push(chunk);
  return {name: download.suggestedFilename(), buffer: Buffer.concat(chunks)};
}
async function save() {
  const pending = page.waitForEvent('download'); await page.locator('#saveProject').click(); const saved = await downloaded(pending);
  await page.waitForTimeout(725); return {...saved, data: JSON.parse(saved.buffer.toString())};
}
async function loadProject(data) {
  await page.locator('#projectInput').setInputFiles({name: 'Summary fixture.asun', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(data))});
  await idle(); await page.waitForFunction(count => document.querySelectorAll('.layer-row').length === count, data.layers.length);
}
async function reopen(saved) { await loadProject(saved.data); }
async function seed(specs, photos = [], {prompt = '', variant = false} = {}) {
  const initial = (await save()).data;
  const result = await page.evaluate(async ({initial, specs, photos, prompt, variant}) => {
    const core = await import('/core.mjs'); let project = initial; const ids = [];
    for (const photo of photos) {
      project = core.addReference(project, photo); const ref = project.references.at(-1);
      if (photo.notes) project = core.updateReferenceNotes(project, ref.id, photo.notes);
      if (photo.annotation) {
        const native = core.addText(core.referenceProject(ref), {content: photo.annotation, x: 20, y: 25, width: 80, height: 30, fontSize: 24, color: '#ff0000'}).project;
        project = core.updateReferenceAnnotations(project, ref.id, native.layers.filter(layer => layer.kind !== 'raster'));
      }
    }
    for (const [index, spec] of specs.entries()) {
      const added = core.addText(project, {content: spec.label, x: spec.x ?? 20 + index * 35, y: spec.y ?? 20, width: 35, height: 30, fontSize: 24});
      project = added.project; ids.push(added.layerId);
      if (spec.comment) project = core.updateLabelComment(project, added.layerId, spec.comment);
      if (spec.refs) project = core.linkReferences(project, added.layerId, spec.refs.map(index => project.references[index].id));
      if (spec.hidden || spec.opacity !== undefined) project = core.updateLayer(project, added.layerId, {visible: !spec.hidden, opacity: spec.opacity ?? 1});
      if (spec.region) project = core.attachObjectRegion(project, added.layerId, {
        version: 1, assetId: project.original.assetId, rasterLayerId: project.layers[0].id,
        sourceWidth: 480, sourceHeight: 320, mask: spec.region
      });
    }
    project = {...project, prompt}; if (variant) project = core.saveVariant(project, 'Summary snapshot');
    return {project, ids};
  }, {initial, specs, photos: photos.map(({buffer, ...photo}) => photo), prompt, variant});
  await loadProject(result.project); return result;
}
async function digest(bytes) {
  return page.evaluate(async bytes => {
    const bitmap = await createImageBitmap(new Blob([new Uint8Array(bytes)], {type: 'image/png'})), c = document.createElement('canvas');
    c.width = bitmap.width; c.height = bitmap.height; const ctx = c.getContext('2d'); ctx.drawImage(bitmap, 0, 0); bitmap.close();
    const hash = [...new Uint8Array(await crypto.subtle.digest('SHA-256', ctx.getImageData(0, 0, c.width, c.height).data))].map(x => x.toString(16).padStart(2, '0')).join('');
    return {width: c.width, height: c.height, hash};
  }, bytes);
}
async function clipboardPNG() {
  return page.evaluate(async () => {
    const item = (await navigator.clipboard.read()).find(item => item.types.includes('image/png'));
    return [...new Uint8Array(await (await item.getType('image/png')).arrayBuffer())];
  });
}
function zipEntries(zip) {
  let end = zip.length - 22; while (end >= Math.max(0, zip.length - 65557) && zip.readUInt32LE(end) !== 0x06054b50) end--;
  assert.ok(end >= 0); let cursor = zip.readUInt32LE(end + 16); const entries = new Map();
  for (let count = zip.readUInt16LE(end + 10); count > 0; count--) {
    assert.equal(zip.readUInt32LE(cursor), 0x02014b50);
    const method = zip.readUInt16LE(cursor + 10), size = zip.readUInt32LE(cursor + 20), length = zip.readUInt16LE(cursor + 28);
    const extra = zip.readUInt16LE(cursor + 30), comment = zip.readUInt16LE(cursor + 32), offset = zip.readUInt32LE(cursor + 42);
    const name = zip.subarray(cursor + 46, cursor + 46 + length).toString(), start = offset + 30 + zip.readUInt16LE(offset + 26) + zip.readUInt16LE(offset + 28);
    const bytes = zip.subarray(start, start + size); assert.ok(method === 0 || method === 8);
    entries.set(name, method === 8 ? inflateRawSync(bytes) : bytes); cursor += 46 + length + extra + comment;
  }
  return entries;
}

test('manual and detected numbers appear live in numeric order and each card opens its own existing comment editor', async () => {
  assert.equal(await page.locator(cardSelector).count(), 0);
  const ten = await label('10', 300, 20), two = await label('2', 220, 20); await label('Unrelated caption', 20, 250);
  assert.deepEqual(await labels(), ['2', '10']); assert.equal(await card(two).getAttribute('data-status'), 'pending');
  await page.locator('#autoDetect').click();
  await page.waitForFunction(() => document.querySelector('#detectionStatus').dataset.state === 'ready');
  const p = await point(100, 120); await page.mouse.click(p.x, p.y); await page.locator('#referenceDialog').waitFor({state: 'visible'}); await closeRefs();
  assert.deepEqual(await labels(), ['1', '2', '10']); assert.match(await page.locator('#editSummaryCount').innerText(), /3/);
  await page.waitForFunction(() => [...document.querySelectorAll('.edit-summary-source-preview img')].some(image => image.complete && image.naturalWidth > 0 && image.naturalWidth <= 160 && image.naturalHeight <= 112));
  await page.screenshot({path: path.join(qa, 'edit-summary-object-1672.png')});
  assert.equal(detectionCalls.length, 1);
  await openCard(two, true); await page.locator('#labelComment').fill('Material for object two'); await closeRefs(true);
  assert.equal(await card(two).locator('.edit-summary-comment').innerText(), 'Material for object two');
  assert.equal(await card(two).getAttribute('aria-pressed'), 'true');
  await openCard(ten); assert.equal(await page.locator('#labelComment').inputValue(), ''); await closeRefs();
  assert.equal(await card(ten).getAttribute('aria-pressed'), 'true');
  assert.equal(await card(two).getAttribute('aria-pressed'), 'false');
  await page.locator('#addText').click(); const q = await point(250, 220); await page.mouse.click(q.x, q.y); await page.locator('#textEditor').fill('7');
  assert.deepEqual(await labels(), ['1', '2', '10'], 'An unconfirmed textarea draft is not presented as a saved object');
  await page.locator('#textEditor').press('Enter'); assert.deepEqual(await labels(), ['1', '2', '7', '10']);
});

test('committed comments update the summary through cancellation, undo, rename, delete, variant restoration and project reopen', async () => {
  const id = await label('4'), baseline = await save(), comment = 'Preserve the silhouette.\nUse snow only on the upper side.';
  await openCard(id); await page.locator('#labelComment').fill(comment);
  assert.equal(await card(id).locator('.edit-summary-comment').count(), 0, 'A modal draft does not leak into the committed summary');
  await closeRefs(); assert.deepEqual((await save()).data, baseline.data);
  await openCard(id); await page.locator('#labelComment').fill(comment); await closeRefs(true);
  assert.equal(await card(id).locator('.edit-summary-comment').innerText(), comment);
  await page.locator('#undo').click(); assert.equal(await card(id).locator('.edit-summary-comment').count(), 0);
  await page.locator('#redo').click(); assert.equal(await card(id).locator('.edit-summary-comment').innerText(), comment);
  await page.locator('#editTextLayer').click(); await page.locator('#textEditor').fill('14'); await page.locator('#textEditor').press('Enter');
  assert.deepEqual(await labels(), ['14']); assert.equal(await card(id).locator('.edit-summary-comment').innerText(), comment);
  await page.locator('#variants').click(); await page.locator('#saveVariant').click(); await page.locator('#variantName').fill('Summary snapshot'); await page.locator('#confirmDialog').click();
  await page.locator('#dialog').waitFor({state: 'hidden'});
  await openCard(id); await page.locator('#labelComment').fill('Temporary replacement'); await closeRefs(true);
  await page.locator('#variants').click(); await page.locator('.variant-card').filter({hasText: 'Summary snapshot'}).getByRole('button', {name: 'Restore', exact: true}).click();
  await page.locator('#dialog').waitFor({state: 'hidden'}); assert.equal(await card(id).locator('.edit-summary-comment').innerText(), comment);
  const restored = await save(); await page.locator('#deleteLayer').click(); assert.equal(await page.locator(cardSelector).count(), 0);
  await page.locator('#undo').click(); assert.equal(await card(id).locator('.edit-summary-comment').innerText(), comment);
  await reopen(restored); assert.deepEqual(await labels(), ['14']); assert.equal(await card(id).locator('.edit-summary-comment').innerText(), comment);
  assert.equal(restored.data.assets[restored.data.original.assetId].source, main.source);
});

test('multiple and shared photos show full notes and editable annotation counts while summary text retains native copying and modal isolation', async () => {
  const one = await label('1'), red = await fixture('Red material.png', '#ff0000'), blue = await fixture('Blue material.png', '#0000ff');
  await openCard(one); await addPhotos([red, blue]);
  await page.locator('#referenceGallery [data-reference-key]').first().click();
  await page.waitForFunction(() => document.querySelector('#referenceEditorHost').dataset.refReady === 'true');
  const note = 'Preserve the red tone.\nKeep this complete second line.';
  await page.locator('#referenceNotes').fill(note); await refText('R'); await closeRefs(true);
  const saved = await save(), redId = saved.data.references.find(ref => ref.name === red.name).id;
  assert.equal(await card(one).locator('.edit-summary-reference').count(), 2);
  assert.equal(await card(one).locator(`[data-reference-id="${redId}"] .edit-summary-reference-note`).innerText(), note);
  assert.match(await card(one).locator(`[data-reference-id="${redId}"] .edit-summary-reference-annotations`).innerText(), /1/);
  await page.waitForFunction(() => [...document.querySelectorAll('.edit-summary-reference-preview img')].filter(image => image.complete && image.naturalWidth > 0).length === 2);
  await page.screenshot({path: path.join(qa, 'edit-summary-photos-1672.png')});
  await page.setViewportSize({width: 1280, height: 800}); await page.screenshot({path: path.join(qa, 'edit-summary-photos-1280.png')});
  await page.setViewportSize({width: 1672, height: 941});
  const two = await label('2', 250, 20); await openCard(two); await page.locator('#referenceChoice').selectOption(redId); await closeRefs(true);
  await openCard(two); await page.locator('#referenceNotes').fill('Shared photo revised.'); await closeRefs(true);
  for (const id of [one, two]) assert.equal(await card(id).locator(`[data-reference-id="${redId}"] .edit-summary-reference-note`).innerText(), 'Shared photo revised.');
  await card(two).focus(); await page.evaluate(({id, redId}) => {
    const node = document.querySelector(`.edit-summary-card[data-layer-id="${id}"] [data-reference-id="${redId}"] .edit-summary-reference-note`);
    const range = document.createRange(); range.selectNodeContents(node); const selection = getSelection(); selection.removeAllRanges(); selection.addRange(range);
  }, {id: two, redId});
  await page.keyboard.press('Control+c'); assert.equal(await page.evaluate(() => navigator.clipboard.readText()), 'Shared photo revised.');
  await page.evaluate(() => getSelection().removeAllRanges());
  await openCard(one); await page.locator('#labelComment').fill('Unsaved first object draft');
  await card(two).evaluate(element => element.click());
  assert.equal(await page.locator('#labelComment').inputValue(), 'Unsaved first object draft', 'An inactive background card cannot replace the open modal session');
  await closeRefs(); const current = await save();
  assert.equal(current.data.references.find(ref => ref.id === redId).annotations[0].text.content, 'R');
  for (const photo of [red, blue]) assert.equal(current.data.references.find(ref => ref.name === photo.name).source, photo.source);
});

test('excluded labels and conflicting numbers stay visible with export-consistent warnings including hidden source rasters', async () => {
  const red = await fixture('Red.png', '#ff0000'), blue = await fixture('Blue.png', '#0000ff');
  const result = await seed([
    {label: '1', comment: 'First instruction', refs: [0]}, {label: '1', comment: 'Conflicting instruction', refs: [1]},
    {label: '3', comment: 'Hidden instruction', hidden: true}, {label: '4', comment: 'Off canvas instruction', x: 600},
    {label: '5', opacity: 0}, {label: '6', comment: 'Visible region label', region: rectangleMask(480, 320, [40, 50, 150, 120])}
  ], [red, blue]);
  for (const id of result.ids.slice(0, 2)) assert.equal(await card(id).getAttribute('data-status'), 'conflict');
  for (const id of result.ids.slice(2, 5)) {
    assert.equal(await card(id).getAttribute('data-status'), 'excluded'); assert.equal(await card(id).getAttribute('data-board-included'), 'false');
  }
  assert.match(await card(result.ids[3]).locator('.edit-summary-status').innerText(), /outside|off.canvas|excluded/i);
  await page.locator(`.layer-row[data-id="${result.ids[1]}"] .visibility`).click();
  assert.notEqual(await card(result.ids[0]).getAttribute('data-status'), 'conflict', 'Hiding the duplicate removes the visible export conflict');
  await page.locator(`.layer-row[data-id="${result.project.layers[0].id}"] .visibility`).click();
  assert.equal(await card(result.ids[5]).getAttribute('data-board-included'), 'true', 'A visible label/comment is still included even when the source image is hidden');
  assert.match(await card(result.ids[5]).locator('.edit-summary-warning').innerText(), /source|image|hidden/i);
  await openCard(result.ids[2]); assert.equal(await page.locator('#labelComment').inputValue(), 'Hidden instruction'); await closeRefs();
});

test('the summary is a derived view and never enters scene/board PNGs or changes byte-exact originals in the complete pack', async () => {
  const blue = await fixture('Material.png', '#0000ff');
  const result = await seed([{label: '1', comment: 'Apply this material only to number one.', refs: [0]}], [blue], {prompt: 'Keep the composition and camera.'});
  assert.equal(await page.locator('#editSummaryPrompt').isVisible(), true);
  assert.equal(await page.locator('.edit-summary-global-prompt').innerText(), result.project.prompt);
  const baseline = await save();
  const source = await page.evaluate(async project => {
    const {exportImage} = await import('/render.mjs'); return [...new Uint8Array(await (await exportImage(project, 'png')).arrayBuffer())];
  }, baseline.data);
  await page.locator('#stage').focus();
  await page.evaluate(() => {
    const node = document.querySelector('.edit-summary-global-prompt'), range = document.createRange();
    range.selectNodeContents(node); const selection = getSelection(); selection.removeAllRanges(); selection.addRange(range);
  });
  assert.equal(await page.evaluate(() => document.activeElement.id), 'stage', 'The selected static summary text does not acquire keyboard focus');
  await page.keyboard.press('Control+c');
  assert.equal(await page.evaluate(() => navigator.clipboard.readText()), result.project.prompt, 'Selected summary prompt copies as native text while the stage remains focused');
  await page.evaluate(() => getSelection().removeAllRanges());
  await page.keyboard.press('Control+c'); await idle(); await page.waitForFunction(() => /copied/i.test(document.querySelector('#toast').textContent));
  assert.deepEqual(await digest(await clipboardPNG()), await digest(source), 'Clearing the native summary selection restores ordinary scene-image copying');
  await page.locator('#copyReferencesTop').click(); await page.waitForFunction(() => /copied/i.test(document.querySelector('#toast').textContent) && !document.querySelector('#copyReferencesTop').disabled);
  const visibleBoard = await digest(await clipboardPNG());
  await page.locator('#toggleEditSummary').click();
  await page.locator('#copyReferencesTop').click(); await page.waitForFunction(() => /copied/i.test(document.querySelector('#toast').textContent) && !document.querySelector('#copyReferencesTop').disabled);
  assert.deepEqual(await digest(await clipboardPNG()), visibleBoard, 'Showing the panel cannot add its text or layout to the numbered board');
  const pending = page.waitForEvent('download'); await page.locator('#completeReferencePackTop').click();
  const zip = zipEntries((await downloaded(pending)).buffer), mapping = JSON.parse(zip.get('mapping.json').toString());
  assert.deepEqual(zip.get(mapping.cleanMain.path), main.buffer); assert.deepEqual(zip.get(mapping.numbers[0].references[0].path), blue.buffer);
  assert.deepEqual(await digest([...zip.get(mapping.generatedPreviews[0].path)]), visibleBoard);
  assert.deepEqual((await save()).data, baseline.data, 'Collapse, copies and export do not mutate project data or original source payloads');
  await page.locator('#toggleEditSummary').click(); await reopen(baseline);
  assert.equal(await card(result.ids[0]).locator('.edit-summary-comment').innerText(), result.project.layers.at(-1).referenceComment);
});

test('responsive split layout, collapse and independent summary scrolling preserve the scene and stage wheel controls', async () => {
  const result = await seed(Array.from({length: 7}, (_, index) => ({label: String(index + 1), comment: `Object ${index + 1}\n` + 'Full instruction text remains readable. '.repeat(12)})), [], {prompt: 'Global instructions are also visible here.'});
  const baseline = await save();
  for (const viewport of [{width: 1280, height: 800}, {width: 1672, height: 941}, {width: 2048, height: 1152}]) {
    await page.setViewportSize(viewport); await page.locator('#fit').click();
    const bounds = await page.evaluate(() => {
      const rect = id => {const r = document.querySelector('#' + id).getBoundingClientRect(); return {x: r.x, y: r.y, width: r.width, height: r.height, right: r.right, bottom: r.bottom};};
      return {panel: rect('editSummaryPanel'), stage: rect('stage'), board: rect('board'), list: rect('editSummaryList'), toggle: rect('toggleEditSummary'), width: innerWidth, height: innerHeight};
    });
    assert.ok(bounds.panel.width >= 180 && bounds.stage.width >= 250 && bounds.panel.right <= bounds.stage.x + 1, JSON.stringify(bounds));
    assert.ok(bounds.stage.right <= viewport.width && bounds.stage.bottom <= viewport.height && bounds.list.height > 80);
    assert.ok(bounds.board.x >= bounds.stage.x && bounds.board.right <= bounds.stage.right && bounds.board.y >= bounds.stage.y && bounds.board.bottom <= bounds.stage.bottom, 'Fit respects the smaller stage beside the summary');
    await page.screenshot({path: path.join(qa, `edit-summary-${viewport.width}.png`)});
    await page.locator('#toggleEditSummary').click();
    const collapsed = await page.locator('#stage').boundingBox(); assert.ok(collapsed.width > bounds.stage.width + 100);
    await page.locator('#toggleEditSummary').click();
    await page.waitForFunction(width => Math.abs(document.querySelector('#stage').getBoundingClientRect().width - width) < 2, bounds.stage.width);
  }
  await page.locator('.toolrail [data-tool=move]').click();
  const view = await page.locator('#board').boundingBox(); await page.locator('#editSummaryContent').hover(); await page.mouse.wheel(0, 600);
  await page.waitForFunction(() => document.querySelector('#editSummaryContent').scrollTop > 0);
  assert.equal(await page.locator('.toolrail [data-tool].active').getAttribute('data-tool'), 'move'); assert.deepEqual(await page.locator('#board').boundingBox(), view);
  await card(result.ids[6]).focus(); await card(result.ids[6]).press('Delete'); await card(result.ids[6]).press('p');
  assert.equal(await page.locator('.toolrail [data-tool].active').getAttribute('data-tool'), 'move'); assert.equal(await page.locator(cardSelector).count(), 7);
  const p = await point(240, 160); await page.mouse.move(p.x, p.y); await page.keyboard.down('Control'); await page.mouse.wheel(0, 120); await page.keyboard.up('Control');
  await page.waitForFunction(width => document.querySelector('#board').getBoundingClientRect().width < width, view.width);
  assert.equal(await page.locator('.toolrail [data-tool].active').getAttribute('data-tool'), 'move');
  await page.locator('#fit').click(); assert.deepEqual((await save()).data, baseline.data);
});
