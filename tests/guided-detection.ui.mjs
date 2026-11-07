import {test, before, after, beforeEach, afterEach} from 'node:test';
import assert from 'node:assert/strict';
import {mkdir} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {inflateRawSync} from 'node:zlib';
import path from 'node:path';
import {chromium} from 'playwright';
import {createServer} from '../server.mjs';

let server, browser, context, page, base, errors, main, calls, available, responseHandler;
const qa = path.resolve('qa', 'guided-detection');
before(async () => {
  await mkdir(qa, {recursive: true}); server = createServer();
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${server.address().port}`; browser = await chromium.launch({headless: true});
});
after(async () => { await browser?.close(); if (server) await new Promise(resolve => server.close(resolve)); });
beforeEach(async () => {
  errors = []; calls = []; available = true; responseHandler = null;
  context = await browser.newContext({viewport: {width: 1672, height: 941}, acceptDownloads: true});
  await context.grantPermissions(['clipboard-read', 'clipboard-write'], {origin: base});
  page = await context.newPage(); page.on('pageerror', error => errors.push(error.message));
  page.on('request', request => {
    if (![base, 'data:', 'blob:'].some(prefix => request.url().startsWith(prefix))) errors.push('Unexpected remote request: ' + request.url());
  });
  await page.route('**/api/local-detection/status', route => route.fulfill({json: {
    available, token: 'qa-guided-token', model: 'sam2.1_hiera_small', device: 'cuda',
    message: available ? 'Local detection ready' : 'Local SAM2 is unavailable. Use the marked area manually.'
  }}));
  await page.route('**/api/local-detection', async route => {
    const body = route.request().postDataJSON(); calls.push({body, headers: route.request().headers()});
    if (responseHandler) return responseHandler(route, body);
    return route.fulfill({json: mockedResult(body)});
  });
  await page.goto(base); await page.waitForFunction(() => document.documentElement.dataset.ready === 'true');
  main = await fixture('Immutable MAIN.png', '#ffffff', 480, 320); await upload(main);
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
    if (inside === last) run++; else { counts.push(run); run = 1; last = inside; }
  }
  counts.push(run); return {width, height, counts};
}
function mockedResult(body) {
  const box = body.prompt?.box || [40, 50, 190, 170];
  const rect = margin => {
    const x = Math.max(0, Math.floor(box[0] - margin)), y = Math.max(0, Math.floor(box[1] - margin));
    return [x, y, Math.min(body.width, Math.ceil(box[2] + margin)) - x, Math.min(body.height, Math.ceil(box[3] + margin)) - y];
  };
  const rectangles = [rect(0), rect(8), rect(-2)];
  return {width: body.width, height: body.height, regions: rectangles.map((bbox, index) => ({
    id: 'guided-candidate-' + index, bbox, area: bbox[2] * bbox[3], predicted_iou: .99 - index * .03,
    segmentation: rectangleMask(body.width, body.height, bbox)
  })), model: 'Mock guided SAM2', device: 'cuda', elapsedMs: 100};
}
async function fixture(name, color, width = 240, height = 160) {
  const png = await page.evaluate(({color, width, height}) => {
    const canvas = document.createElement('canvas'); canvas.width = width; canvas.height = height;
    const ctx = canvas.getContext('2d'); ctx.fillStyle = color; ctx.fillRect(0, 0, width, height); return canvas.toDataURL('image/png');
  }, {color, width, height});
  const buffer = Buffer.concat([Buffer.from(png.split(',')[1], 'base64'), Buffer.from('\nOriginal metadata: ' + name)]);
  return {name, width, height, buffer, source: 'data:image/png;base64,' + buffer.toString('base64')};
}
const file = image => ({name: image.name, mimeType: 'image/png', buffer: image.buffer});
async function idle() { await page.waitForFunction(() => !document.body.classList.contains('busy')); }
async function upload(image) {
  await page.locator('#imageInput').setInputFiles(file(image)); await idle();
  await page.waitForFunction(() => document.querySelectorAll('.layer-row').length > 0);
}
async function control(id, value) {
  await page.locator('#' + id).evaluate((input, value) => {
    input.value = String(value); input.dispatchEvent(new Event('input', {bubbles: true})); input.dispatchEvent(new Event('change', {bubbles: true}));
  }, value);
}
async function point(x, y) {
  const rect = await page.locator('#board').boundingBox(), size = await page.locator('#canvas').evaluate(canvas => ({width: canvas.width, height: canvas.height}));
  return {x: rect.x + x * rect.width / size.width, y: rect.y + y * rect.height / size.height};
}
async function label(text, x = 20, y = 20) {
  await page.locator('#addText').click(); await control('textSize', 24); const p = await point(x, y);
  await page.mouse.click(p.x, p.y); await page.locator('#textEditor').fill(text); await page.locator('#textEditor').press('Enter');
  await page.locator('#textEditor').waitFor({state: 'hidden'});
}
async function mark(mode = 'pencil', points = [[80, 70], [200, 70], [200, 170], [80, 170], [80, 70]], size = 8) {
  await page.locator(`.toolrail [data-tool=${mode}]`).click(); await control('brushSize', size); await control('brushColor', '#00ff00');
  const first = await point(...points[0]); await page.mouse.move(first.x, first.y); await page.mouse.down();
  for (const pair of points.slice(1)) { const p = await point(...pair); await page.mouse.move(p.x, p.y, {steps: 6}); }
  await page.mouse.up(); await page.locator('#detectMarkedArea').waitFor({state: 'visible'});
}
async function guided({programmaticAuto = false} = {}) {
  if (programmaticAuto) await page.locator('#autoDetect').evaluate(button => button.click());
  else await page.locator('#detectMarkedArea').click();
  await page.locator('#guidedDetectionDialog').waitFor({state: 'visible'});
}
async function candidates() {
  await page.waitForFunction(() => document.querySelector('#guidedCandidateChoice').options.length >= 2 && !document.querySelector('#confirmGuidedDetection').disabled);
}
async function cancelGuided(action = 'cancel') {
  await page.evaluate(() => { window.__guidedClosed = new Promise(resolve => document.querySelector('#guidedDetectionDialog').addEventListener('close', resolve, {once: true})); });
  if (action === 'escape') await page.locator('#guidedCandidateChoice').press('Escape');
  else await page.locator(action === 'x' ? '#closeGuidedDetection' : '#cancelGuidedDetection').click();
  await page.evaluate(() => window.__guidedClosed); await page.locator('#guidedDetectionDialog').waitFor({state: 'hidden'});
}
async function confirmGuided() {
  await page.locator('#confirmGuidedDetection').click(); await page.locator('#guidedDetectionDialog').waitFor({state: 'hidden'});
  await page.locator('#referenceDialog').waitFor({state: 'visible'});
}
async function closeReferences(save = false) {
  await page.evaluate(() => { window.__refsClosed = new Promise(resolve => document.querySelector('#referenceDialog').addEventListener('close', resolve, {once: true})); });
  await page.locator(save ? '#saveReferenceLink' : '#cancelReferenceLink').click(); await page.evaluate(() => window.__refsClosed);
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
async function reopen(saved) {
  await page.locator('#projectInput').setInputFiles({name: saved.name, mimeType: 'application/json', buffer: saved.buffer}); await idle();
  await page.waitForFunction(count => document.querySelectorAll('.layer-row').length === count, saved.data.layers.length);
}
async function selectionInfo(data, coordinates) {
  return page.evaluate(async ({data, coordinates}) => {
    const module = await import('/object-regions.mjs'), label = data.layers.find(layer => layer.objectRegion);
    return {bounds: module.objectRegionBounds(data, label), area: module.regionMaskInfo(label.objectRegion.mask).area,
      contains: coordinates?.map(p => module.objectRegionContains(data, label, p)) || []};
  }, {data, coordinates});
}
async function imagePixels(bytes) {
  return page.evaluate(async bytes => {
    const image = await createImageBitmap(new Blob([new Uint8Array(bytes)], {type: 'image/png'})), canvas = document.createElement('canvas');
    canvas.width = image.width; canvas.height = image.height; const ctx = canvas.getContext('2d'); ctx.drawImage(image, 0, 0); image.close();
    const data = ctx.getImageData(0, 0, canvas.width, canvas.height).data; let colored = 0;
    for (let i = 0; i < data.length; i += 4) if (data[i] !== 255 || data[i + 1] !== 255 || data[i + 2] !== 255 || data[i + 3] !== 255) colored++;
    const hash = [...new Uint8Array(await crypto.subtle.digest('SHA-256', data))].map(x => x.toString(16).padStart(2, '0')).join('');
    return {width: canvas.width, height: canvas.height, colored, hash};
  }, bytes);
}
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
function zipEntries(zip) {
  let end = zip.length - 22; while (end >= Math.max(0, zip.length - 65557) && zip.readUInt32LE(end) !== 0x06054b50) end--;
  assert.ok(end >= 0); let cursor = zip.readUInt32LE(end + 16); const entries = new Map();
  for (let count = zip.readUInt16LE(end + 10); count > 0; count--) {
    assert.equal(zip.readUInt32LE(cursor), 0x02014b50);
    const method = zip.readUInt16LE(cursor + 10), size = zip.readUInt32LE(cursor + 20), nameLength = zip.readUInt16LE(cursor + 28);
    const extraLength = zip.readUInt16LE(cursor + 30), commentLength = zip.readUInt16LE(cursor + 32), offset = zip.readUInt32LE(cursor + 42);
    const name = zip.subarray(cursor + 46, cursor + 46 + nameLength).toString(), start = offset + 30 + zip.readUInt16LE(offset + 26) + zip.readUInt16LE(offset + 28);
    const payload = zip.subarray(start, start + size); assert.ok(method === 0 || method === 8);
    entries.set(name, method === 8 ? inflateRawSync(payload) : payload); cursor += 46 + nameLength + extraLength + commentLength;
  }
  return entries;
}

test('selected highlights send a clean prompted crop and require an explicit candidate confirmation before adding the next number', async () => {
  assert.equal(await page.locator('#detectMarkedArea').isVisible(), false);
  await label('1'); await mark('highlight', [[100, 100], [190, 100]], 30); const before = await save(), originalMark = before.data.layers.find(layer => layer.kind === 'drawing');
  assert.equal(await page.locator('#autoDetect').isVisible(), false, 'The compact toolbar substitutes the marked-area action');
  await guided(); await candidates(); await cancelGuided(); assert.deepEqual((await save()).data, before.data);
  await guided({programmaticAuto: true}); await candidates();
  assert.equal(await page.locator('.layer-row').count(), before.data.layers.length, 'A model response is only a preview');
  const request = calls.at(-1); assert.equal(request.headers['x-asun-detection-token'], 'qa-guided-token');
  assert.ok(request.body.prompt.box.length === 4); assert.ok(request.body.width < 480 && request.body.height < 320);
  assert.equal((await imagePixels([...Buffer.from(request.body.source.split(',')[1], 'base64')])).colored, 0, 'The local model receives clean source pixels without green marks or number 1');
  const preview = await page.locator('#guidedDetectionPreview').evaluate(canvas => canvas.toDataURL());
  await page.locator('#guidedCandidateChoice').selectOption('1');
  await page.waitForFunction(previous => document.querySelector('#guidedDetectionPreview').toDataURL() !== previous, preview);
  await confirmGuided(); await closeReferences(); const numbered = await save(), selected = numbered.data.layers.find(layer => layer.objectRegion);
  assert.equal(selected.text.content, '2'); assert.deepEqual(numbered.data.layers.find(layer => layer.id === originalMark.id), originalMark);
  assert.equal(numbered.data.assets[numbered.data.original.assetId].source, main.source);
  assert.deepEqual([selected.objectRegion.sourceWidth, selected.objectRegion.sourceHeight], [480, 320]);
  const info = await selectionInfo(numbered.data, [[145, 100], [20, 250]]); assert.deepEqual(info.contains, [true, false]);
  const b = request.body.prompt.box; assert.ok(info.area > (b[2] - b[0]) * (b[3] - b[1]), 'The chosen larger candidate, rather than the default preview, is saved');
  await page.locator('#undo').click(); assert.deepEqual((await save()).data, before.data, 'One undo removes the new number while preserving the editable mark');
  await page.locator('#redo').click(); assert.deepEqual((await save()).data, numbered.data);
});

test('unavailable, empty and invalid detection results preserve the mark and offer a cancellable manual closed-loop preview', async () => {
  available = false; await mark(); const before = await save(), originalMark = before.data.layers.find(layer => layer.kind === 'drawing');
  await guided(); await page.waitForFunction(() => /unavailable|manual|marked area/i.test(document.querySelector('#guidedDetectionError').textContent + document.querySelector('#guidedDetectionStatus').textContent) && !document.querySelector('#useMarkedArea').disabled);
  assert.equal(calls.length, 0); assert.equal(await page.locator('#useMarkedArea').isVisible(), true);
  await cancelGuided();
  available = true;
  for (const failure of ['empty', 'zero', 'invalid']) {
    responseHandler = (route, body) => route.fulfill({json: {
      width: body.width, height: body.height, regions: failure === 'empty' ? [] : [{
        id: failure, segmentation: {width: body.width, height: body.height, counts: failure === 'zero' ? [body.width * body.height] : [1, 2]}
      }], model: 'Invalid mock', device: 'cuda', elapsedMs: 10
    }});
    await guided();
    await page.waitForFunction(() => !document.querySelector('#useMarkedArea').disabled && document.querySelector('#guidedDetectionPreview').getAttribute('aria-busy') === 'false');
    assert.equal(await page.locator('#confirmGuidedDetection').isEnabled(), false, failure + ' cannot be numbered as a model selection');
    assert.match(await page.locator('#guidedDetectionDialog').innerText(), /no clear selection|manually|manual|marked area/i);
    await page.locator('#useMarkedArea').click();
    await page.waitForFunction(() => !document.querySelector('#confirmGuidedDetection').disabled && document.querySelector('#guidedDetectionPreview').dataset.selectionMode === 'manual');
    assert.equal(await page.locator('.layer-row').count(), before.data.layers.length);
    await cancelGuided(); assert.deepEqual((await save()).data, before.data, failure + ' and its manual preview can be discarded without a document change');
  }
  available = false; responseHandler = null; await guided();
  await page.waitForFunction(() => !document.querySelector('#useMarkedArea').disabled);
  await page.locator('#useMarkedArea').click(); await page.waitForFunction(() => !document.querySelector('#confirmGuidedDetection').disabled);
  assert.match(await page.locator('#guidedDetectionDialog').innerText(), /manual.*marked area|marked area.*manual/i);
  assert.equal(await page.locator('.layer-row').count(), before.data.layers.length, 'Manual preview also waits for Number this area');
  await confirmGuided(); await page.locator('#labelComment').fill('Keep the shape inside my pencil outline.'); await closeReferences(true);
  const saved = await save(); assert.deepEqual((await selectionInfo(saved.data, [[140, 120], [40, 40]])).contains, [true, false]);
  assert.equal(saved.data.layers.find(layer => layer.objectRegion).referenceComment, 'Keep the shape inside my pencil outline.');
  assert.deepEqual(saved.data.layers.find(layer => layer.id === originalMark.id), originalMark);
  await page.locator(`.layer-row[data-id="${originalMark.id}"]`).click(); await page.locator('#deleteLayer').click(); await page.locator('#undo').click();
  assert.deepEqual((await save()).data, saved.data, 'The guide stroke remains independently editable and undoable');
  assert.equal(calls.length, 3, 'Unavailable detection never posts; the three explicit invalid-result attempts are isolated');
});

test('Cancel, X and Escape discard successful guided previews and controls remain visible at compact and wide sizes', async () => {
  await mark(); const before = await save();
  const historyBefore = await page.evaluate(() => ({
    count: document.querySelector('#historyCount').textContent,
    entries: document.querySelector('#historyList').innerHTML,
    undoDisabled: document.querySelector('#undo').disabled,
    redoDisabled: document.querySelector('#redo').disabled
  }));
  assert.equal(historyBefore.undoDisabled, false, 'There is a real drawing edit that Ctrl+Z could otherwise remove');
  for (const action of ['cancel', 'x', 'escape']) {
    await guided(); await candidates();
    await page.locator('#confirmGuidedDetection').press('Control+z');
    assert.deepEqual(await page.evaluate(() => ({
      count: document.querySelector('#historyCount').textContent,
      entries: document.querySelector('#historyList').innerHTML,
      undoDisabled: document.querySelector('#undo').disabled,
      redoDisabled: document.querySelector('#redo').disabled
    })), historyBefore, 'Ctrl+Z focused on a preview button cannot undo the underlying editable mark');
    assert.equal(await page.locator('.layer-row').count(), before.data.layers.length);
    for (const viewport of [{width: 1280, height: 800}, {width: 1672, height: 941}]) {
      await page.setViewportSize(viewport);
      for (const id of ['guidedCandidateChoice', 'useMarkedArea', 'confirmGuidedDetection', 'cancelGuidedDetection']) {
        const info = await page.locator('#' + id).evaluate(element => {
          const r = element.getBoundingClientRect(), d = document.querySelector('#guidedDetectionDialog').getBoundingClientRect();
          return {left: r.left, top: r.top, right: r.right, bottom: r.bottom, dl: d.left, dt: d.top, dr: d.right, db: d.bottom, width: innerWidth, height: innerHeight,
            hit: element.contains(document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2))};
        });
        assert.ok(info.left >= info.dl && info.top >= info.dt && info.right <= Math.min(info.dr, info.width) && info.bottom <= Math.min(info.db, info.height) && info.hit, `${id} is usable at ${viewport.width}: ${JSON.stringify(info)}`);
      }
      if (action === 'cancel') await page.screenshot({path: path.join(qa, `guided-preview-${viewport.width}.png`)});
    }
    await cancelGuided(action); assert.deepEqual((await save()).data, before.data, action + ' changes neither the original nor the mark');
    assert.equal(await page.locator('#referenceDialog').isVisible(), false);
  }
});

test('manual selection during pending inference and cancelled late results cannot overwrite a preview or a newer document', async () => {
  await mark(); const before = await save();
  let release, signalStarted;
  const held = () => {
    const started = new Promise(resolve => signalStarted = resolve), gate = new Promise(resolve => release = resolve);
    responseHandler = async (route, body) => { signalStarted(); await gate; await route.fulfill({json: mockedResult(body)}).catch(() => {}); };
    return started;
  };
  let started = held(); await guided(); await started;
  await page.waitForFunction(() => !document.querySelector('#useMarkedArea').disabled);
  await page.locator('#useMarkedArea').click(); await page.waitForFunction(() => !document.querySelector('#confirmGuidedDetection').disabled);
  release(); await page.waitForTimeout(100);
  assert.match(await page.locator('#guidedDetectionDialog').innerText(), /manual.*marked area|marked area.*manual/i);
  await cancelGuided(); assert.deepEqual((await save()).data, before.data);
  started = held(); await guided(); await started; await cancelGuided();
  await page.locator('#newProject').click(); await page.locator('.desktop-create-blank').click(); await page.locator('#confirmDialog').click();
  const newer = await fixture('New document.png', '#0000ff', 320, 240); await upload(newer); const fresh = await save();
  release(); await page.waitForTimeout(150); await idle();
  assert.equal(await page.locator('#guidedDetectionDialog').isVisible(), false);
  assert.equal(await page.locator('#referenceDialog').isVisible(), false);
  assert.deepEqual((await save()).data, fresh.data, 'A response from the previous image never creates a number in the newer project');
  assert.equal(fresh.data.layers.some(layer => layer.objectRegion), false);
});

test('confirmed guided regions keep comments and photos editable through reopen and annotated board/pack exports preserve exact originals', async () => {
  await mark(); const marked = await save(), originalMark = marked.data.layers.find(layer => layer.kind === 'drawing');
  await guided(); await candidates(); await page.locator('#guidedCandidateChoice').selectOption('1'); await confirmGuided();
  const photo = await fixture('Blue reference.png', '#0000ff'); await page.locator('#labelComment').fill('Use this blue material and preserve the blockout camera.');
  await page.locator('#referenceFileInput').setInputFiles(file(photo));
  await page.waitForFunction(() => !document.body.classList.contains('busy') && document.querySelector('#referenceEditorHost').dataset.refReady === 'true');
  await page.locator('#referenceNotes').fill('Keep the blue tone.'); await closeReferences(true); const saved = await save(), object = saved.data.layers.find(layer => layer.objectRegion);
  assert.deepEqual(saved.data.layers.find(layer => layer.id === originalMark.id), originalMark);
  assert.equal(object.text.content, '1'); assert.equal(object.referenceIds.length, 1);
  assert.equal(saved.data.references[0].source, photo.source); assert.equal(saved.data.assets[saved.data.original.assetId].source, main.source);
  await reopen(saved); await page.locator('.toolrail [data-tool=move]').click(); const p = await point(140, 120); await page.mouse.click(p.x, p.y);
  await page.locator('#referenceDialog').waitFor({state: 'visible'}); assert.equal(await page.locator('#labelComment').inputValue(), object.referenceComment);
  assert.equal(await page.locator('#referenceGallery [data-reference-key]').count(), 1); await closeReferences();
  const pending = page.waitForEvent('download'); await page.locator('#completeReferencePackTop').click(); const pack = await downloaded(pending), entries = zipEntries(pack.buffer), mapping = JSON.parse(entries.get('mapping.json').toString());
  assert.deepEqual(entries.get(mapping.cleanMain.path), main.buffer); assert.equal(mapping.cleanMain.sha256, sha(main.buffer));
  assert.equal(mapping.numbers[0].comment, object.referenceComment); assert.deepEqual(entries.get(mapping.numbers[0].references[0].path), photo.buffer);
  const board = entries.get(mapping.generatedPreviews[0].path), expected = await imagePixels([...board]);
  await page.locator('#copyReferencesTop').click(); await page.waitForFunction(() => /copied/i.test(document.querySelector('#toast').textContent) && !document.querySelector('#copyReferencesTop').disabled);
  const copied = await page.evaluate(async () => { const item = (await navigator.clipboard.read()).find(item => item.types.includes('image/png')); return [...new Uint8Array(await (await item.getType('image/png')).arrayBuffer())]; });
  assert.deepEqual(await imagePixels(copied), expected);
  const sample = await page.evaluate(async ({bytes, project}) => {
    const {referenceBoardPages} = await import('/reference-board.mjs'), {objectRegionBounds} = await import('/object-regions.mjs');
    const layout = referenceBoardPages(project)[0], selected = project.layers.find(layer => layer.objectRegion), bounds = objectRegionBounds(project, selected);
    const image = await createImageBitmap(new Blob([new Uint8Array(bytes)], {type: 'image/png'})), canvas = document.createElement('canvas'); canvas.width = image.width; canvas.height = image.height;
    const ctx = canvas.getContext('2d'); ctx.drawImage(image, 0, 0); image.close();
    const pixel = (x, y) => [...ctx.getImageData(Math.floor(x), Math.floor(y), 1, 1).data];
    const tile = layout.tiles.find(tile => tile.group.reference);
    return {outline: pixel(layout.main.x + (bounds.x + bounds.width / 2) * layout.main.width / project.width, layout.main.y + bounds.y * layout.main.height / project.height),
      photo: pixel(tile.image.x + tile.image.width / 2, tile.image.y + tile.image.height / 2)};
  }, {bytes: copied, project: saved.data});
  assert.notDeepEqual(sample.outline, [255, 255, 255, 255], 'The exported scene includes the persistent guided outline');
  assert.deepEqual(sample.photo, [0, 0, 255, 255]); assert.deepEqual((await save()).data, saved.data);
  assert.equal(calls.length, 1, 'Reopening and exporting the saved selection needs no extra local inference');
});

test('guided crops map back to native source coordinates under raster transforms and remain aligned after a canvas crop', async () => {
  const initial = await save(), raster = initial.data.layers[0]; await page.locator(`.layer-row[data-id="${raster.id}"]`).click();
  await page.locator('#lockRatio').evaluate(input => input.checked = false);
  for (const [id, value] of Object.entries({layerX: 20, layerY: 15, layerW: 240, layerH: 160})) await control(id, value);
  await mark('pencil', [[70, 60], [170, 60], [170, 120], [70, 120], [70, 60]]); const marked = await save(), markId = marked.data.layers.find(layer => layer.kind === 'drawing').id;
  await guided(); await candidates(); const request = calls[0].body; await confirmGuided(); await closeReferences();
  const numbered = await save(), object = numbered.data.layers.find(layer => layer.objectRegion), before = await selectionInfo(numbered.data, [[120, 90], [300, 250]]);
  assert.deepEqual(before.contains, [true, false]); assert.equal(object.objectRegion.rasterLayerId, raster.id);
  assert.deepEqual([object.objectRegion.sourceWidth, object.objectRegion.sourceHeight], [480, 320]);
  assert.equal((await imagePixels([...Buffer.from(request.source.split(',')[1], 'base64')])).colored, 0);
  await page.locator('.toolrail [data-tool=crop]').click(); const a = await point(20, 15), b = await point(260, 175);
  await page.mouse.move(a.x, a.y); await page.mouse.down(); await page.mouse.move(b.x, b.y, {steps: 5}); await page.mouse.up(); await page.locator('#applyCrop').click();
  const cropped = await save(), after = await selectionInfo(cropped.data, [[100, 75], [220, 145]]);
  assert.deepEqual([cropped.data.width, cropped.data.height], [240, 160]); assert.deepEqual(after.contains, [true, false]);
  assert.equal(after.bounds.x, before.bounds.x - 20); assert.equal(after.bounds.y, before.bounds.y - 15);
  assert.equal(after.bounds.width, before.bounds.width); assert.equal(after.bounds.height, before.bounds.height);
  assert.equal(cropped.data.assets[cropped.data.original.assetId].source, main.source);
  await page.locator(`.layer-row[data-id="${markId}"]`).click(); await guided(); await candidates();
  assert.deepEqual(calls.at(-1).body.prompt, request.prompt); assert.equal(calls.at(-1).body.source, request.source, 'Uniform canvas cropping keeps the guide on the same original source pixels');
  await cancelGuided(); assert.deepEqual((await save()).data, cropped.data);
});
