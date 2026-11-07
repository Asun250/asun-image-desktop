import {offlineGeneration} from './fixtures/offline-generation.mjs';
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import sharp from 'sharp';
import { inflateRawSync } from 'node:zlib';
import path from 'node:path';
import { chromium } from 'playwright';
import { createServer, BUILD } from '../server.mjs';
import { legacyProjectFixture } from './fixtures/legacy-project.mjs';

import {missingAssetReason} from './fixtures/optional-assets.mjs';
const artworkSkip = missingAssetReason(['branding/husky-source.png','public/asun-img-husky.ico','public/asun-img-icon-192.png','public/asun-img-icon-512.png','public/startup.gif','public/main-logo.gif','public/main-logo-transparent.gif']);
const assetTest = (name, body) => test(name, {skip:artworkSkip}, body);

const qa = path.resolve('qa', 'app-brand'), results = [];
const sourcePath = new URL('../branding/husky-source.png', import.meta.url);
const sourceHash = 'adfd98d192397752ec7d79bada37b08ae9b0a755f993218bd9da2b716220b0ea';
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
let server, browser, base, source, sourcePixels;

before(async () => {
  await mkdir(qa, { recursive: true });
  if (!artworkSkip) { source = await readFile(sourcePath); sourcePixels = await sharp(source).ensureAlpha().raw().toBuffer({ resolveWithObject: true }); }
  server = createServer(offlineGeneration()); await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${server.address().port}`; browser = await chromium.launch({ headless: true });
});
after(async () => {
  await writeFile(path.join(qa, 'report.json'), JSON.stringify({ sourcePath: 'branding/husky-source.png', sourceSha256: source && sha(source), sourceBytes: source?.length, sourceDimensions: sourcePixels && { width: sourcePixels.info.width, height: sourcePixels.info.height }, detector: 'Status stub; no inference', results }, null, 2));
  await browser?.close(); if (server) await new Promise(resolve => server.close(resolve));
});

async function served(name, type) {
  const response = await fetch(base + '/' + name); assert.equal(response.status, 200, `${name} is served`);
  assert.equal(response.headers.get('content-type')?.split(';')[0], type);
  return Buffer.from(await response.arrayBuffer());
}
async function decodePng(bytes) { return sharp(bytes).ensureAlpha().raw().toBuffer({ resolveWithObject: true }); }

// Decode the Windows XOR/AND planes independently. The small frames use native
// bottom-up BGRA DIBs; the 256px frame is a PNG payload.
async function icoFrames(bytes) {
  assert.deepEqual([bytes.readUInt16LE(0), bytes.readUInt16LE(2)], [0, 1]);
  const count = bytes.readUInt16LE(4), frames = [], ranges = [];
  for (let index = 0; index < count; index++) {
    const offset = 6 + index * 16, width = bytes[offset] || 256, height = bytes[offset + 1] || 256;
    const length = bytes.readUInt32LE(offset + 8), start = bytes.readUInt32LE(offset + 12);
    assert.equal(width, height); assert.equal(bytes.readUInt16LE(offset + 4), 1); assert.equal(bytes.readUInt16LE(offset + 6), 32);
    assert.ok(start >= 6 + count * 16 && start + length <= bytes.length); ranges.push([start, start + length]);
    const payload = bytes.subarray(start, start + length); let decoded, kind;
    if (payload.subarray(0, 8).toString('hex') === '89504e470d0a1a0a') { decoded = await decodePng(payload); kind = 'png'; }
    else {
      kind = 'dib'; assert.equal(payload.readUInt32LE(0), 40);
      assert.deepEqual([payload.readInt32LE(4), payload.readInt32LE(8), payload.readUInt16LE(12), payload.readUInt16LE(14), payload.readUInt32LE(16)], [width, height * 2, 1, 32, 0]);
      const maskStride = Math.ceil(width / 32) * 4, maskStart = 40 + width * height * 4;
      assert.equal(payload.length, maskStart + maskStride * height, 'DIB XOR pixels and padded AND mask occupy the whole frame');
      const data = Buffer.alloc(width * height * 4);
      for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
        const input = 40 + ((height - 1 - y) * width + x) * 4, output = (y * width + x) * 4;
        const masked = payload[maskStart + (height - 1 - y) * maskStride + Math.floor(x / 8)] & (128 >> (x % 8));
        data[output] = payload[input + 2]; data[output + 1] = payload[input + 1]; data[output + 2] = payload[input]; data[output + 3] = masked ? 0 : payload[input + 3];
      }
      decoded = { data, info: { width, height, channels: 4 } };
    }
    assert.deepEqual([decoded.info.width, decoded.info.height, decoded.info.channels], [width, height, 4]);
    frames.push({ width, height, kind, decoded });
  }
  ranges.sort((a, b) => a[0] - b[0]); for (let index = 1; index < ranges.length; index++) assert.ok(ranges[index][0] >= ranges[index - 1][1], 'Icon frames never overlap');
  return frames;
}
function palette(data) { const values = new Set(); for (let offset = 0; offset < data.length; offset += 4) if (data[offset + 3]) values.add(data[offset] * 65536 + data[offset + 1] * 256 + data[offset + 2]); return values; }
function pixelAudit(decoded, nativeColors) {
  let dark = 0, pink = 0, light = 0, changed = 0, transparent = 0;
  for (let offset = 0; offset < decoded.data.length; offset += 4) {
    const [r, g, b, a] = decoded.data.subarray(offset, offset + 4); if (!a) { transparent++; continue; }
    if (!nativeColors.has(r * 65536 + g * 256 + b)) changed++;
    if (r < 70 && g < 70 && b < 80) dark++;
    if (r > 140 && r > g * 1.2 && b > g * 1.2) pink++;
    if (r > 210 && g > 205 && b > 190) light++;
  }
  assert.equal(changed, 0, 'Every opaque RGB comes from the supplied pixel artwork');
  assert.ok(dark > 0 && pink > 0 && light > 0, 'Dark fur, pink scarf and light face remain visible at this size');
  return { dark, pink, light, changed, transparent };
}
function darkBounds(decoded) {
  let left = Infinity, top = Infinity, right = -Infinity, bottom = -Infinity;
  for (let y = 0; y < decoded.info.height; y++) for (let x = 0; x < decoded.info.width; x++) {
    const offset = (y * decoded.info.width + x) * 4, d = decoded.data;
    if (d[offset + 3] && d[offset] < 70 && d[offset + 1] < 70 && d[offset + 2] < 80) { left = Math.min(left, x); top = Math.min(top, y); right = Math.max(right, x); bottom = Math.max(bottom, y); }
  }
  return { left, top, right, bottom, width: right - left + 1, height: bottom - top + 1 };
}

assetTest('supplied pixel husky is preserved and every native Windows icon size and PNG serves valid unchanged colors', async () => {
  assert.equal(sha(source), sourceHash, 'The committed source retains the approved artwork hash');
  assert.deepEqual([sourcePixels.info.width, sourcePixels.info.height], [732, 790]);
  const nativeColors = palette(sourcePixels.data), icon = await served('asun-img-husky.ico', 'image/x-icon'), frames = await icoFrames(icon);
  assert.deepEqual(frames.map(frame => frame.width), [16, 24, 32, 48, 64, 128, 256]);
  assert.deepEqual(frames.map(frame => frame.kind), ['dib', 'dib', 'dib', 'dib', 'dib', 'dib', 'png']);
  const sizes = frames.map(frame => ({ width: frame.width, kind: frame.kind, ...pixelAudit(frame.decoded, nativeColors) }));
  const pngs = [];
  for (const size of [192, 512]) {
    const png = await served(`asun-img-icon-${size}.png`, 'image/png'), decoded = await decodePng(png);
    assert.deepEqual([decoded.info.width, decoded.info.height], [size, size]);
    const shape = darkBounds(decoded), originalShape = darkBounds(sourcePixels);
    assert.ok(Math.abs(shape.width / shape.height - originalShape.width / originalShape.height) < .025, 'The husky silhouette is not stretched to a square');
    pngs.push({ width: size, bytes: png.length, shape, ...pixelAudit(decoded, nativeColors) });
    await writeFile(path.join(qa, `app-icon-${size}.png`), png);
  }
  results.push({ test: 'native-icon-assets', status: 'passed', sourceSha256: sha(source), icoSha256: sha(icon), sizes, pngs });
});

assetTest('icon/name update preserves every startup and header animation byte', async () => {
  const hashes = {};
  for (const [name, expected] of [['startup.gif', 'b950d7ff5175da54b0f691d7b208b71af5313480570c8f826c8e833c13235356'], ['main-logo.gif', '63e29b61a8d17ae4aee9732391cd8b9aa111df515485d79e9352718c7c42f55d'], ['main-logo-transparent.gif', '5e14eaed7a0d18873fd03507e0c78d768a5b7e60e7acbb4c6d4ab37069e751cb']]) {
    hashes[name] = sha(await served(name, 'image/gif')); assert.equal(hashes[name], expected);
  }
  results.push({ test: 'preserved-animation-assets', status: 'passed', hashes });
});

async function open(theme = 'light', skip = true) {
  const context = await browser.newContext({ viewport: { width: 1672, height: 941 }, acceptDownloads: true });
  await context.addInitScript(theme => localStorage.setItem('asun-image-appearance', theme), theme);
  const page = await context.newPage(), errors = [], calls = [];
  page.on('pageerror', error => errors.push(error.message));
  page.on('request', request => { if (![base, 'blob:', 'data:'].some(prefix => request.url().startsWith(prefix))) errors.push('Unexpected remote request: ' + request.url()); });
  await page.route('**/api/local-detection/status', route => route.fulfill({ json: { available: false, message: 'Isolated branding QA' } }));
  await page.route('**/api/local-detection', async route => { calls.push(route.request().url()); await route.abort(); });
  try {
    await page.goto(base, { waitUntil: 'domcontentloaded' });
    if (skip) { await page.evaluate(() => document.querySelector('#skipStartup')?.click()); await ready(page); }
    return { page, context, errors, calls };
  } catch (error) { await context.close(); throw error; }
}
async function ready(page) { await page.waitForFunction(() => document.documentElement.dataset.ready === 'true' && document.documentElement.dataset.appearanceReady === 'true'); }
async function checked(name, theme, run, skip = true) {
  const session = await open(theme, skip);
  try { const evidence = await run(session); assert.deepEqual(session.errors, []); assert.deepEqual(session.calls, []); results.push({ test: name, status: 'passed', ...evidence }); }
  catch (error) { results.push({ test: name, status: 'failed', error: error.message }); await session.page.screenshot({ path: path.join(qa, 'failure-' + name + '.png') }).catch(() => {}); throw error; }
  finally { await session.context.close(); }
}
for (const theme of ['light', 'dark']) assetTest(`static, startup, accessible, footer and runtime branding is Asun IMG in ${theme}`, async () => checked('visible-brand-' + theme, theme, async ({ page }) => {
  const html = await (await fetch(base)).text(); assert.match(html, /<title>Asun IMG<\/title>/);
  assert.equal(await page.locator('meta[name="application-name"]').getAttribute('content'), 'Asun IMG');
  assert.equal(await page.locator('link[rel="icon"]').getAttribute('href'), 'asun-img-husky.ico');
  assert.equal(await page.locator('#startupScreen').getAttribute('aria-label'), 'Asun IMG startup');
  assert.equal(await page.locator('.startup-status').innerText(), 'Starting Asun IMG…');
  await page.locator('#skipStartup').click(); await ready(page);
  assert.equal(await page.title(), 'Untitled — Asun IMG'); assert.equal(await page.locator('.brand').getAttribute('aria-label'), 'Asun IMG');
  assert.equal(await page.locator('#brandAnimation').getAttribute('alt'), 'Asun IMG');
  assert.equal(await page.locator('.statusbar > span').last().innerText(), `Asun IMG ${BUILD}`);
  assert.equal(await page.locator('html').getAttribute('data-theme'), theme);
  await page.locator('#projectName').click(); await page.locator('#nameField').fill('Husky icon study'); await page.locator('#confirmDialog').click();
  assert.equal(await page.title(), 'Husky icon study — Asun IMG');
  const png = await page.evaluate(async () => { const response = await fetch('/asun-img-icon-192.png'); const bitmap = await createImageBitmap(await response.blob()); const dimensions = { width: bitmap.width, height: bitmap.height }; bitmap.close(); return dimensions; });
  assert.deepEqual(png, { width: 192, height: 192 });
  await page.waitForTimeout(800); await page.screenshot({ path: path.join(qa, theme + '-editor.png') });
  return { title: await page.title(), favicon: 'asun-img-husky.ico', png };
}, false));

async function download(pending) { const item = await pending, chunks = []; for await (const chunk of await item.createReadStream()) chunks.push(chunk); return { name: item.suggestedFilename(), buffer: Buffer.concat(chunks) }; }
async function save(page) { const pending = page.waitForEvent('download'); await page.locator('#saveProject').click(); const saved = await download(pending); await page.waitForTimeout(725); return { ...saved, data: JSON.parse(saved.buffer.toString()) }; }
async function idle(page) { await page.waitForFunction(() => !document.body.classList.contains('busy')); }
async function fixture(page, name, color, width = 320, height = 240) {
  const source = await page.evaluate(({ color, width, height }) => { const canvas = document.createElement('canvas'); canvas.width = width; canvas.height = height; const context = canvas.getContext('2d'); context.fillStyle = color; context.fillRect(0, 0, width, height); return canvas.toDataURL('image/png'); }, { color, width, height });
  const buffer = Buffer.from(source.split(',')[1], 'base64'); return { name, source, width, height, buffer, originalFile: { name, mimeType: 'image/png', byteLength: buffer.length } };
}
async function pixels(page, bytes, points) {
  return page.evaluate(async ({ bytes, points }) => { const bitmap = await createImageBitmap(new Blob([new Uint8Array(bytes)])); const canvas = document.createElement('canvas'); canvas.width = bitmap.width; canvas.height = bitmap.height; const context = canvas.getContext('2d'); context.drawImage(bitmap, 0, 0); bitmap.close(); return { width: canvas.width, height: canvas.height, pixels: points.map(([x, y]) => [...context.getImageData(x, y, 1, 1).data]) }; }, { bytes: [...bytes], points });
}
function archive(bytes) {
  let end = bytes.length - 22; while (end >= Math.max(0, bytes.length - 65557) && bytes.readUInt32LE(end) !== 0x06054b50) end--; assert.ok(end >= 0);
  let cursor = bytes.readUInt32LE(end + 16); const entries = new Map();
  for (let count = bytes.readUInt16LE(end + 10); count > 0; count--) {
    assert.equal(bytes.readUInt32LE(cursor), 0x02014b50);
    const method = bytes.readUInt16LE(cursor + 10), compressedSize = bytes.readUInt32LE(cursor + 20), size = bytes.readUInt32LE(cursor + 24), nameLength = bytes.readUInt16LE(cursor + 28), extraLength = bytes.readUInt16LE(cursor + 30), commentLength = bytes.readUInt16LE(cursor + 32), offset = bytes.readUInt32LE(cursor + 42), name = bytes.subarray(cursor + 46, cursor + 46 + nameLength).toString();
    assert.equal(bytes.readUInt32LE(offset), 0x04034b50); const start = offset + 30 + bytes.readUInt16LE(offset + 26) + bytes.readUInt16LE(offset + 28), compressed = bytes.subarray(start, start + compressedSize);
    assert.ok(method === 0 || method === 8); const data = method === 8 ? inflateRawSync(compressed) : compressed; assert.equal(data.length, size); assert.ok(!entries.has(name)); entries.set(name, data); cursor += 46 + nameLength + extraLength + commentLength;
  }
  assert.ok(entries.has('mapping.json')); return { entries, mapping: JSON.parse(entries.get('mapping.json')) };
}

test('previous-release edited .asun projects retain sources, masks, notes and export compatibility under the new name', async () => checked('legacy-project-roundtrip', 'light', async ({ page }) => {
  const main = await fixture(page, 'Original MAIN.png', '#ff0000'), reference = await fixture(page, 'Original reference.png', '#0000ff', 160, 120);
  const project = legacyProjectFixture(main, reference), raster = { layerId: project.layers[0].id, project };
  const oldBuffer = Buffer.from(JSON.stringify(project));
  await page.locator('#projectInput').setInputFiles({ name: 'Legacy.asun', mimeType: 'application/json', buffer: oldBuffer }); await idle(page);
  await page.waitForFunction(() => document.querySelectorAll('.layer-row').length === 2);
  assert.equal(await page.title(), 'Asun image archive (user title) — Asun IMG');
  assert.deepEqual((await save(page)).data, JSON.parse(oldBuffer.toString()), 'A rename of the app never rewrites old user project content');
  await page.locator(`.layer-row[data-id="${raster.layerId}"]`).click(); await page.locator('[data-tool="mask"]').click();
  const board = await page.locator('#board').boundingBox(); await page.mouse.click(board.x + board.width * .75, board.y + board.height * .75);
  await page.locator('#projectName').click(); await page.locator('#nameField').fill('Husky compatibility study'); await page.locator('#confirmDialog').click();
  const saved = await save(page); assert.equal(saved.name, 'Husky compatibility study.asun'); assert.equal(saved.data.format, 'asun-image'); assert.equal(saved.data.version, 3); assert.equal(saved.data.layers[0].mask.length, 2);
  assert.equal(saved.data.assets[raster.project.original.assetId].source, main.source); assert.equal(saved.data.references[0].source, reference.source); assert.equal(saved.data.references[0].notes, project.references[0].notes);
  await page.locator('#newWorkflowTab').click(); await page.waitForFunction(() => document.querySelectorAll('.layer-row').length === 0);
  await page.locator('#projectInput').setInputFiles({ name: saved.name, mimeType: 'application/json', buffer: saved.buffer }); await idle(page); await page.waitForFunction(() => document.querySelectorAll('.layer-row').length === 2);
  assert.equal(await page.title(), 'Husky compatibility study — Asun IMG'); assert.deepEqual((await save(page)).data, saved.data);
  await page.locator('#export').click(); await page.locator('#formatField').selectOption('png'); const pending = page.waitForEvent('download'); await page.locator('#confirmDialog').click(); const exported = await download(pending);
  assert.equal(exported.name, 'Husky compatibility study.png'); const png = await pixels(page, exported.buffer, [[10, 200], [160, 120], [240, 180]]);
  assert.deepEqual(png, { width: 320, height: 240, pixels: [[255, 0, 0, 255], [0, 0, 0, 0], [0, 0, 0, 0]] });
  const packPending = page.waitForEvent('download'); await page.locator('#completeReferencePackTop').click(); const packed = await download(packPending); const pack = archive(packed.buffer); await idle(page);
  assert.equal(pack.mapping.format, 'asun-complete-reference-pack'); assert.equal(pack.mapping.version, 1); assert.equal(pack.mapping.project.name, saved.data.name);
  assert.deepEqual(pack.entries.get(pack.mapping.cleanMain.path), main.buffer); assert.deepEqual(pack.entries.get(pack.mapping.numbers[0].references[0].path), reference.buffer); assert.equal(pack.mapping.numbers[0].references[0].notes, project.references[0].notes);
  assert.deepEqual((await save(page)).data, saved.data, 'Exports preserve the editable project');
  await writeFile(path.join(qa, exported.name), exported.buffer); await writeFile(path.join(qa, saved.name), saved.buffer);
  return { legacyFormat: saved.data.format, projectFilename: saved.name, exportFilename: exported.name, png, packFormat: pack.mapping.format, originalMainSha256: sha(main.buffer), originalReferenceSha256: sha(reference.buffer) };
}));

test('invalid-project error uses the new app name and preserves current editable work', async () => checked('renamed-project-error', 'light', async ({ page }) => {
  const before = await save(page); await page.locator('#projectInput').setInputFiles({ name: 'Invalid.asun', mimeType: 'application/json', buffer: Buffer.from('{}') }); await idle(page);
  await page.waitForFunction(() => document.querySelector('#toast').classList.contains('error'));
  const error = await page.locator('#toast').innerText(); assert.match(error, /supported Asun IMG project/); assert.doesNotMatch(error, /Asun image/);
  assert.deepEqual((await save(page)).data, before.data); return { error, unchangedProject: true };
}));

test('new launcher and health response retain stable local application identity', async () => {
  const health = await (await fetch(base + '/health')).json(); assert.equal(health.app, 'asun-image-local-v1'); assert.equal(health.build, BUILD);
  const launcher = await readFile(new URL('../Launch Asun IMG.ps1', import.meta.url), 'utf8'); assert.match(launcher, /Asun IMG needs/); assert.match(launcher, /asun-image-local-v1/); assert.match(launcher, /48010\.\.48019/);
  const alias = await readFile(new URL('../Launch Asun image.ps1', import.meta.url), 'utf8'); assert.match(alias, /Launch Asun IMG\.ps1/);
  results.push({ test: 'launcher-and-local-identity', status: 'passed', health, primaryLauncher: 'Launch Asun IMG.ps1', oldLauncherAliasPreserved: true });
});
