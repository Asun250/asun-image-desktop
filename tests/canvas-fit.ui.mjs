import {test, before, after, beforeEach, afterEach} from 'node:test';
import assert from 'node:assert/strict';
import {mkdir} from 'node:fs/promises';
import {inflateRawSync} from 'node:zlib';
import path from 'node:path';
import {chromium} from 'playwright';
import {createServer} from '../server.mjs';

let server, browser, context, page, base, errors;
const qa = path.resolve('qa', 'canvas-fit');
before(async () => {
  await mkdir(qa, {recursive: true}); server = createServer();
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${server.address().port}`; browser = await chromium.launch({headless: true});
});
after(async () => {await browser?.close(); if (server) await new Promise(resolve => server.close(resolve));});
beforeEach(async () => {
  errors = []; context = await browser.newContext({viewport: {width: 1672, height: 941}, acceptDownloads: true});
  await context.grantPermissions(['clipboard-read', 'clipboard-write'], {origin: base});
  page = await context.newPage(); page.on('pageerror', error => errors.push(error.message));
  page.on('request', request => {
    if (![base, 'data:', 'blob:'].some(prefix => request.url().startsWith(prefix))) errors.push('Unexpected remote request: ' + request.url());
  });
  await page.route('**/api/local-detection/status', route => route.fulfill({json: {available: false, message: 'Mock unavailable; canvas tests use saved native regions.'}}));
  await page.goto(base); await page.waitForFunction(() => document.documentElement.dataset.ready === 'true');
});
afterEach(async info => {
  try {
    if (info.error) await page.screenshot({path: path.join(qa, 'failure-' + info.name.replace(/\W+/g, '-') + '.png')});
    assert.deepEqual(errors, []);
  } finally {await context?.close();}
});

async function fixture(name, width, height, color = '#22aa88', type = 'image/png') {
  const png = await page.evaluate(({width, height, color, type}) => {
    const c = document.createElement('canvas'); c.width = width; c.height = height;
    const ctx = c.getContext('2d'); ctx.fillStyle = color; ctx.fillRect(0, 0, width, height);
    return c.toDataURL(type, .92);
  }, {width, height, color, type});
  const buffer = Buffer.concat([Buffer.from(png.split(',')[1], 'base64'), Buffer.from('\nExact untouched file: ' + name)]);
  return {name, width, height, color, type, buffer, source: 'data:' + type + ';base64,' + buffer.toString('base64')};
}
const file = image => ({name: image.name, mimeType: image.type || 'image/png', buffer: image.buffer});
async function idle() {await page.waitForFunction(() => !document.body.classList.contains('busy'));}
async function upload(images) {
  const count = await page.locator('.layer-row').count();
  await page.locator('#imageInput').setInputFiles((Array.isArray(images) ? images : [images]).map(file)); await idle();
  await page.waitForFunction(count => document.querySelectorAll('.layer-row').length === count, count + (Array.isArray(images) ? images.length : 1));
}
async function clearLayers() {
  while (await page.locator('.layer-row').count()) {
    await page.locator('.layer-row').first().click(); await page.locator('#deleteLayer').click();
  }
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
async function label(content = '1', x = 20, y = 20) {
  await page.locator('#addText').click(); await control('textSize', 24); const p = await point(x, y);
  await page.mouse.click(p.x, p.y); await page.locator('#textEditor').fill(content); await page.locator('#textEditor').press('Enter');
  await page.locator('#textEditor').waitFor({state: 'hidden'});
  return page.locator('.layer-row.selected').getAttribute('data-id');
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
  await page.locator('#projectInput').setInputFiles({name: 'Canvas fit fixture.asun', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(data))});
  await idle(); await page.waitForFunction(count => document.querySelectorAll('.layer-row').length === count, data.layers.length);
}
async function opaqueEdges(width, height, color = null) {
  await page.waitForFunction(({width, height}) => {
    const c = document.querySelector('#canvas'); if (c.width !== width || c.height !== height) return false;
    return c.getContext('2d').getImageData(0, 0, 1, 1).data[3] === 255;
  }, {width, height});
  const info = await page.locator('#canvas').evaluate(canvas => {
    const ctx = canvas.getContext('2d'), w = canvas.width, h = canvas.height;
    const perimeter = [ctx.getImageData(0, 0, w, 1).data, ctx.getImageData(0, h - 1, w, 1).data, ctx.getImageData(0, 0, 1, h).data, ctx.getImageData(w - 1, 0, 1, h).data];
    const minimumAlpha = Math.min(...perimeter.flatMap(pixels => [...pixels].filter((_, index) => index % 4 === 3)));
    return {width: w, height: h, minimumAlpha, corners: [[0, 0], [w - 1, 0], [0, h - 1], [w - 1, h - 1]].map(([x, y]) => [...ctx.getImageData(x, y, 1, 1).data])};
  });
  assert.deepEqual([info.width, info.height], [width, height]); assert.equal(info.minimumAlpha, 255, 'Every perimeter pixel is opaque, without app-added canvas strips');
  if (color) {const rgb = color.match(/\w\w/g).map(value => parseInt(value, 16)); for (const corner of info.corners) assert.deepEqual(corner, [...rgb, 255]);}
}
async function writePNG(image) {
  await page.evaluate(bytes => navigator.clipboard.write([new ClipboardItem({'image/png': new Blob([new Uint8Array(bytes)], {type: 'image/png'})})]), [...image.buffer]);
}
async function pasteNative() {
  await page.evaluate(() => {
    window.__fitPasteFiles = null;
    document.addEventListener('paste', event => {
      Promise.all([...event.clipboardData.files].map(async file => ({type: file.type, bytes: [...new Uint8Array(await file.arrayBuffer())]}))).then(files => window.__fitPasteFiles = files);
    }, {once: true, capture: true});
  });
  await page.locator('#stage').focus(); await page.keyboard.press('Control+v');
  await page.waitForFunction(() => !document.body.classList.contains('busy') && document.querySelectorAll('.layer-row').length === 1 && window.__fitPasteFiles !== null);
  return page.evaluate(() => window.__fitPasteFiles);
}
async function drop(image) {
  await page.locator('#stage').evaluate((stage, image) => {
    const dataTransfer = new DataTransfer(); dataTransfer.items.add(new File([new Uint8Array(image.bytes)], image.name, {type: 'image/png'}));
    stage.dispatchEvent(new DragEvent('drop', {bubbles: true, cancelable: true, dataTransfer}));
  }, {name: image.name, bytes: [...image.buffer]});
  await page.waitForFunction(() => !document.body.classList.contains('busy') && document.querySelectorAll('.layer-row').length === 1);
}
function rectangleMask(width, height, [x, y, w, h]) {
  const counts = []; let previous = false, run = 0;
  for (let row = 0; row < height; row++) for (let column = 0; column < width; column++) {
    const inside = column >= x && column < x + w && row >= y && row < y + h;
    if (inside === previous) run++; else {counts.push(run); previous = inside; run = 1;}
  }
  counts.push(run); return {width, height, counts};
}
async function regionInfo(project, points) {
  return page.evaluate(async ({project, points}) => {
    const {objectRegionBounds, objectRegionContains} = await import('/object-regions.mjs'), layer = project.layers.find(layer => layer.objectRegion);
    return {bounds: objectRegionBounds(project, layer), contains: points.map(point => objectRegionContains(project, layer, point))};
  }, {project, points});
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

test('empty-canvas file imports use native portrait, landscape, square and extreme-aspect dimensions with fully opaque edges', async () => {
  const inputs = [];
  for (const [name, width, height, type = 'image/png'] of [['Portrait.png', 880, 1564], ['Landscape.png', 1564, 880], ['Square.png', 900, 900], ['Extreme wide.png', 4096, 64], ['Extreme tall.png', 64, 4096], ['JPEG portrait.jpg', 240, 640, 'image/jpeg'], ['WebP landscape.webp', 640, 240, 'image/webp']]) {
    await clearLayers(); const image = await fixture(name, width, height, '#22aa88', type); inputs.push(image); await upload(image); await opaqueEdges(width, height, type === 'image/png' ? image.color : null);
    const saved = await save(), layer = saved.data.layers[0];
    assert.deepEqual([layer.x, layer.y, layer.width, layer.height], [0, 0, width, height]); assert.equal(saved.data.assets[layer.assetId].source, image.source);
    assert.equal(await page.locator('#fitCanvasPhoto').isVisible(), false, 'An already-fitted image does not need a repair action');
  }
  const saved = await save();
  for (const input of inputs) assert.equal(Object.values(saved.data.assets).find(asset => asset.name === input.name).source, input.source, 'Old imported originals remain saved even after their display layers are deleted');
});

test('deleting all old layers before importing a replacement removes padding while retaining first original bytes and one-step import undo', async () => {
  const old = await fixture('First clean MAIN.png', 1006, 1564, '#335577'), replacement = await fixture('Replacement portrait.png', 880, 1564, '#993366');
  await upload(old); const first = await save(); await clearLayers(); const empty = await save(); await upload(replacement); await opaqueEdges(880, 1564, replacement.color);
  const fitted = await save(); assert.deepEqual(fitted.data.original, first.data.original); assert.equal(fitted.data.assets[first.data.original.assetId].source, old.source);
  assert.equal(fitted.data.assets[fitted.data.layers[0].assetId].source, replacement.source);
  await page.locator('#undo').click(); assert.deepEqual((await save()).data, empty.data);
  await page.locator('#redo').click(); assert.deepEqual((await save()).data, fitted.data); await load(fitted.data); await opaqueEdges(880, 1564, replacement.color);
  assert.deepEqual((await save()).data, fitted.data, 'Reopening retains the fitted replacement and every original without silently rewriting the first MAIN pointer');
});

test('native clipboard, local file drop and explicit Paste all refit a cleared canvas through the shared import path', async () => {
  const old = await fixture('Old main.png', 1006, 1564); await upload(old); const first = await save();
  const portrait = await fixture('Clipboard portrait.png', 880, 1564, '#ff0000'); await clearLayers(); await writePNG(portrait); const captured = await pasteNative();
  await opaqueEdges(880, 1564, portrait.color); let saved = await save();
  assert.equal(saved.data.assets[saved.data.layers[0].assetId].source, 'data:image/png;base64,' + Buffer.from(captured[0].bytes).toString('base64'), 'The actual native clipboard event bytes are preserved');
  const landscape = await fixture('Dropped landscape.png', 1564, 880, '#0000ff'); await clearLayers(); await drop(landscape); await opaqueEdges(1564, 880, landscape.color);
  saved = await save(); assert.equal(saved.data.assets[saved.data.layers[0].assetId].source, landscape.source);
  const square = await fixture('Paste button square.png', 600, 600, '#00aa00'); await clearLayers(); await writePNG(square); await page.locator('#pasteTop').click();
  await page.waitForFunction(() => !document.body.classList.contains('busy') && document.querySelectorAll('.layer-row').length === 1); await opaqueEdges(600, 600, square.color);
  saved = await save(); assert.deepEqual(saved.data.original, first.data.original); assert.equal(saved.data.assets[first.data.original.assetId].source, old.source);
});

test('explicit photo fit maps native annotations, masks and regions together in one undo and retains comments, references, variants and ZIP originals', async () => {
  const main = await fixture('Native MAIN.png', 280, 500, '#eeeeee'), overlay = await fixture('Other layer.png', 20, 20, '#00ffff'), reference = await fixture('Material reference.png', 80, 60, '#0000ff');
  await upload([main, overlay]); const initial = (await save()).data;
  const seeded = await page.evaluate(async ({initial, reference, mask}) => {
    const core = await import('/core.mjs'); let p = {...initial, width: 400, height: 600};
    p = core.updateLayer(p, p.layers[0].id, {x: 130, y: 175, width: 140, height: 250});
    p = core.addMaskStroke(p, p.layers[0].id, {mode: 'hide', size: 30, points: [[200, 350]], sourceWidth: 280, sourceHeight: 500});
    p = core.updateLayer(p, p.layers[1].id, {x: 350, y: 500});
    const drawing = core.addDrawing(p, {mode: 'pencil', size: 5, color: '#ff0000', points: [[160, 250], [220, 250]]}); p = drawing.project;
    const added = core.addText(p, {content: '1', x: 150, y: 230, width: 24, height: 32, fontSize: 24, color: '#dd5500'}); p = added.project;
    p = core.attachObjectRegion(p, added.layerId, {version: 1, assetId: p.layers[0].assetId, rasterLayerId: p.layers[0].id, sourceWidth: 280, sourceHeight: 500, mask});
    p = core.updateLabelComment(p, added.layerId, 'Use this blue reference within the numbered shape.'); p = core.addReference(p, reference);
    p = core.linkReferences(p, added.layerId, [p.references[0].id]); p = core.updateReferenceNotes(p, p.references[0].id, 'Keep the blue tone.');
    p = {...p, prompt: 'Preserve every editable instruction.'}; p = core.saveVariant(p, 'Padded editable master');
    return {project: p, rasterId: p.layers[0].id, drawingId: drawing.layerId, labelId: added.layerId};
  }, {initial, reference: (({buffer, ...image}) => image)(reference), mask: rectangleMask(280, 500, [30, 80, 80, 100])});
  await load(seeded.project); const before = await save(); await page.locator(`.layer-row[data-id="${seeded.rasterId}"]`).click();
  assert.equal(await page.locator('#fitCanvasPhoto').isVisible(), true); await page.locator('#fitCanvasPhoto').click(); await opaqueEdges(280, 500, main.color);
  const fitted = await save(); assert.deepEqual([fitted.data.width, fitted.data.height], [280, 500]);
  for (const previous of before.data.layers) {
    const current = fitted.data.layers.find(layer => layer.id === previous.id);
    assert.deepEqual([current.x, current.y, current.width, current.height], [(previous.x - 130) * 2, (previous.y - 175) * 2, previous.width * 2, previous.height * 2]);
    for (const key of ['mask', 'text', 'drawing', 'objectRegion', 'referenceIds', 'referenceComment']) assert.deepEqual(current[key], previous[key], key + ' stays native and editable');
  }
  for (const key of ['assets', 'references', 'original', 'variants', 'prompt']) assert.deepEqual(fitted.data[key], before.data[key]);
  const info = await regionInfo(fitted.data, [[60, 130], [140, 420]]); assert.deepEqual(info.bounds, {x: 30, y: 80, width: 80, height: 100}); assert.deepEqual(info.contains, [true, false]);
  assert.deepEqual(await page.locator('#canvas').evaluate(c => [...c.getContext('2d').getImageData(120, 150, 1, 1).data]), [255, 0, 0, 255], 'The existing pencil mark follows the same affine map');
  assert.equal(await page.locator('#canvas').evaluate(c => c.getContext('2d').getImageData(200, 350, 1, 1).data[3]), 0, 'The native raster mask remains aligned');
  await page.locator('#undo').click(); assert.deepEqual((await save()).data, before.data); await page.locator('#redo').click(); assert.deepEqual((await save()).data, fitted.data);
  await load(fitted.data); const pending = page.waitForEvent('download'); await page.locator('#completeReferencePackTop').click();
  const entries = zipEntries((await downloaded(pending)).buffer), mapping = JSON.parse(entries.get('mapping.json').toString());
  assert.deepEqual(entries.get(mapping.cleanMain.path), main.buffer); assert.deepEqual(entries.get(mapping.numbers[0].references[0].path), reference.buffer);
  const overlayRecord = mapping.mainImages.find(item => item.originalFilename === overlay.name); assert.deepEqual(entries.get(overlayRecord.path), overlay.buffer);
  const pixels = await page.evaluate(async ({bytes, project}) => {
    const layout = (await import('/reference-board.mjs')).referenceBoardPages(project)[0], bitmap = await createImageBitmap(new Blob([new Uint8Array(bytes)], {type: 'image/png'}));
    const c = document.createElement('canvas'); c.width = bitmap.width; c.height = bitmap.height; const ctx = c.getContext('2d'); ctx.drawImage(bitmap, 0, 0); bitmap.close();
    const pixel = (x, y) => [...ctx.getImageData(Math.floor(x), Math.floor(y), 1, 1).data];
    const tile = layout.tiles.find(tile => tile.group.reference);
    return {drawing: pixel(layout.main.x + 120 * layout.main.width / project.width, layout.main.y + 150 * layout.main.height / project.height), reference: pixel(tile.image.x + tile.image.width / 2, tile.image.y + tile.image.height / 2)};
  }, {bytes: [...entries.get(mapping.generatedPreviews[0].path)], project: fitted.data});
  assert.deepEqual(pixels.drawing, [255, 0, 0, 255]); assert.deepEqual(pixels.reference, [0, 0, 255, 255]);
});

test('fit is offered only for an eligible unambiguous source, and a selected raster intentionally overrides other images', async () => {
  assert.equal(await page.locator('#fitCanvasPhoto').isVisible(), false); assert.equal(await page.locator('#fitCanvasPhoto').isDisabled(), true);
  const text = await label('1', 100, 100); assert.equal(await page.locator('#fitCanvasPhoto').isVisible(), false);
  const first = await fixture('First.png', 400, 300), second = await fixture('Second.png', 200, 100, '#ff55aa'); await upload([first, second]);
  await page.locator(`.layer-row[data-id="${text}"]`).click(); assert.equal(await page.locator('#fitCanvasPhoto').isVisible(), false, 'An annotation cannot choose between multiple raster images');
  const before = await save(), target = before.data.layers.filter(layer => layer.kind === 'raster')[1]; await page.locator(`.layer-row[data-id="${target.id}"]`).click();
  assert.equal(await page.locator('#fitCanvasPhoto').isVisible(), true);
  await page.locator('#newProject').click(); await page.locator('#fitCanvasPhoto').evaluate(button => button.onclick());
  assert.equal(await page.locator('#desktopCreateDialog').isVisible(), true); await page.locator('#desktopCreateDialog .desktop-create-close').click();
  assert.deepEqual((await save()).data, before.data, 'The photo-fit handler cannot mutate the background under another dialog');
  await page.locator('#fitCanvasPhoto').click(); await opaqueEdges(200, 100, second.color);
  const after = await save(); assert.deepEqual(after.data.original, before.data.original); assert.deepEqual(after.data.assets, before.data.assets);
  assert.equal(after.data.layers.length, before.data.layers.length); assert.equal(await page.locator('#fitCanvasPhoto').isVisible(), false);
});

test('custom resized and cropped projects reopen unchanged until explicit photo fit, with a usable button and stage at compact and wide widths', async () => {
  const photo = await fixture('Tall scene.png', 880, 1564, '#996622'); await upload(photo);
  await label('1', 200, 350);
  await page.locator('#resizeCanvas').click(); await page.locator('#widthField').fill('1006'); await page.locator('#heightField').fill('1564'); await page.locator('#confirmDialog').click();
  const padded = await save(); await load(padded.data); assert.deepEqual((await save()).data, padded.data, 'Reopen does not silently alter an intentional custom canvas');
  for (const viewport of [{width: 1280, height: 800}, {width: 1672, height: 941}]) {
    await page.setViewportSize(viewport); await page.locator('#fit').click();
    const info = await page.locator('#fitCanvasPhoto').evaluate(element => {
      const r = element.getBoundingClientRect(); return {x: r.x, y: r.y, right: r.right, bottom: r.bottom, width: innerWidth, height: innerHeight, hit: element.contains(document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2))};
    });
    assert.ok(info.x >= 0 && info.y >= 0 && info.right <= info.width && info.bottom <= info.height && info.hit, JSON.stringify(info));
    assert.equal(await page.locator('#fitCanvasPhoto').getAttribute('aria-label'), 'Fit canvas to photo');
    for (const id of ['textColorWheel', 'linkReference', 'autoDetect', 'compare', 'fit', 'zoomOut', 'zoomValue', 'zoomIn', 'export']) {
      const info = await page.locator('#' + id).evaluate(element => {
        const r = element.getBoundingClientRect(), target = document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2);
        return {x: r.x, right: r.right, hit: element.contains(target), hitTarget: target?.closest('button')?.id || target?.tagName, width: innerWidth};
      });
      assert.ok(info.x >= 0 && info.right <= info.width && info.hit, id + ' remains usable beside Fit photo with a selected text label: ' + JSON.stringify(info));
    }
    await page.screenshot({path: path.join(qa, `fit-photo-control-${viewport.width}.png`)});
  }
  assert.deepEqual((await save()).data, padded.data, 'View Fit and viewport changes do not change document geometry');
  await page.locator('.toolrail [data-tool=crop]').click(); const a = await point(100, 200), b = await point(700, 1200);
  await page.mouse.move(a.x, a.y); await page.mouse.down(); await page.mouse.move(b.x, b.y, {steps: 6}); await page.mouse.up(); await page.locator('#applyCrop').click();
  assert.equal(await page.locator('#fitCanvasPhoto').isEnabled(), true, 'Applying a crop clears its gesture guard immediately, without a reopen workaround');
  const cropped = await save(); assert.deepEqual([cropped.data.width, cropped.data.height], [600, 1000]);
  await page.locator('#fitCanvasPhoto').click(); await opaqueEdges(880, 1564, photo.color); const repaired = await save();
  assert.equal(repaired.data.assets[repaired.data.original.assetId].source, photo.source); assert.deepEqual([repaired.data.layers[0].x, repaired.data.layers[0].y, repaired.data.layers[0].width, repaired.data.layers[0].height], [0, 0, 880, 1564]);
  await page.screenshot({path: path.join(qa, 'explicit-fit-photo-1672.png')});
  await page.locator('#undo').click(); assert.deepEqual((await save()).data, cropped.data);
  await load(cropped.data); assert.deepEqual((await save()).data, cropped.data, 'Native crop remains intentional after reopen');
});
