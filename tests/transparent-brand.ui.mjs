import {offlineGeneration} from './fixtures/offline-generation.mjs';
import { test, before, after, describe } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import sharp from 'sharp';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { chromium } from 'playwright';
import { createServer } from '../server.mjs';

import {missingAssetReason} from './fixtures/optional-assets.mjs';

describe('Optional private artwork checks', {skip:missingAssetReason(["public/main-logo.gif","public/main-logo-transparent.gif"])}, () => {
const originalPath = fileURLToPath(new URL('../public/main-logo.gif', import.meta.url));
const transparentPath = fileURLToPath(new URL('../public/main-logo-transparent.gif', import.meta.url));
const qa = path.resolve('qa', 'transparent-brand'), results = [];
const originalHash = '63e29b61a8d17ae4aee9732391cd8b9aa111df515485d79e9352718c7c42f55d';
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
let server, browser, base, original, transparent, sourceMeta, outputMeta;

function gifMetadata(bytes) {
  assert.equal(bytes.toString('ascii', 0, 6), 'GIF89a');
  const result = { width: bytes.readUInt16LE(6), height: bytes.readUInt16LE(8), frames: [], loop: null, backgroundIndex: bytes[11] };
  let offset = 13, control = null;
  if (bytes[10] & 128) offset += 3 * 2 ** ((bytes[10] & 7) + 1);
  function subblocks() { const chunks = []; while (bytes[offset]) { const size = bytes[offset++]; assert.ok(offset + size <= bytes.length); chunks.push(bytes.subarray(offset, offset + size)); offset += size; } offset++; return Buffer.concat(chunks); }
  while (offset < bytes.length) {
    const kind = bytes[offset++];
    if (kind === 0x3b) break;
    if (kind === 0x21) {
      const label = bytes[offset++];
      if (label === 0xf9) { assert.equal(bytes[offset++], 4); control = { delayMs: bytes.readUInt16LE(offset + 1) * 10, disposal: (bytes[offset] >> 2) & 7, transparent: Boolean(bytes[offset] & 1), transparentIndex: bytes[offset + 3] }; offset += 4; assert.equal(bytes[offset++], 0); }
      else if (label === 0xff) { const size = bytes[offset++], id = bytes.toString('ascii', offset, offset + size); offset += size; const payload = subblocks(); if (['NETSCAPE2.0', 'ANIMEXTS1.0'].includes(id)) result.loop = payload.readUInt16LE(1); }
      else subblocks();
    } else if (kind === 0x2c) {
      const frame = { x: bytes.readUInt16LE(offset), y: bytes.readUInt16LE(offset + 2), width: bytes.readUInt16LE(offset + 4), height: bytes.readUInt16LE(offset + 6), ...control }, packed = bytes[offset + 8]; offset += 9;
      if (packed & 128) offset += 3 * 2 ** ((packed & 7) + 1);
      offset++; subblocks(); result.frames.push(frame); control = null;
    } else assert.fail('Unexpected GIF block ' + kind);
  }
  result.durationMs = result.frames.reduce((sum, frame) => sum + (frame.delayMs || 0), 0);
  return result;
}
before(async () => {
  await mkdir(qa, { recursive: true });
  original = await readFile(originalPath); transparent = await readFile(transparentPath);
  sourceMeta = gifMetadata(original); outputMeta = gifMetadata(transparent);
  server = createServer(offlineGeneration()); await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${server.address().port}`; browser = await chromium.launch({ headless: true });
});
after(async () => {
  await writeFile(path.join(qa, 'report.json'), JSON.stringify({ originalPath, transparentPath, originalSha256: original && sha(original), transparentSha256: transparent && sha(transparent), sourceMeta, outputMeta, detector: 'Status stub; no inference', results }, null, 2));
  await browser?.close(); if (server) await new Promise(resolve => server.close(resolve));
});

test('transparent GIF is served separately while all sixty original timings, the infinite loop and source bytes remain intact', async () => {
  assert.equal(sha(original), originalHash, 'The supplied source was never overwritten');
  const originalResponse = await fetch(base + '/main-logo.gif');
  assert.equal(originalResponse.status, 200);
  assert.equal(sha(Buffer.from(await originalResponse.arrayBuffer())), originalHash, 'The original release asset stays available unchanged');
  assert.notEqual(sha(transparent), originalHash, 'The cutout is a separate derived asset');
  assert.deepEqual([outputMeta.width, outputMeta.height], [sourceMeta.width, sourceMeta.height]);
  assert.equal(outputMeta.frames.length, 60); assert.equal(outputMeta.frames.length, sourceMeta.frames.length);
  assert.deepEqual(outputMeta.frames.map(frame => frame.delayMs), sourceMeta.frames.map(frame => frame.delayMs));
  assert.equal(outputMeta.durationMs, 4800); assert.equal(outputMeta.loop, 0);
  assert.ok(outputMeta.frames.some(frame => frame.transparent), 'The generated asset has a transparent palette entry');
  const response = await fetch(base + '/main-logo-transparent.gif');
  assert.equal(response.status, 200); assert.equal(response.headers.get('content-type')?.split(';')[0], 'image/gif');
  assert.equal(sha(Buffer.from(await response.arrayBuffer())), sha(transparent), 'The server delivers the derived GIF bytes');
  results.push({ test: 'asset-structure-and-original', status: 'passed', frames: outputMeta.frames.length, durationMs: outputMeta.durationMs, loop: outputMeta.loop });
});

test('all decoded animation frames retain native foreground pixels and clear the turquoise matte and green shadow without ghosts', async () => {
  const source = await sharp(original, { animated: true }).removeAlpha().raw().toBuffer({ resolveWithObject: true });
  const output = await sharp(transparent, { animated: true }).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  assert.equal(source.info.channels, 3); assert.equal(output.info.channels, 4);
  assert.deepEqual([output.info.width, output.info.height], [source.info.width, source.info.height]);
  assert.equal(output.info.height, sourceMeta.height * 60, 'All sixty coalesced frames are decoded');
  const area = sourceMeta.width * sourceMeta.height, frames = [];
  // Source palette analysis identifies the matte and shadow by strong green/cyan
  // chroma; grayscale fur, pink scarf, orange accents and dark text are retained.
  const isMatte = (r, g, b) => g >= 60 && g - r >= 25 && b - r >= 15 && g - b >= 8;
  for (let frame = 0; frame < 60; frame++) {
    let mattePixels = 0, foregroundPixels = 0, retainedMatte = 0, lostForeground = 0, changedForeground = 0;
    for (let pixel = frame * area; pixel < (frame + 1) * area; pixel++) {
      const a = pixel * 3, b = pixel * 4, r = source.data[a], g = source.data[a + 1], blue = source.data[a + 2];
      if (isMatte(r, g, blue)) { mattePixels++; if (output.data[b + 3] !== 0) retainedMatte++; }
      else { foregroundPixels++; if (output.data[b + 3] !== 255) lostForeground++; else if (output.data[b] !== r || output.data[b + 1] !== g || output.data[b + 2] !== blue) changedForeground++; }
    }
    frames.push({ frame: frame + 1, mattePixels, foregroundPixels, retainedMatte, lostForeground, changedForeground });
  }
  await writeFile(path.join(qa, 'native-frame-comparison.json'), JSON.stringify(frames, null, 2));
  assert.ok(frames.every(frame => frame.mattePixels > area / 2), 'Every composite includes the broad removable matte');
  assert.ok(frames.every(frame => frame.retainedMatte === 0), 'No turquoise background or green shadow survives');
  assert.ok(frames.every(frame => frame.lostForeground === 0), 'No husky or lettering disappears on cropped source updates/hold frames');
  assert.ok(frames.every(frame => frame.changedForeground === 0), 'Every retained foreground RGB value stays exact');
  results.push({ test: 'native-sixty-frame-comparison', status: 'passed', frames });
});

async function open(theme) {
  const context = await browser.newContext({ viewport: { width: 1672, height: 941 } });
  await context.addInitScript(theme => localStorage.setItem('asun-image-appearance', theme), theme);
  const page = await context.newPage(), errors = [], calls = [];
  page.on('pageerror', error => errors.push(error.message));
  page.on('request', request => { if (![base, 'data:', 'blob:'].some(prefix => request.url().startsWith(prefix))) errors.push('Unexpected remote request: ' + request.url()); });
  await page.route('**/api/local-detection/status', route => route.fulfill({ json: { available: false, message: 'Isolated transparent brand QA' } }));
  await page.route('**/api/local-detection', async route => { calls.push(route.request().url()); await route.abort(); });
  try { await page.goto(base); await page.locator('#skipStartup').click(); await page.waitForFunction(() => document.documentElement.dataset.ready === 'true' && document.documentElement.dataset.appearanceReady === 'true'); await page.locator('#brandAnimation').evaluate(image => image.decode()); return { context, page, errors, calls }; }
  catch (error) { await context.close(); throw error; }
}
for (const theme of ['light', 'dark']) test(`transparent logo blends into the ${theme} header and keeps playing after a full loop`, async () => {
  const { context, page, errors, calls } = await open(theme);
  try {
    const image = page.locator('#brandAnimation'), started = Date.now(), captures = [];
    assert.equal(await image.getAttribute('src'), 'main-logo-transparent.gif');
    assert.equal(await image.evaluate(image => image.naturalWidth), sourceMeta.width);
    assert.equal(await image.evaluate(image => image.naturalHeight), sourceMeta.height);
    const info = await page.locator('.header').evaluate(header => ({ background: getComputedStyle(header).backgroundColor }));
    const background = info.background.match(/[\d.]+/g).slice(0, 3).map(Number);
    async function capture(phase) {
      const hashes = [];
      for (let index = 0; index < 6; index++) {
        const bytes = await image.screenshot({ path: path.join(qa, `${theme}-${phase}-${index}.png`) });
        const decoded = await sharp(bytes).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
        for (const [x, y] of [[0, 0], [decoded.info.width - 1, 0], [0, decoded.info.height - 1], [decoded.info.width - 1, decoded.info.height - 1]]) {
          const p = (y * decoded.info.width + x) * 4;
          assert.ok(background.every((value, channel) => Math.abs(decoded.data[p + channel] - value) <= 2), 'Transparent image corners show the selected header background');
        }
        hashes.push(sha(bytes)); captures.push({ phase, index, elapsedMs: Date.now() - started, sha256: hashes.at(-1) });
        if (index < 5) await page.waitForTimeout(180);
      }
      assert.ok(new Set(hashes).size > 1, `${theme} ${phase}: real browser screenshots show changing GIF pixels`);
    }
    await capture('initial');
    await page.waitForTimeout(outputMeta.durationMs + 300);
    await capture('after-loop');
    for (const viewport of [{ width: 1672, height: 941 }, { width: 1080, height: 720 }]) {
      await page.setViewportSize(viewport);
      const box = await image.boundingBox();
      assert.ok(Math.abs(box.width / box.height - sourceMeta.width / sourceMeta.height) < .001, 'Transparent asset preserves the displayed aspect ratio');
      const hit = await page.locator('.brand').evaluate(brand => { const r = brand.getBoundingClientRect(); return brand.contains(document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2)); });
      assert.equal(hit, true, 'The brand remains a usable native link');
      await page.locator('.header').screenshot({ path: path.join(qa, `${theme}-${viewport.width}-header.png`) });
    }
    assert.deepEqual(errors, []); assert.deepEqual(calls, []);
    results.push({ test: theme + '-browser-compositing-and-loop', status: 'passed', headerBackground: info.background, captures });
  } catch (error) { results.push({ test: theme + '-browser-compositing-and-loop', status: 'failed', error: error.message }); throw error; }
  finally { await context.close(); }
});

});
