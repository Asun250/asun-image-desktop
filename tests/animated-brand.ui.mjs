import {offlineGeneration} from './fixtures/offline-generation.mjs';
import { test, before, after, describe } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { chromium } from 'playwright';
import { createServer } from '../server.mjs';

import {missingAssetReason} from './fixtures/optional-assets.mjs';

describe('Optional private artwork checks', {skip:missingAssetReason(["public/main-logo.gif","public/main-logo-transparent.gif"])}, () => {
const originalPath = fileURLToPath(new URL('../public/main-logo.gif', import.meta.url));
const qa = path.resolve('qa', 'animated-brand');
const viewports = [{ width: 1672, height: 941 }, { width: 1280, height: 800 }, { width: 1080, height: 720 }, { width: 2517, height: 1348 }];
const results = [];
let server, browser, base, gif;
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');

// Read structural GIF blocks; compressed image data is skipped, never rewritten.
function gifMetadata(bytes) {
  assert.match(bytes.toString('ascii', 0, 6), /^GIF8[79]a$/);
  const metadata = { width: bytes.readUInt16LE(6), height: bytes.readUInt16LE(8), frames: 0, delaysMs: [], loop: null };
  let offset = 13, delayMs = 0;
  if (bytes[10] & 0x80) offset += 3 * 2 ** ((bytes[10] & 7) + 1);
  const subBlocks = () => {
    const blocks = [];
    while (true) {
      assert.ok(offset < bytes.length, 'GIF sub-block terminates inside the file');
      const length = bytes[offset++];
      if (!length) return Buffer.concat(blocks);
      assert.ok(offset + length <= bytes.length, 'GIF sub-block remains inside the file');
      blocks.push(bytes.subarray(offset, offset + length)); offset += length;
    }
  };
  while (offset < bytes.length) {
    const block = bytes[offset++];
    if (block === 0x3b) break;
    if (block === 0x21) {
      const label = bytes[offset++];
      if (label === 0xf9) {
        assert.equal(bytes[offset++], 4, 'Graphic control extension has its standard size');
        delayMs = bytes.readUInt16LE(offset + 1) * 10; offset += 4;
        assert.equal(bytes[offset++], 0);
      } else if (label === 0xff) {
        const length = bytes[offset++], identifier = bytes.toString('ascii', offset, offset + length); offset += length;
        const data = subBlocks();
        if (identifier === 'NETSCAPE2.0' || identifier === 'ANIMEXTS1.0') {
          assert.equal(data[0], 1, 'Animation extension contains the loop-count sub-block');
          metadata.loop = data.readUInt16LE(1);
        }
      } else subBlocks();
    } else if (block === 0x2c) {
      const packed = bytes[offset + 8]; offset += 9;
      if (packed & 0x80) offset += 3 * 2 ** ((packed & 7) + 1);
      offset++; subBlocks();
      metadata.frames++; metadata.delaysMs.push(delayMs); delayMs = 0;
    } else assert.fail(`Unexpected GIF block 0x${block.toString(16)} at ${offset - 1}`);
  }
  metadata.durationMs = metadata.delaysMs.reduce((sum, delay) => sum + delay, 0);
  return metadata;
}

before(async () => {
  await mkdir(qa, { recursive: true });
  gif = gifMetadata(await readFile(originalPath));
  server = createServer(offlineGeneration());
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${server.address().port}`;
  browser = await chromium.launch({ headless: true });
});
after(async () => {
  await writeFile(path.join(qa, 'report.json'), JSON.stringify({ detector: 'Status stub; no actual inference', originalPath, gif, results }, null, 2));
  await browser?.close();
  if (server) await new Promise(resolve => server.close(resolve));
});

async function open({ viewport = viewports[0], theme = 'light' } = {}) {
  const context = await browser.newContext({ viewport });
  await context.addInitScript(theme => localStorage.setItem('asun-image-appearance', theme), theme);
  const page = await context.newPage(), errors = [], inferenceCalls = [];
  page.on('pageerror', error => errors.push(error.message));
  page.on('request', request => {
    if (![base, 'data:', 'blob:'].some(prefix => request.url().startsWith(prefix))) errors.push('Unexpected remote request: ' + request.url());
  });
  await page.route('**/api/local-detection/status', route => route.fulfill({ json: { available: false, message: 'Isolated animated brand test' } }));
  await page.route('**/api/local-detection', async route => { inferenceCalls.push(route.request().url()); await route.abort(); });
  try {
    await page.goto(base);
    await page.locator('#skipStartup').click();
    await page.waitForFunction(() => document.documentElement.dataset.ready === 'true' && document.documentElement.dataset.appearanceReady === 'true');
    await page.locator('#brandAnimation').evaluate(image => image.decode());
    assert.equal(await page.locator('html').getAttribute('data-theme'), theme);
    return { page, context, errors, inferenceCalls };
  } catch (error) { await context.close(); throw error; }
}
async function checked(name, options, run) {
  const session = await open(options);
  try {
    const evidence = await run(session);
    assert.deepEqual(session.errors, [], 'No browser errors or remote requests');
    assert.deepEqual(session.inferenceCalls, [], 'Brand checks never run local inference');
    results.push({ test: name, status: 'passed', ...evidence });
  } catch (error) {
    results.push({ test: name, status: 'failed', error: error.message });
    await session.page.screenshot({ path: path.join(qa, 'failure-' + name.replace(/\W+/g, '-') + '.png') }).catch(() => {});
    throw error;
  } finally { await session.context.close(); }
}

test('the archived original branding asset remains the exact supplied GIF with sixty frames and infinite looping', async () => {
  const original = await readFile(originalPath), response = await fetch(base + '/main-logo.gif');
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('content-type')?.split(';')[0], 'image/gif');
  const served = Buffer.from(await response.arrayBuffer());
  assert.equal(sha256(original), '63e29b61a8d17ae4aee9732391cd8b9aa111df515485d79e9352718c7c42f55d', 'The committed original retains its approved hash');
  assert.equal(sha256(served), sha256(original), 'Serving the logo preserves every original byte');
  assert.deepEqual(gifMetadata(served), gif);
  assert.equal(gif.width, 1983); assert.equal(gif.height, 793); assert.equal(gif.frames, 60);
  assert.equal(gif.loop, 0, 'GIF loop count zero means infinite playback');
  assert.ok(gif.delaysMs.every(delay => delay === 80), 'All sixty frame delays remain 80ms');
  assert.equal(gif.durationMs, 4800);
  results.push({ test: 'served-original-gif', status: 'passed', sha256: sha256(served), bytes: served.length, contentType: response.headers.get('content-type') });
});

async function metrics(page) {
  return page.evaluate(() => {
    const rect = element => { const r = element.getBoundingClientRect(); return { x: r.x, y: r.y, right: r.right, bottom: r.bottom, width: r.width, height: r.height }; };
    const visible = element => { const r = element.getBoundingClientRect(), s = getComputedStyle(element); return r.width > 0 && r.height > 0 && s.visibility !== 'hidden' && s.display !== 'none'; };
    const image = document.querySelector('#brandAnimation'), brand = image.closest('.brand'), style = getComputedStyle(image);
    const items = [...document.querySelectorAll('.header .brand, .header button, .header > .divider, .header > #savedState, .header > .local')].filter(visible).map(element => {
      const bounds = rect(element), hit = document.elementFromPoint(bounds.x + bounds.width / 2, bounds.y + bounds.height / 2);
      return { id: element.id || element.className, ...bounds, interactive: element.matches('a,button'), centerHit: element === hit || element.contains(hit) };
    });
    return { viewport: { width: innerWidth, height: innerHeight }, document: { width: document.documentElement.scrollWidth, height: document.documentElement.scrollHeight }, header: rect(document.querySelector('.header')), brand: rect(brand), image: { ...rect(image), naturalWidth: image.naturalWidth, naturalHeight: image.naturalHeight, complete: image.complete, objectFit: style.objectFit, source: image.getAttribute('src'), alt: image.alt }, items, autoDetect: rect(document.querySelector('#autoDetect')) };
  });
}
function assertLayout(info, label) {
  const { image, header, viewport } = info;
  assert.equal(image.complete, true); assert.equal(image.naturalWidth, gif.width); assert.equal(image.naturalHeight, gif.height);
  assert.equal(image.source, 'main-logo-transparent.gif'); assert.equal(image.alt, 'Asun IMG'); assert.equal(image.objectFit, 'contain');
  assert.ok(Math.abs(image.width / image.height - gif.width / gif.height) < .001, `${label}: displayed logo preserves its natural aspect ratio`);
  const expectedHeight = viewport.width <= 1180 || viewport.height <= 820 ? 50 : 56;
  assert.ok(Math.abs(image.height - expectedHeight) <= .1, `${label}: logo uses the responsive ${expectedHeight}px height`);
  assert.equal(info.document.width, viewport.width, `${label}: no horizontal overflow`);
  assert.equal(info.document.height, viewport.height, `${label}: no vertical overflow`);
  for (const item of info.items) {
    assert.ok(item.x >= -.5 && item.right <= viewport.width + .5, `${label}: ${item.id} stays in the viewport`);
    assert.ok(item.y >= header.y - .5 && item.bottom <= header.bottom + .5, `${label}: ${item.id} stays in the header`);
    if (item.interactive) assert.equal(item.centerHit, true, `${label}: ${item.id} is unobstructed`);
  }
  for (let i = 0; i < info.items.length; i++) for (let j = i + 1; j < info.items.length; j++) {
    const a = info.items[i], b = info.items[j];
    const overlapX = Math.min(a.right, b.right) - Math.max(a.x, b.x), overlapY = Math.min(a.bottom, b.bottom) - Math.max(a.y, b.y);
    assert.ok(overlapX <= .5 || overlapY <= .5, `${label}: ${a.id} and ${b.id} must not overlap (${overlapX.toFixed(2)} x ${overlapY.toFixed(2)})`);
  }
  assert.ok(Math.abs(info.autoDetect.x + info.autoDetect.width / 2 - viewport.width / 2) <= 2, `${label}: Auto detect stays centered`);
}

for (const theme of ['light', 'dark']) for (const viewport of viewports) {
  const name = `${theme}-${viewport.width}x${viewport.height}`;
  test(`the decoded GIF replaces the old brand and the header fits at ${name}`, async () => checked(name, { viewport, theme }, async ({ page }) => {
    assert.equal(await page.locator('.header .brand').count(), 1);
    assert.equal(await page.locator('.header .brand > *').count(), 1);
    assert.equal(await page.locator('.header .brand > #brandAnimation').count(), 1);
    assert.equal(await page.locator('.header .brand svg, .header .brand strong, .header .brand span').count(), 0, 'Old logo and text have been replaced');
    assert.equal((await page.locator('.header .brand').textContent()).trim(), '');
    assert.equal(await page.locator('.header .brand').getAttribute('aria-label'), 'Asun IMG');
    const bounds = await metrics(page); assertLayout(bounds, name);
    await page.locator('.header').screenshot({ path: path.join(qa, name + '-header.png') });
    await page.screenshot({ path: path.join(qa, name + '.png') });
    await writeFile(path.join(qa, name + '-bounds.json'), JSON.stringify(bounds, null, 2));
    return { bounds };
  }));
}

// Browser screenshots of the image's own box prove composited GIF playback.
// drawImage(animatedGif) may always return the first frame and is deliberately avoided.
for (const theme of ['light', 'dark']) {
  test(`the visible GIF changes frames before and after a complete loop in ${theme} mode`, async () => checked(theme + '-animation', { theme }, async ({ page }) => {
    await page.mouse.move(600, 400);
    const image = page.locator('#brandAnimation'), started = Date.now();
    const capture = async phase => {
      const frames = [];
      for (let index = 0; index < 4; index++) {
        const bytes = await image.screenshot({ path: path.join(qa, `${theme}-${phase}-${index}.png`) });
        frames.push({ elapsedMs: Date.now() - started, sha256: sha256(bytes) });
        if (index < 3) await page.waitForTimeout(160);
      }
      assert.ok(new Set(frames.map(frame => frame.sha256)).size > 1, `${theme} ${phase}: image-only screenshots show changing GIF pixels`);
      return frames;
    };
    const initialFrames = await capture('initial');
    await page.waitForTimeout(gif.durationMs + 400);
    const afterLoopFrames = await capture('after-loop');
    assert.ok(afterLoopFrames[0].elapsedMs > gif.durationMs, 'The second sample begins after the complete 4.8-second loop');
    return { initialFrames, afterLoopFrames, sampledArea: await image.boundingBox(), loopDurationMs: gif.durationMs };
  }));
}

});
