import {test, before, after, beforeEach, afterEach} from 'node:test';
import assert from 'node:assert/strict';
import {mkdir, readFile, writeFile} from 'node:fs/promises';
import {inflateRawSync} from 'node:zlib';
import path from 'node:path';
import {chromium} from 'playwright';
import {createServer} from '../server.mjs';

let server, browser, context, page, base, errors, detectionHandler, detectionCalls;
const qa = path.resolve('qa', 'project-reset');
before(async () => {
  await mkdir(qa, {recursive: true}); server = createServer();
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${server.address().port}`; browser = await chromium.launch({headless: true});
});
after(async () => {await browser?.close(); if (server) await new Promise(resolve => server.close(resolve));});
beforeEach(async () => {
  errors = []; detectionCalls = []; detectionHandler = null;
  context = await browser.newContext({viewport: {width: 1672, height: 941}, acceptDownloads: true});
  await context.grantPermissions(['clipboard-read', 'clipboard-write'], {origin: base});
  page = await context.newPage(); page.on('pageerror', error => errors.push(error.message));
  page.on('request', request => {if (![base, 'data:', 'blob:'].some(prefix => request.url().startsWith(prefix))) errors.push('Unexpected remote request: ' + request.url());});
  await page.route('**/api/local-detection/status', route => route.fulfill({json: {available: true, token: 'qa-reset-token', model: 'Mock local SAM2', device: 'cuda'}}));
  await page.route('**/api/local-detection', route => {
    const body = route.request().postDataJSON(); detectionCalls.push(body);
    if (detectionHandler) return detectionHandler(route, body);
    return route.fulfill({json: detected(body)});
  });
  await page.goto(base); await page.waitForFunction(() => document.documentElement.dataset.ready === 'true');
});
afterEach(async info => {
  try {
    if (info.error) await page.screenshot({path: path.join(qa, 'failure-' + info.name.replace(/\W+/g, '-') + '.png')});
    assert.deepEqual(errors, []);
  } finally {await context?.close();}
});

async function fixture(name, width = 480, height = 320, color = '#dddddd') {
  const png = await page.evaluate(({width, height, color}) => {
    const c = document.createElement('canvas'); c.width = width; c.height = height;
    const ctx = c.getContext('2d'); ctx.fillStyle = color; ctx.fillRect(0, 0, width, height); return c.toDataURL('image/png');
  }, {width, height, color});
  const buffer = Buffer.concat([Buffer.from(png.split(',')[1], 'base64'), Buffer.from('\nNever overwrite original: ' + name)]);
  return {name, width, height, color, buffer, source: 'data:image/png;base64,' + buffer.toString('base64')};
}
const file = image => ({name: image.name, mimeType: 'image/png', buffer: image.buffer});
async function idle() {await page.waitForFunction(() => !document.body.classList.contains('busy'));}
async function upload(image) {
  const count = await page.locator('.layer-row').count(); await page.locator('#imageInput').setInputFiles(file(image)); await idle();
  await page.waitForFunction(count => document.querySelectorAll('.layer-row').length === count, count + 1);
}
async function control(id, value) {
  await page.locator('#' + id).evaluate((element, value) => {
    element.value = String(value); element.dispatchEvent(new Event('input', {bubbles: true})); element.dispatchEvent(new Event('change', {bubbles: true}));
  }, value);
}
async function point(x, y) {
  const r = await page.locator('#board').boundingBox(), dimensions = await page.locator('#canvas').evaluate(c => ({width: c.width, height: c.height}));
  return {x: r.x + x * r.width / dimensions.width, y: r.y + y * r.height / dimensions.height};
}
async function text(content, {x = 20, y = 20, pending = false} = {}) {
  await page.locator('#addText').click(); await control('textSize', 24); const p = await point(x, y); await page.mouse.click(p.x, p.y);
  await page.locator('#textEditor').fill(content);
  if (!pending) {await page.locator('#textEditor').press('Enter'); await page.locator('#textEditor').waitFor({state: 'hidden'});}
}
async function downloaded(pending) {
  const item = await pending, stream = await item.createReadStream(), chunks = [];
  for await (const chunk of stream) chunks.push(chunk);
  return {name: item.suggestedFilename(), buffer: Buffer.concat(chunks)};
}
async function save() {
  const pending = page.waitForEvent('download'); await page.locator('#saveProject').click(); const saved = await downloaded(pending);
  await page.waitForTimeout(725); return {...saved, data: JSON.parse(saved.buffer.toString())};
}
async function load(data) {
  await page.locator('#projectInput').setInputFiles({name: 'Reset fixture.asun', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(data))});
  await idle(); await page.waitForFunction(count => document.querySelectorAll('.layer-row').length === count, data.layers.length);
}
async function reset() {
  await page.locator('#deleteAllLayers').click();
  await page.waitForFunction(() => document.querySelectorAll('.layer-row').length === 0 && document.querySelector('#prompt').value === '');
}
async function assertBlank(data) {
  const blank = await page.evaluate(async () => (await import('/core.mjs')).newProject());
  assert.deepEqual(data, blank); assert.equal(await page.locator('#deleteAllLayers').isVisible(), true); assert.equal(await page.locator('#deleteAllLayers').isDisabled(), true);
  assert.equal(await page.locator('.toolrail [data-tool].active').getAttribute('data-tool'), 'move');
  assert.equal(await page.locator('#compare').getAttribute('aria-pressed'), 'false'); assert.equal(await page.locator('#cropBox').isVisible(), false);
  assert.equal(await page.locator('#imageMenu').isVisible(), false); assert.equal(await page.locator('#textEditor').isVisible(), false);
  assert.equal(await page.locator('.edit-summary-card').count(), 0); assert.equal(await page.locator('#variantCount').innerText(), '0');
  assert.deepEqual(await page.locator('#canvas').evaluate(c => {
    const data = c.getContext('2d').getImageData(0, 0, c.width, c.height).data; let visiblePixels = 0;
    for (let index = 3; index < data.length; index += 4) if (data[index]) visiblePixels++;
    return [c.width, c.height, visiblePixels];
  }), [1600, 1000, 0], 'The entire fresh composite is transparent without stale saved annotation pixels');
}
function rectangleMask(width, height, [x, y, w, h]) {
  const counts = []; let previous = false, run = 0;
  for (let row = 0; row < height; row++) for (let column = 0; column < width; column++) {
    const inside = column >= x && column < x + w && row >= y && row < y + h;
    if (inside === previous) run++; else {counts.push(run); previous = inside; run = 1;}
  }
  counts.push(run); return {width, height, counts};
}
const detected = body => ({width: body.width, height: body.height, regions: [{id: 'old-object', segmentation: rectangleMask(body.width, body.height, [40, 50, 150, 120])}], model: 'Mock local SAM2', device: 'cuda', elapsedMs: 100});
async function richProject() {
  const main = await fixture('Retained MAIN.png'), reference = await fixture('Retained reference.png', 240, 160, '#0000ff');
  await upload(main); const initial = (await save()).data;
  const data = await page.evaluate(async ({initial, reference, mask}) => {
    const core = await import('/core.mjs'); let p = initial;
    p = core.addDrawing(p, {mode: 'pencil', size: 8, color: '#ff0000', points: [[50, 200], [300, 200]]}).project;
    const added = core.addText(p, {content: '1', x: 80, y: 90, width: 30, height: 36, fontSize: 24}); p = added.project;
    p = core.attachObjectRegion(p, added.layerId, {version: 1, assetId: p.original.assetId, rasterLayerId: p.layers[0].id, sourceWidth: 480, sourceHeight: 320, mask});
    p = core.updateLabelComment(p, added.layerId, 'Keep this editable numbered shape.'); p = core.addReference(p, reference);
    p = core.linkReferences(p, added.layerId, [p.references[0].id]); p = core.updateReferenceNotes(p, p.references[0].id, 'Blue material with original bytes retained.');
    const refNative = core.addDrawing(core.referenceProject(p.references[0]), {mode: 'highlight', size: 10, color: '#ffff00', points: [[20, 40], [120, 40]]}).project;
    p = core.updateReferenceAnnotations(p, p.references[0].id, refNative.layers.filter(layer => layer.kind !== 'raster'));
    p = {...p, name: 'Rich editable project', prompt: 'Preserve the camera and all comments.'}; p = core.saveVariant(p, 'Editable master');
    return p;
  }, {initial, reference: (({buffer, ...image}) => image)(reference), mask: rectangleMask(480, 320, [40, 50, 150, 120])});
  await load(data); return {main, reference, data};
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

test('DELETE ALL clears the whole rich project in one undoable action and leaves saved masters and original file bytes untouched', async () => {
  const rich = await richProject(), before = await save();
  const masterPath = path.join(qa, 'saved-editable-master.asun'), mainPath = path.join(qa, rich.main.name), refPath = path.join(qa, rich.reference.name);
  await writeFile(masterPath, before.buffer); await writeFile(mainPath, rich.main.buffer); await writeFile(refPath, rich.reference.buffer);
  await page.locator('#compare').click(); const p = await point(300, 250); await page.mouse.click(p.x, p.y, {button: 'right'});
  assert.equal(await page.locator('#imageMenu').isVisible(), true); await reset(); const blank = await save(); await assertBlank(blank.data);
  await page.locator('#undo').click(); assert.deepEqual((await save()).data, before.data, 'One undo restores every source, editable annotation, reference, note, prompt and variant');
  await page.locator('#redo').click(); assert.deepEqual((await save()).data, blank.data); await load(blank.data); await assertBlank((await save()).data);
  assert.deepEqual(await readFile(masterPath), before.buffer); assert.deepEqual(await readFile(mainPath), rich.main.buffer); assert.deepEqual(await readFile(refPath), rich.reference.buffer);
});

test('the next file import and real native clipboard paste become independent fresh MAIN originals and export clean packs', async () => {
  const rich = await richProject(); await reset(); const fresh = await fixture('Fresh MAIN.png', 300, 180, '#00aa66'); await upload(fresh);
  let saved = await save(); assert.deepEqual([saved.data.width, saved.data.height], [300, 180]); assert.equal(Object.keys(saved.data.assets).length, 1);
  assert.equal(saved.data.assets[saved.data.original.assetId].source, fresh.source); assert.equal(saved.data.references.length, 0); assert.equal(saved.data.prompt, ''); assert.equal(saved.data.variants.length, 0);
  await text('1'); await page.locator('#linkReference').click(); await page.locator('#referenceDialog').waitFor({state: 'visible'});
  await page.locator('#labelComment').fill('Only use this fresh MAIN.'); await page.locator('#saveReferenceLink').click(); await page.locator('#referenceDialog').waitFor({state: 'hidden'});
  const pending = page.waitForEvent('download'); await page.locator('#completeReferencePackTop').click(); const entries = zipEntries((await downloaded(pending)).buffer), mapping = JSON.parse(entries.get('mapping.json').toString());
  assert.deepEqual(entries.get(mapping.cleanMain.path), fresh.buffer); assert.equal(mapping.mainImages.length, 1); assert.equal(mapping.unassignedReferences.length, 0);
  await reset(); const pasted = await fixture('Fresh clipboard.png', 440, 320, '#aa33ff');
  await page.evaluate(async bytes => {
    await navigator.clipboard.write([new ClipboardItem({'image/png': new Blob([new Uint8Array(bytes)], {type: 'image/png'})})]);
    window.__resetPasted = null; document.addEventListener('paste', event => {
      Promise.all([...event.clipboardData.files].map(async file => [...new Uint8Array(await file.arrayBuffer())])).then(files => window.__resetPasted = files);
    }, {once: true, capture: true});
  }, [...pasted.buffer]);
  await page.locator('#stage').focus(); await page.keyboard.press('Control+v');
  await page.waitForFunction(() => !document.body.classList.contains('busy') && document.querySelectorAll('.layer-row').length === 1 && window.__resetPasted !== null);
  saved = await save(); const received = await page.evaluate(() => window.__resetPasted[0]);
  assert.deepEqual([saved.data.width, saved.data.height], [440, 320]); assert.equal(Object.keys(saved.data.assets).length, 1);
  assert.equal(saved.data.assets[saved.data.original.assetId].source, 'data:image/png;base64,' + Buffer.from(received).toString('base64'));
  assert.equal(Object.values(saved.data.assets).some(asset => asset.source === rich.main.source), false);
});

test('valid pending words and prompt are retained by undo, invalid text blocks reset, and a pending crop is discarded without losing committed edits', async () => {
  await upload(await fixture('Pending edits.png')); await text('1'); const before = await save();
  await text('Pending words', {x: 200, y: 220, pending: true}); await page.locator('#prompt').fill('Pending global prompt'); await reset();
  await assertBlank((await save()).data); await page.locator('#undo').click(); let restored = await save();
  assert.equal(restored.data.prompt, 'Pending global prompt'); assert.deepEqual(restored.data.layers.filter(layer => layer.kind === 'text').map(layer => layer.text.content), ['1', 'Pending words']);
  assert.deepEqual(restored.data.assets, before.data.assets);
  await text('Invalid draft retained', {x: 20, y: 230, pending: true}); await control('textSize', 0); await page.locator('#deleteAllLayers').click();
  assert.equal(await page.locator('#textEditor').inputValue(), 'Invalid draft retained'); assert.equal(await page.locator('#textEditor').isVisible(), true);
  assert.equal(await page.locator('.layer-row').count(), restored.data.layers.length); assert.equal(await page.locator('#prompt').inputValue(), restored.data.prompt);
  await control('textSize', 24); await page.locator('#textEditor').press('Enter'); const committed = await save();
  await page.locator('.toolrail [data-tool=crop]').click(); const a = await point(10, 10), b = await point(220, 190);
  await page.mouse.move(a.x, a.y); await page.mouse.down(); await page.mouse.move(b.x, b.y, {steps: 5}); await page.mouse.up();
  assert.equal(await page.locator('#applyCrop').isVisible(), true); assert.equal(await page.locator('#deleteAllLayers').isEnabled(), true);
  await reset(); await assertBlank((await save()).data); await page.locator('#undo').click(); assert.deepEqual((await save()).data, committed.data);
  assert.equal(await page.locator('#cropBox').isVisible(), false);
});

test('modal, busy import, clipboard copying and active drawing guards keep DELETE ALL disabled and protect in-flight work', async () => {
  await upload(await fixture('Guarded MAIN.png')); let before = await save();
  await page.locator('#resizeCanvas').click(); assert.equal(await page.locator('#deleteAllLayers').isDisabled(), true);
  await page.locator('#deleteAllLayers').evaluate(button => button.onclick()); assert.equal(await page.locator('#dialog').isVisible(), true); await page.locator('#cancelDialog').click();
  assert.deepEqual((await save()).data, before.data);
  const added = await fixture('Delayed import.png', 100, 80, '#00ff00');
  await page.evaluate(() => {window.__resetNativeReader = FileReader.prototype.readAsDataURL; FileReader.prototype.readAsDataURL = function(file) {window.__releaseResetReader = () => window.__resetNativeReader.call(this, file);};});
  await page.locator('#imageInput').setInputFiles(file(added)); await page.waitForFunction(() => document.body.classList.contains('busy') && typeof window.__releaseResetReader === 'function');
  assert.equal(await page.locator('#deleteAllLayers').isDisabled(), true); await page.locator('#deleteAllLayers').evaluate(button => button.onclick());
  await page.evaluate(() => {FileReader.prototype.readAsDataURL = window.__resetNativeReader; window.__releaseResetReader();}); await idle();
  assert.equal(await page.locator('.layer-row').count(), 2); before = await save();
  await page.evaluate(() => {window.__resetClipboardWrite = navigator.clipboard.write.bind(navigator.clipboard); navigator.clipboard.write = () => new Promise(resolve => window.__releaseResetCopy = resolve);});
  await page.locator('#stage').focus(); await page.keyboard.press('Control+c'); await page.waitForFunction(() => typeof window.__releaseResetCopy === 'function');
  assert.equal(await page.locator('#deleteAllLayers').isDisabled(), true); await page.locator('#deleteAllLayers').evaluate(button => button.onclick());
  await page.evaluate(() => {window.__releaseResetCopy(); navigator.clipboard.write = window.__resetClipboardWrite;});
  await page.waitForFunction(() => !document.querySelector('#deleteAllLayers').disabled); assert.deepEqual((await save()).data, before.data);
  await page.locator('.toolrail [data-tool=pencil]').click(); const a = await point(50, 220), b = await point(300, 220);
  await page.mouse.move(a.x, a.y); await page.mouse.down(); await page.mouse.move(b.x, b.y, {steps: 6});
  assert.equal(await page.locator('#deleteAllLayers').isDisabled(), true); await page.locator('#deleteAllLayers').evaluate(button => button.onclick()); await page.mouse.up();
  assert.equal(await page.locator('.layer-row').count(), 3); assert.equal(await page.locator('#deleteAllLayers').isEnabled(), true);
  assert.equal((await save()).data.layers.at(-1).kind, 'drawing');
});

test('DELETE ALL aborts automatic detection and late old-image replies cannot repopulate a fresh imported project or hover state', async () => {
  const old = await fixture('Old detected scene.png'); await upload(old); const before = await save(); let release, started;
  const beginning = new Promise(resolve => started = resolve), gate = new Promise(resolve => release = resolve);
  detectionHandler = async (route, body) => {started(); await gate; await route.fulfill({json: detected(body)}).catch(() => {});};
  await page.locator('#autoDetect').click(); await beginning; assert.equal(await page.locator('#deleteAllLayers').isEnabled(), true);
  await reset(); const fresh = await fixture('New scene.png', 300, 180, '#2255aa'); await upload(fresh); const current = await save();
  release(); await page.waitForTimeout(120); assert.deepEqual((await save()).data, current.data);
  assert.equal(await page.locator('.edit-summary-card').count(), 0); assert.equal(await page.locator('.toolrail [data-tool].active').getAttribute('data-tool'), 'move');
  assert.equal(await page.locator('#objectHover').evaluate(c => [...c.getContext('2d').getImageData(0, 0, c.width, c.height).data].some((value, index) => index % 4 === 3 && value > 0)), false);
  await page.locator('#undo').click(); await assertBlank((await save()).data); await page.locator('#undo').click(); assert.deepEqual((await save()).data, before.data);
  assert.equal(detectionCalls.length, 1);
});

test('DELETE ALL remains readable and hit-testable beside layer actions at compact and wide widths and supports native Enter and Space activation', async () => {
  const rich = await richProject(); const before = await save();
  for (const viewport of [{width: 1280, height: 800}, {width: 1672, height: 941}]) {
    await page.setViewportSize(viewport);
    const rects = [];
    for (const id of ['layerUp', 'layerDown', 'editTextLayer', 'duplicateLayer', 'deleteLayer', 'deleteAllLayers']) {
      const r = await page.locator('#' + id).evaluate(element => {
        const r = element.getBoundingClientRect(); return {x: r.x, y: r.y, right: r.right, bottom: r.bottom, width: r.width, height: r.height,
          viewportWidth: innerWidth, viewportHeight: innerHeight, hit: element.contains(document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2))};
      });
      assert.ok(r.width > 0 && r.height > 0 && r.x >= 0 && r.y >= 0 && r.right <= r.viewportWidth && r.bottom <= r.viewportHeight && r.hit, id + ' is usable: ' + JSON.stringify(r));
      for (const other of rects) assert.ok(r.right <= other.x || r.x >= other.right || r.bottom <= other.y || r.y >= other.bottom, 'Layer actions do not overlap'); rects.push(r);
    }
    assert.equal((await page.locator('#deleteAllLayers').innerText()).trim(), 'DELETE ALL');
    await page.screenshot({path: path.join(qa, `delete-all-layers-${viewport.width}.png`)});
  }
  await page.locator('#deleteAllLayers').press('Enter'); await assertBlank((await save()).data); await page.locator('#undo').click(); assert.deepEqual((await save()).data, before.data);
  await page.locator('#deleteAllLayers').press('Space'); await assertBlank((await save()).data); await page.locator('#undo').click(); assert.deepEqual((await save()).data, rich.data);
});
