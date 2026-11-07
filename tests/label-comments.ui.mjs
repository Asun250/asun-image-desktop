import {test, before, after, beforeEach, afterEach} from 'node:test';
import assert from 'node:assert/strict';
import {mkdir} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {inflateRawSync} from 'node:zlib';
import path from 'node:path';
import {chromium} from 'playwright';
import {createServer} from '../server.mjs';

let server, browser, context, page, base, errors, main, detectionCalls;
const qa = path.resolve('qa', 'label-comments');

before(async () => {
  await mkdir(qa, {recursive: true});
  server = createServer();
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${server.address().port}`;
  browser = await chromium.launch({headless: true});
});
after(async () => {
  await browser?.close();
  if (server) await new Promise(resolve => server.close(resolve));
});
beforeEach(async () => {
  errors = []; detectionCalls = [];
  context = await browser.newContext({viewport: {width: 1672, height: 941}, acceptDownloads: true});
  await context.grantPermissions(['clipboard-read', 'clipboard-write'], {origin: base});
  page = await context.newPage();
  page.on('pageerror', error => errors.push(error.message));
  page.on('request', request => {
    if (![base, 'data:', 'blob:'].some(prefix => request.url().startsWith(prefix))) {
      errors.push('Unexpected remote request: ' + request.url());
    }
  });
  await page.route('**/api/local-detection/status', route => route.fulfill({json: {
    available: true, token: 'qa-comment-token', model: 'sam2.1_hiera_small', device: 'cuda'
  }}));
  await page.route('**/api/local-detection', route => {
    const body = route.request().postDataJSON(); detectionCalls.push(body);
    return route.fulfill({json: {width: body.width, height: body.height, regions: [{
      id: 'blockout-object', bbox: [40, 50, 150, 120], area: 18000,
      segmentation: rectangleMask(body.width, body.height, [40, 50, 150, 120])
    }], model: 'sam2.1_hiera_small', device: 'cuda', elapsedMs: 100}});
  });
  await page.goto(base);
  await page.waitForFunction(() => document.documentElement.dataset.ready === 'true');
  main = await fixture('Immutable MAIN.png', '#dedede', 480, 320);
  await page.locator('#imageInput').setInputFiles(file(main));
  await page.waitForFunction(() => document.querySelectorAll('.layer-row').length === 1 && !document.body.classList.contains('busy'));
  await label('1');
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
    if (inside === last) run++;
    else { counts.push(run); run = 1; last = inside; }
  }
  counts.push(run); return {width, height, counts};
}
async function fixture(name, color, width = 240, height = 160) {
  const png = await page.evaluate(({color, width, height}) => {
    const canvas = document.createElement('canvas'); canvas.width = width; canvas.height = height;
    const ctx = canvas.getContext('2d'); ctx.fillStyle = color; ctx.fillRect(0, 0, width, height);
    return canvas.toDataURL('image/png');
  }, {color, width, height});
  const buffer = Buffer.concat([Buffer.from(png.split(',')[1], 'base64'), Buffer.from('\nAsun original bytes: ' + name)]);
  return {name, width, height, buffer, source: 'data:image/png;base64,' + buffer.toString('base64')};
}
const file = image => ({name: image.name, mimeType: 'image/png', buffer: image.buffer});
async function idle() { await page.waitForFunction(() => !document.body.classList.contains('busy')); }
async function control(id, value) {
  await page.locator('#' + id).evaluate((input, value) => {
    input.value = String(value); input.dispatchEvent(new Event('input', {bubbles: true}));
    input.dispatchEvent(new Event('change', {bubbles: true}));
  }, value);
}
async function point(x, y) {
  const rect = await page.locator('#board').boundingBox();
  const size = await page.locator('#canvas').evaluate(canvas => ({width: canvas.width, height: canvas.height}));
  return {x: rect.x + x * rect.width / size.width, y: rect.y + y * rect.height / size.height};
}
async function label(text, x = 20, y = 20) {
  await page.locator('#addText').click(); await control('textSize', 24);
  const p = await point(x, y); await page.mouse.click(p.x, p.y);
  await page.locator('#textEditor').fill(text); await page.locator('#textEditor').press('Enter');
  await page.locator('#textEditor').waitFor({state: 'hidden'});
}
async function open() {
  await page.locator('#linkReference').click(); await page.locator('#referenceDialog').waitFor({state: 'visible'}); await idle();
}
async function close(action = 'cancel') {
  await page.evaluate(() => {
    window.__commentDialogClosed = new Promise(resolve => document.querySelector('#referenceDialog').addEventListener('close', resolve, {once: true}));
  });
  if (action === 'escape') await page.locator('#labelComment').press('Escape');
  else await page.locator({save: '#saveReferenceLink', cancel: '#cancelReferenceLink', x: '#closeReferenceDialog'}[action]).click();
  await page.evaluate(() => window.__commentDialogClosed);
  await page.locator('#referenceDialog').waitFor({state: 'hidden'});
  await page.waitForFunction(() => document.querySelector('#referenceEditorHost').dataset.refReady === 'false');
}
async function download(pending) {
  const item = await pending, stream = await item.createReadStream(), chunks = [];
  for await (const chunk of stream) chunks.push(chunk);
  return {name: item.suggestedFilename(), buffer: Buffer.concat(chunks)};
}
async function save() {
  const pending = page.waitForEvent('download'); await page.locator('#saveProject').click();
  const saved = await download(pending); await page.waitForTimeout(725);
  return {...saved, data: JSON.parse(saved.buffer.toString())};
}
async function reopen(saved) {
  await page.locator('#projectInput').setInputFiles({name: saved.name, mimeType: 'application/json', buffer: saved.buffer});
  await idle();
  await page.waitForFunction(count => document.querySelectorAll('.layer-row').length === count, saved.data.layers.length);
}
async function add(photos) {
  await page.locator('#referenceFileInput').setInputFiles(photos.map(file));
  await page.waitForFunction(() => !document.body.classList.contains('busy') && document.querySelector('#referenceEditorHost').dataset.refReady === 'true');
}
async function selectLayer(id) { await page.locator(`.layer-row[data-id="${id}"]`).click(); }
const commentLayer = data => data.layers.find(layer => layer.referenceComment);
const sha = buffer => createHash('sha256').update(buffer).digest('hex');
async function unloadWarning() {
  return page.evaluate(() => { const event = new Event('beforeunload', {cancelable: true}); dispatchEvent(event); return event.defaultPrevented; });
}
async function pngDigest(bytes) {
  return page.evaluate(async bytes => {
    const bitmap = await createImageBitmap(new Blob([new Uint8Array(bytes)], {type: 'image/png'}));
    const canvas = document.createElement('canvas'); canvas.width = bitmap.width; canvas.height = bitmap.height;
    const ctx = canvas.getContext('2d'); ctx.drawImage(bitmap, 0, 0); bitmap.close();
    const hash = [...new Uint8Array(await crypto.subtle.digest('SHA-256', ctx.getImageData(0, 0, canvas.width, canvas.height).data))].map(x => x.toString(16).padStart(2, '0')).join('');
    return {width: canvas.width, height: canvas.height, hash};
  }, bytes);
}
// Independent central-directory ZIP reader; never use the app's archive reader/writer to validate exports.
function zipEntries(zip) {
  let end = zip.length - 22;
  while (end >= Math.max(0, zip.length - 65557) && zip.readUInt32LE(end) !== 0x06054b50) end--;
  assert.ok(end >= 0); let cursor = zip.readUInt32LE(end + 16); const entries = new Map();
  for (let count = zip.readUInt16LE(end + 10); count > 0; count--) {
    assert.equal(zip.readUInt32LE(cursor), 0x02014b50);
    const method = zip.readUInt16LE(cursor + 10), size = zip.readUInt32LE(cursor + 20);
    const nameLength = zip.readUInt16LE(cursor + 28), extraLength = zip.readUInt16LE(cursor + 30), commentLength = zip.readUInt16LE(cursor + 32), offset = zip.readUInt32LE(cursor + 42);
    const name = zip.subarray(cursor + 46, cursor + 46 + nameLength).toString();
    const start = offset + 30 + zip.readUInt16LE(offset + 26) + zip.readUInt16LE(offset + 28), payload = zip.subarray(start, start + size);
    assert.ok(method === 0 || method === 8); entries.set(name, method === 8 ? inflateRawSync(payload) : payload);
    cursor += 46 + nameLength + extraLength + commentLength;
  }
  return entries;
}

test('manual labels accept multiline native pasted comments without photos and keep them editable through duplicate and reopen', async () => {
  await open(); assert.equal(await page.locator('#labelComment').isVisible(), true);
  assert.equal(await page.locator('#labelComment').isDisabled(), false);
  assert.equal(await page.locator('#labelComment').getAttribute('maxlength'), '2000');
  await page.locator('#labelComment').fill('Keep the blockout camera.');
  await page.locator('#labelComment').press('Enter');
  await page.locator('#labelComment').pressSequentially('Apply snow only here.');
  await page.evaluate(() => navigator.clipboard.writeText('\nPreserve the silhouette.'));
  await page.locator('#labelComment').press('Control+v');
  const comment = 'Keep the blockout camera.\nApply snow only here.\nPreserve the silhouette.';
  assert.equal(await page.locator('#labelComment').inputValue(), comment);
  assert.match(await page.locator('#labelCommentCount').innerText(), new RegExp(String(comment.length) + '\\s*/\\s*2000'));
  assert.equal(await page.locator('#referenceDialog').isVisible(), true, 'Enter and native text paste do not submit or import a photo');
  assert.equal(await page.locator('#referenceGallery [data-reference-key]').count(), 0);
  assert.equal(await page.locator('.layer-row').count(), 2);
  await close('save'); const original = await save();
  assert.equal(commentLayer(original.data).referenceComment, comment); assert.equal(original.data.references.length, 0);
  assert.equal(await page.locator('#copyReferencesTop').isDisabled(), false);
  assert.equal(await page.locator('#completeReferencePackTop').isDisabled(), false);
  await page.locator('#duplicateLayer').click(); const duplicate = await save();
  assert.deepEqual(duplicate.data.layers.filter(layer => layer.kind === 'text').map(layer => layer.referenceComment), [comment, comment]);
  await page.locator('#deleteLayer').click(); await page.locator('#undo').click();
  assert.deepEqual((await save()).data, duplicate.data, 'Undo restores the duplicate with its own instruction');
  await reopen(original); await selectLayer(commentLayer(original.data).id);
  await page.locator('#editTextLayer').click(); await page.locator('#textEditor').fill('2'); await page.locator('#textEditor').press('Enter');
  const edited = await save(); assert.equal(commentLayer(edited.data).text.content, '2');
  assert.equal(commentLayer(edited.data).referenceComment, comment, 'Editing the visible number preserves its comment');
  await open(); assert.equal(await page.locator('#labelComment').inputValue(), comment); await close();
  assert.equal(edited.data.assets[edited.data.original.assetId].source, main.source);
});

test('Cancel, close X and Escape discard comment drafts and a clean project warns only while an unsaved comment remains', async () => {
  const baseline = await save(); assert.equal(await unloadWarning(), false);
  for (const action of ['cancel', 'x', 'escape']) {
    await open(); await page.locator('#labelComment').fill('Discard via ' + action);
    assert.equal(await unloadWarning(), true, 'A comment-only modal draft protects a previously saved project');
    if (action === 'cancel') {
      const pending = page.waitForEvent('dialog'), reload = page.reload({timeout: 5000}).catch(error => error);
      const warning = await pending; assert.equal(warning.type(), 'beforeunload'); await warning.dismiss(); await reload;
      assert.equal(await page.locator('#labelComment').inputValue(), 'Discard via cancel', 'Dismissing a real browser reload keeps the draft');
    }
    await close(action); assert.equal(await unloadWarning(), false);
    assert.deepEqual((await save()).data, baseline.data, action + ' leaves no comment or photo changes');
  }
  await open(); await page.locator('#labelComment').fill('Committed instruction'); await close('save');
  assert.equal(await unloadWarning(), true, 'Save changes makes the editable document dirty');
  const committed = await save(); assert.equal(await unloadWarning(), false);
  await page.locator('#undo').click(); assert.equal((await save()).data.layers[1].referenceComment, undefined);
  await page.locator('#redo').click(); assert.deepEqual((await save()).data, committed.data);
});

test('an automatically numbered object accepts comment-only instructions and reopens them by region after project reload', async () => {
  await page.locator('#autoDetect').click();
  await page.waitForFunction(() => document.querySelector('#detectionStatus').dataset.state === 'ready');
  const p = await point(100, 130); await page.mouse.click(p.x, p.y);
  await page.locator('#referenceDialog').waitFor({state: 'visible'});
  assert.equal(await page.locator('#referenceGallery [data-reference-key]').count(), 0);
  await page.locator('#labelComment').fill('Turn this object into a carved wooden chair.'); await close('save');
  const saved = await save(), object = saved.data.layers.find(layer => layer.objectRegion);
  assert.equal(object.text.content, '2', 'Manual number 1 is respected');
  assert.equal(object.referenceComment, 'Turn this object into a carved wooden chair.');
  assert.equal(object.referenceIds, undefined); assert.equal(saved.data.references.length, 0);
  assert.equal(saved.data.assets[saved.data.original.assetId].source, main.source);
  assert.equal(await page.locator('#copyReferencesTop').isDisabled(), false);
  await reopen(saved); await page.locator('.toolrail [data-tool=move]').click();
  const q = await point(100, 130); await page.mouse.click(q.x, q.y);
  await page.locator('#referenceDialog').waitFor({state: 'visible'});
  assert.equal(await page.locator('#labelComment').inputValue(), object.referenceComment); await close();
  assert.deepEqual((await save()).data, saved.data);
  assert.equal(detectionCalls.length, 1, 'Saved region comments need no second local inference');
});

test('area comments stay independent of shared photo notes and removing every link retains the area instruction', async () => {
  const photo = await fixture('Shared surface.png', '#77aa99');
  await open(); await page.locator('#labelComment').fill('Number 1: make the seat wider.');
  await add([photo]); await page.locator('#referenceNotes').fill('Photo: use this rough wood grain.');
  for (const viewport of [{width: 1280, height: 800}, {width: 1672, height: 941}]) {
    await page.setViewportSize(viewport); await page.locator('#referenceNotes').scrollIntoViewIfNeeded();
    for (const id of ['referenceNotes', 'saveReferenceLink', 'cancelReferenceLink']) {
      const bounds = await page.locator('#' + id).evaluate(element => {
        const r = element.getBoundingClientRect(), d = document.querySelector('#referenceDialog').getBoundingClientRect();
        return {left: r.left, top: r.top, right: r.right, bottom: r.bottom, dl: d.left, dt: d.top, dr: d.right, db: d.bottom,
          hit: element.contains(document.elementFromPoint(r.x + r.width / 2, r.bottom - 2))};
      });
      assert.ok(bounds.left >= bounds.dl && bounds.top >= bounds.dt && bounds.right <= bounds.dr && bounds.bottom <= bounds.db && bounds.hit, `${id} remains accessible with both area comments and photo notes at ${viewport.width}px`);
    }
    await page.screenshot({path: path.join(qa, `label-comment-photo-${viewport.width}.png`)});
  }
  await close('save');
  const first = await save(), firstLabel = commentLayer(first.data), ref = first.data.references[0];
  await label('2', 200, 100); await open(); await page.locator('#labelComment').fill('Number 2: keep the narrow legs.');
  await page.locator('#referenceChoice').selectOption(ref.id);
  await page.waitForFunction(() => document.querySelector('#referenceEditorHost').dataset.refReady === 'true');
  assert.equal(await page.locator('#referenceNotes').inputValue(), ref.notes);
  await page.locator('#referenceNotes').fill('Photo: preserve these knots on every use.'); await close('save');
  const shared = await save();
  assert.deepEqual(shared.data.layers.filter(layer => layer.kind === 'text').map(layer => layer.referenceComment), ['Number 1: make the seat wider.', 'Number 2: keep the narrow legs.']);
  assert.equal(shared.data.references.length, 1); assert.equal(shared.data.references[0].notes, 'Photo: preserve these knots on every use.');
  assert.equal(shared.data.references[0].source, photo.source);
  await selectLayer(firstLabel.id); await open();
  assert.equal(await page.locator('#labelComment').inputValue(), firstLabel.referenceComment);
  assert.equal(await page.locator('#referenceNotes').inputValue(), shared.data.references[0].notes);
  await page.locator('#unlinkReference').click();
  assert.equal(await page.locator('#referenceNotes').isVisible(), false);
  assert.equal(await page.locator('#labelComment').inputValue(), firstLabel.referenceComment);
  await close('save'); const unlinked = await save();
  assert.equal(unlinked.data.layers.find(layer => layer.id === firstLabel.id).referenceIds, undefined);
  assert.equal(unlinked.data.layers.find(layer => layer.id === firstLabel.id).referenceComment, firstLabel.referenceComment);
  await page.locator('#undo').click(); assert.deepEqual((await save()).data, shared.data);
  // With just one comment-only label, clearing the comment removes export eligibility without deleting the label.
  await reopen(first); await selectLayer(firstLabel.id); await open(); await page.locator('#unlinkReference').click();
  await page.locator('#labelComment').fill(''); await close('save'); const cleared = await save();
  assert.equal(cleared.data.layers[1].referenceComment, undefined); assert.equal(cleared.data.layers[1].text.content, '1');
  assert.equal(await page.locator('#copyReferencesTop').isDisabled(), true);
  assert.equal(await page.locator('#completeReferencePackTop').isDisabled(), true);
  assert.equal(cleared.data.references[0].source, photo.source, 'Unlinking never deletes the embedded original photo');
});

test('comment instructions render as real pixels in copied and downloaded boards and stay accessible at compact and wide layouts', async () => {
  const comment = 'Keep the blockout camera.\nSnow only on this object.';
  await open(); await page.locator('#labelComment').fill(comment);
  for (const viewport of [{width: 1280, height: 800}, {width: 1672, height: 941}]) {
    await page.setViewportSize(viewport); await page.locator('#labelComment').scrollIntoViewIfNeeded();
    for (const id of ['labelComment', 'saveReferenceLink', 'cancelReferenceLink']) {
      const bounds = await page.locator('#' + id).evaluate(element => {
        const r = element.getBoundingClientRect(), d = document.querySelector('#referenceDialog').getBoundingClientRect();
        return {left: r.left, top: r.top, right: r.right, bottom: r.bottom, dl: d.left, dt: d.top, dr: d.right, db: d.bottom, vw: innerWidth, vh: innerHeight,
          hit: element.contains(document.elementFromPoint(r.x + r.width / 2, r.bottom - 2))};
      });
      assert.ok(bounds.left >= bounds.dl && bounds.top >= bounds.dt && bounds.right <= Math.min(bounds.dr, bounds.vw) && bounds.bottom <= Math.min(bounds.db, bounds.vh) && bounds.hit, `${id} is accessible inside the ${viewport.width}px modal: ${JSON.stringify(bounds)}`);
    }
    await page.screenshot({path: path.join(qa, `label-comment-${viewport.width}.png`)});
  }
  await close('save'); const saved = await save();
  const expected = await page.evaluate(async project => {
    const module = await import('/reference-board.mjs'), layouts = module.referenceBoardPages(project);
    window.__commentTextCalls = []; window.__nativeFillText = CanvasRenderingContext2D.prototype.fillText;
    CanvasRenderingContext2D.prototype.fillText = function(text, x, y, ...rest) {
      window.__commentTextCalls.push(String(text)); return window.__nativeFillText.call(this, text, x, y, ...rest);
    };
    const blobs = await module.exportReferenceBoards(project);
    return {frames: layouts.flatMap(layout => layout.tiles.filter(tile => tile.kind === 'comment').map(tile => tile.notesFrame)), lines: layouts.flatMap(layout => layout.tiles.filter(tile => tile.kind === 'comment').flatMap(tile => tile.noteLines)), bytes: [...new Uint8Array(await blobs[0].arrayBuffer())], pages: blobs.length};
  }, saved.data);
  assert.equal(expected.pages, 1); assert.equal(expected.lines.join('\n'), comment); assert.equal(expected.frames.length, 1);
  const expectedHash = await pngDigest(expected.bytes);
  await page.locator('#copyReferencesTop').click();
  await page.waitForFunction(() => /copied/i.test(document.querySelector('#toast').textContent) && !document.querySelector('#copyReferencesTop').disabled);
  const copied = await page.evaluate(async () => {
    const item = (await navigator.clipboard.read()).find(item => item.types.includes('image/png'));
    return [...new Uint8Array(await (await item.getType('image/png')).arrayBuffer())];
  });
  assert.deepEqual(await pngDigest(copied), expectedHash);
  const rendered = await page.evaluate(async ({bytes, frames}) => {
    const bitmap = await createImageBitmap(new Blob([new Uint8Array(bytes)], {type: 'image/png'}));
    const canvas = document.createElement('canvas'); canvas.width = bitmap.width; canvas.height = bitmap.height;
    const ctx = canvas.getContext('2d'); ctx.drawImage(bitmap, 0, 0); bitmap.close();
    return {text: window.__commentTextCalls, dark: frames.map(frame => {
      const data = ctx.getImageData(Math.floor(frame.x), Math.floor(frame.y), Math.ceil(frame.width), Math.ceil(frame.height)).data;
      let count = 0; for (let i = 0; i < data.length; i += 4) if (data[i] < 180 && data[i + 1] < 180 && data[i + 2] < 180 && data[i + 3] === 255) count++;
      return count;
    })};
  }, {bytes: copied, frames: expected.frames});
  for (const line of comment.split('\n')) assert.ok(rendered.text.includes(line));
  assert.ok(rendered.dark.every(count => count > 40), 'Comment frames contain actual opaque instruction glyphs');
  const p = await point(350, 240); await page.mouse.click(p.x, p.y, {button: 'right'});
  const pending = page.waitForEvent('download'); await page.locator('#downloadReferenceBoard').click();
  const downloaded = await download(pending); assert.match(downloaded.name, /\.png$/i);
  assert.deepEqual(await pngDigest([...downloaded.buffer]), expectedHash);
  await page.evaluate(() => { CanvasRenderingContext2D.prototype.fillText = window.__nativeFillText; });
  assert.deepEqual((await save()).data, saved.data, 'Sharing keeps editable comment and original MAIN bytes unchanged');
});

test('Complete reference packs retain comment-only number mappings, clean MAIN bytes and unassigned original photos', async () => {
  const photo = await fixture('Unused original.png', '#0000ff'), comment = 'Use pale oak for number 1.\nPreserve this exact camera angle.';
  await open(); await add([photo]); await page.locator('#referenceNotes').fill('Retain this original photo note.');
  await page.locator('#labelComment').fill(comment); await close('save');
  await open(); await page.locator('#unlinkReference').click(); await close('save'); const saved = await save();
  const pending = page.waitForEvent('download'); await page.locator('#completeReferencePackTop').click();
  const pack = await download(pending), entries = zipEntries(pack.buffer), mapping = JSON.parse(entries.get('mapping.json').toString());
  assert.match(pack.name, /Complete reference pack\.zip$/i);
  assert.equal(mapping.numbers.length, 1); assert.equal(mapping.numbers[0].label, '1');
  assert.equal(mapping.numbers[0].comment, comment); assert.deepEqual(mapping.numbers[0].references, []);
  assert.deepEqual(entries.get(mapping.cleanMain.path), main.buffer, 'Clean MAIN has no app-added number or comment overlays');
  assert.equal(mapping.cleanMain.sha256, sha(main.buffer)); assert.deepEqual([mapping.cleanMain.width, mapping.cleanMain.height], [480, 320]);
  assert.equal(mapping.unassignedReferences.length, 1);
  const unassigned = mapping.unassignedReferences[0];
  assert.deepEqual(entries.get(unassigned.path), photo.buffer); assert.equal(unassigned.sha256, sha(photo.buffer));
  assert.equal(unassigned.notes, 'Retain this original photo note.');
  assert.equal(mapping.generatedPreviews.length, 1); assert.ok(entries.has(mapping.generatedPreviews[0].path));
  const expectedBoard = await page.evaluate(async project => [...new Uint8Array(await (await (await import('/reference-board.mjs')).exportReferenceBoard(project)).arrayBuffer())], saved.data);
  assert.deepEqual(await pngDigest([...entries.get(mapping.generatedPreviews[0].path)]), await pngDigest(expectedBoard));
  await reopen(saved); await selectLayer(commentLayer(saved.data).id); await open();
  assert.equal(await page.locator('#labelComment').inputValue(), comment); assert.equal(await page.locator('#referenceGallery [data-reference-key]').count(), 0);
  await close(); assert.deepEqual((await save()).data, saved.data);
});
