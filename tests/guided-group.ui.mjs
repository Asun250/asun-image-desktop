import {test, before, after, beforeEach, afterEach} from 'node:test';
import assert from 'node:assert/strict';
import {mkdir, writeFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {inflateRawSync} from 'node:zlib';
import path from 'node:path';
import {chromium} from 'playwright';
import {createServer} from '../server.mjs';

let server, browser, context, page, base, errors, main, calls, available, responseHandler;
const qa = path.resolve('qa', 'guided-group');
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

const birdCenters = [[90,65],[340,65],[90,245],[340,245]];
async function markBirds(count = 4) {
  for (const [x,y] of birdCenters.slice(0,count)) await mark('highlight', [[x-30,y],[x+30,y]], 18);
}
async function groupReady(count = 4) {
  await page.waitForFunction(count => {
    const list = document.querySelector('#guidedGroupList');
    return !list.hidden && list.querySelectorAll('[data-mark-id]').length === count &&
      document.querySelector('#guidedDetectionPreview').getAttribute('aria-busy') === 'false';
  }, count);
}
const groupRow = index => page.locator('#guidedGroupList [data-mark-id]').nth(index);
async function cancelGroup(action = 'cancel') {
  if (action === 'escape') await page.locator('#confirmGuidedDetection').press('Escape');
  else await page.locator(action === 'x' ? '#closeGuidedDetection' : '#cancelGuidedDetection').click();
  await page.locator('#guidedDetectionDialog').waitFor({state:'hidden'});
}
function selectedGroup(saved) {
  const selected = saved.data.layers.filter(layer => layer.objectRegion);
  assert.equal(selected.length,1,'The four disconnected areas have one shared numbered group');
  return selected[0];
}

test('four highlights detect separately, keep disconnected gaps, share references, and survive undo/reopen/export', async () => {
  let active = 0, maxActive = 0;
  responseHandler = async (route,body) => {
    active++; maxActive = Math.max(active,maxActive);
    await new Promise(resolve=>setTimeout(resolve,25));
    await route.fulfill({json:mockedResult(body)}); active--;
  };
  await markBirds(); const before = await save(), marks = before.data.layers.filter(layer=>layer.kind==='drawing');
  assert.equal(marks.length,4);
  assert.match(await page.locator('#detectMarkedArea').innerText(),/4/);
  await guided(); await groupReady();
  assert.equal(calls.length,4,'One clean prompted crop is sent for each object');
  assert.equal(maxActive,1,'The single-worker GPU receives serial inferences');
  assert.equal(await page.locator('#confirmGuidedDetection').isEnabled(),true);
  assert.equal(await page.locator('.layer-row').count(),before.data.layers.length,'Reviewing candidates does not mutate the project');
  for (const request of calls) {
    assert.equal(request.headers['x-asun-detection-token'],'qa-guided-token');
    assert.equal(request.body.prompt.box.length,4);
    assert.ok(request.body.width<480 && request.body.height<320);
    assert.equal((await imagePixels([...Buffer.from(request.body.source.split(',')[1],'base64')])).colored,0,'Green highlights are excluded from every inference crop');
  }
  await page.waitForFunction(()=>!document.querySelector('#confirmGuidedDetection').disabled);
  await page.waitForFunction(()=>{const b=document.querySelector('#confirmGuidedDetection');return getComputedStyle(b).color==='rgb(255, 255, 255)';});
  const previewState = await page.locator('#confirmGuidedDetection').evaluate(button=>({disabled:button.disabled, ariaBusy:document.querySelector('#guidedDetectionPreview').getAttribute('aria-busy'), opacity:getComputedStyle(button).opacity, color:getComputedStyle(button).color, background:getComputedStyle(button).backgroundColor}));
  assert.equal(previewState.disabled,false);
  await writeFile(path.join(qa,'four-object-group-preview-state.json'),JSON.stringify(previewState,null,2));
  await page.screenshot({path:path.join(qa,'four-object-group-preview.png'),animations:'disabled'});
  await page.locator('#themeToggle').evaluate(button=>button.click()); await page.setViewportSize({width:1280,height:800});
  await page.locator('#confirmGuidedDetection').scrollIntoViewIfNeeded();
  assert.equal(await page.locator('#confirmGuidedDetection').isEnabled(),true);
  await page.screenshot({path:path.join(qa,'four-object-group-preview-dark-1280.png'),animations:'disabled'});
  await page.locator('#themeToggle').evaluate(button=>button.click()); await page.setViewportSize({width:1672,height:941});
  await confirmGuided();
  assert.match(await page.locator('#referenceAreaLabel').innerText(),/applies to all 4 areas/i);
  await closeReferences(); const grouped = await save(), selected = selectedGroup(grouped);
  assert.deepEqual(selected.objectRegion.group,{areaCount:4}); assert.equal(selected.text.content,'1');
  assert.deepEqual((await selectionInfo(grouped.data,[...birdCenters,[215,65],[215,155],[215,245],[90,155]])).contains,[true,true,true,true,false,false,false,false]);
  for(const mark of marks) assert.deepEqual(grouped.data.layers.find(layer=>layer.id===mark.id),{...mark,visible:false},'Accepted highlights remain editable hidden originals');
  assert.equal(grouped.data.assets[grouped.data.original.assetId].source,main.source);
  await page.locator('#undo').click(); assert.deepEqual((await save()).data,before.data,'One undo restores all four visible highlights and removes only the group');
  await page.locator('#redo').click(); assert.deepEqual((await save()).data,grouped.data);
  await page.locator('.toolrail [data-tool=move]').click();
  await page.locator(`.layer-row[data-id="${selected.id}"]`).click(); await page.locator('#linkReference').click();
  const reference = await fixture('One shared bird reference.png','#00aaff');
  await page.locator('#labelComment').fill('Give all four birds the same blue plumage. Keep the background unchanged.');
  await page.locator('#referenceFileInput').setInputFiles(file(reference));
  await page.waitForFunction(()=>!document.body.classList.contains('busy')&&document.querySelector('#referenceEditorHost').dataset.refReady==='true');
  await page.locator('#referenceNotes').fill('Use this exact blue across the entire group.');
  await closeReferences(true); const linked = await save(), linkedGroup = selectedGroup(linked);
  assert.equal(linkedGroup.referenceIds.length,1); assert.equal(linked.data.references.length,1);
  await reopen(linked); await page.locator('.toolrail [data-tool=move]').click();
  await page.locator(`.layer-row[data-id="${selected.id}"]`).click(); await page.locator('#linkReference').click();
  assert.match(await page.locator('#referenceAreaLabel').innerText(),/all 4 areas/i);
  assert.equal(await page.locator('#labelComment').inputValue(),linkedGroup.referenceComment);
  assert.equal(await page.locator('#referenceGallery [data-reference-key]').count(),1); await closeReferences();
  const pending = page.waitForEvent('download'); await page.locator('#completeReferencePackTop').click();
  const entries = zipEntries((await downloaded(pending)).buffer), mapping = JSON.parse(entries.get('mapping.json').toString());
  assert.equal(mapping.numbers.length,1); assert.equal(mapping.numbers[0].references.length,1);
  assert.equal(mapping.numbers[0].selections[0].group.areaCount,4);
  assert.deepEqual(mapping.numbers[0].selections[0].mask,linkedGroup.objectRegion.mask);
  assert.equal(mapping.numbers[0].comment,linkedGroup.referenceComment);
  assert.deepEqual(entries.get(mapping.cleanMain.path),main.buffer);
  assert.deepEqual(entries.get(mapping.numbers[0].references[0].path),reference.buffer);
  assert.ok([...entries].some(([name,bytes])=>/readme/i.test(name)&&/all 4 selected areas/.test(bytes.toString())),'Export explains the shared group scope');
  assert.equal(calls.length,4,'Reopening and exporting never reruns inference');
  assert.deepEqual((await save()).data,linked.data);
});

test('each highlight can choose an alternative or be excluded without changing the other three masks', async () => {
  await markBirds(); const before = await save(), marks = before.data.layers.filter(layer=>layer.kind==='drawing');
  await guided(); await groupReady();
  const preview = await page.locator('#guidedDetectionPreview').evaluate(canvas=>canvas.toDataURL());
  await groupRow(0).locator('[data-group-candidate]').selectOption('1');
  await page.waitForFunction(previous=>document.querySelector('#guidedDetectionPreview').toDataURL()!==previous,preview);
  await groupRow(3).locator('[data-group-include]').uncheck();
  assert.match(await groupRow(3).innerText(),/excluded/i);
  assert.match(await page.locator('#confirmGuidedDetection').innerText(),/3 areas/);
  await confirmGuided(); await closeReferences(); const saved = await save(), group = selectedGroup(saved);
  assert.equal(group.objectRegion.group.areaCount,3);
  assert.deepEqual((await selectionInfo(saved.data,[...birdCenters,[47,65],[297,65]])).contains,[true,true,true,false,true,false],'Only the first candidate expands, and the excluded fourth area remains untouched');
  assert.equal(saved.data.layers.find(layer=>layer.id===marks[3].id).visible,true);
  assert.ok(marks.slice(0,3).every(mark=>saved.data.layers.find(layer=>layer.id===mark.id).visible===false));
  await page.locator('#undo').click(); assert.deepEqual((await save()).data,before.data);
});

test('failed areas block group confirmation until explicitly excluded or manually selected', async () => {
  let index = 0;
  responseHandler = (route,body) => ++index%4===2
    ? route.fulfill({status:503,json:{error:'Test: the second bird could not be detected'}})
    : route.fulfill({json:mockedResult(body)});
  await markBirds(); const before=await save(); await guided(); await groupReady();
  assert.equal(calls.length,4,'A failed bird does not stop attempts for the remaining birds');
  assert.equal(await page.locator('#confirmGuidedDetection').isEnabled(),false);
  assert.match(await groupRow(1).innerText(),/could not be detected/);
  await groupRow(1).locator('[data-group-include]').uncheck();
  assert.equal(await page.locator('#confirmGuidedDetection').isEnabled(),true);
  await groupRow(1).locator('[data-group-include]').check();
  assert.equal(await page.locator('#confirmGuidedDetection').isEnabled(),false);
  await groupRow(1).locator('[data-group-manual]').click();
  assert.match(await groupRow(1).innerText(),/manual.*not AI detected/i);
  assert.equal(await page.locator('#confirmGuidedDetection').isEnabled(),true);
  await confirmGuided(); await closeReferences(); const saved=await save();
  assert.equal(selectedGroup(saved).objectRegion.group.areaCount,4);
  assert.deepEqual((await selectionInfo(saved.data,birdCenters)).contains,[true,true,true,true]);
  await page.locator('#undo').click(); assert.deepEqual((await save()).data,before.data);
});

test('Cancel, X, and Escape discard all grouped candidates and leave the complete editable document intact', async () => {
  await markBirds(); const before=await save();
  for(const action of ['cancel','x','escape']) {
    await guided(); await groupReady();
    await groupRow(0).locator('[data-group-candidate]').selectOption('1');
    await groupRow(1).locator('[data-group-include]').uncheck();
    await page.locator('#confirmGuidedDetection').press('Control+z');
    assert.equal(await page.locator('.layer-row').count(),before.data.layers.length);
    await cancelGroup(action); assert.deepEqual((await save()).data,before.data,action+' does not commit or alter a group');
    assert.equal(await page.locator('#referenceDialog').isVisible(),false);
  }
});

test('cancelling an in-flight group prevents queued inference and ignores the late result', async () => {
  let release, started;
  const began = new Promise(resolve=>started=resolve), gate = new Promise(resolve=>release=resolve);
  responseHandler = async (route,body) => {started();await gate;await route.fulfill({json:mockedResult(body)}).catch(()=>{});};
  await markBirds(); const before=await save(); await guided(); await began;
  assert.equal(await page.locator('#confirmGuidedDetection').isEnabled(),false);
  await cancelGroup(); release(); await page.waitForTimeout(150);
  assert.equal(calls.length,1,'Cancelling does not submit the other three crops');
  assert.equal(await page.locator('#referenceDialog').isVisible(),false);
  assert.deepEqual((await save()).data,before.data,'The late result never creates a group');
  responseHandler=null; await guided(); await groupReady();
  assert.equal(await page.locator('#confirmGuidedDetection').isEnabled(),true,'A later explicit retry still works');
  await cancelGroup();
});

test('unavailable detector offers explicit manual grouping without submitting any crop', async () => {
  available=false; await markBirds(); const before=await save(); await guided(); await groupReady();
  assert.equal(calls.length,0); assert.equal(await page.locator('#confirmGuidedDetection').isEnabled(),false);
  assert.equal(await page.locator('#useMarkedArea').isEnabled(),true);
  await page.locator('#useMarkedArea').click();
  assert.equal(await page.locator('#confirmGuidedDetection').isEnabled(),true);
  for(let i=0;i<4;i++) assert.match(await groupRow(i).innerText(),/manual.*not AI detected/i);
  await confirmGuided(); await closeReferences(); const saved=await save();
  assert.deepEqual((await selectionInfo(saved.data,[...birdCenters,[215,155]])).contains,[true,true,true,true,false]);
  await page.locator('#undo').click(); assert.deepEqual((await save()).data,before.data);
});

