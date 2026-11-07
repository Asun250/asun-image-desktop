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

describe('Optional private artwork checks', {skip:missingAssetReason(["public/startup.gif"])}, () => {
const originalPath = fileURLToPath(new URL('../public/startup.gif', import.meta.url));
const qa = path.resolve('qa', 'startup'), results = [];
const viewports = [{ width: 1672, height: 941 }, { width: 1280, height: 800 }, { width: 1080, height: 720 }, { width: 2517, height: 1348 }];
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const sourceHash = 'b950d7ff5175da54b0f691d7b208b71af5313480570c8f826c8e833c13235356';
let server, browser, base, gif;

function metadata(bytes) {
  assert.equal(bytes.toString('ascii', 0, 6), 'GIF89a');
  const result = { width: bytes.readUInt16LE(6), height: bytes.readUInt16LE(8), delays: [], loop: null };
  let offset = 13, delay = 0;
  if (bytes[10] & 128) offset += 3 * 2 ** ((bytes[10] & 7) + 1);
  function blocks() { const chunks = []; while (bytes[offset]) { const length = bytes[offset++]; assert.ok(offset + length <= bytes.length); chunks.push(bytes.subarray(offset, offset + length)); offset += length; } offset++; return Buffer.concat(chunks); }
  while (offset < bytes.length) {
    const type = bytes[offset++]; if (type === 59) break;
    if (type === 33) {
      const label = bytes[offset++];
      if (label === 249) { assert.equal(bytes[offset++], 4); delay = bytes.readUInt16LE(offset + 1) * 10; offset += 4; assert.equal(bytes[offset++], 0); }
      else if (label === 255) { const length = bytes[offset++], id = bytes.toString('ascii', offset, offset + length); offset += length; const payload = blocks(); if (['NETSCAPE2.0', 'ANIMEXTS1.0'].includes(id)) result.loop = payload.readUInt16LE(1); }
      else blocks();
    } else if (type === 44) { const packed = bytes[offset + 8]; offset += 9; if (packed & 128) offset += 3 * 2 ** ((packed & 7) + 1); offset++; blocks(); result.delays.push(delay); delay = 0; }
    else assert.fail('Unexpected GIF block ' + type);
  }
  result.frames = result.delays.length; result.cycleMs = result.delays.reduce((sum, value) => sum + value, 0); return result;
}
before(async () => {
  await mkdir(qa, { recursive: true }); gif = await readFile(originalPath);
  server = createServer(offlineGeneration()); await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${server.address().port}`; browser = await chromium.launch({ headless: true });
});
after(async () => {
  await writeFile(path.join(qa, 'report.json'), JSON.stringify({ originalPath, sourceBytes: gif?.length, sourceSha256: gif && sha(gif), gif: gif && metadata(gif), background: '#5ff7d6', detector: 'Status stub; no inference', results }, null, 2));
  await browser?.close(); if (server) await new Promise(resolve => server.close(resolve));
});

async function open({ theme = 'light', viewport = viewports[0], image = 'normal', editor = 'normal', clock = false } = {}) {
  const context = await browser.newContext({ viewport, acceptDownloads: true });
  await context.addInitScript(theme => {
    localStorage.setItem('asun-image-appearance', theme);
    window.__startupLoads = []; window.__startupTransitions = [];
    document.addEventListener('load', event => { if (event.target.id === 'startupAnimation') window.__startupLoads.push(performance.now()); }, true);
    new MutationObserver(() => {
      const root = document.documentElement;
      if (root) window.__startupTransitions.push({ at: performance.now(), startup: root.dataset.startup, ready: root.dataset.ready, reason: root.dataset.startupReason });
    }).observe(document, { subtree: true, attributes: true, attributeFilter: ['data-startup', 'data-ready', 'data-startup-reason'] });
  }, theme);
  const page = await context.newPage(), errors = [], calls = [], downloads = [], releases = [];
  page.on('pageerror', error => errors.push(error.message)); page.on('download', download => downloads.push(download.suggestedFilename()));
  page.on('request', request => { if (![base, 'data:', 'blob:'].some(prefix => request.url().startsWith(prefix))) errors.push('Unexpected remote request: ' + request.url()); });
  await page.route('**/api/local-detection/status', route => route.fulfill({ json: { available: false, message: 'Isolated startup QA' } }));
  await page.route('**/api/local-detection', async route => { calls.push(route.request().url()); await route.abort(); });
  if (image === 'fail') await page.route('**/startup.gif', route => route.abort('failed'));
  if (image === 'hold') {
    const gate = new Promise(resolve => releases.push(resolve));
    await page.route('**/startup.gif', async route => { await gate; await route.fulfill({ body: gif, contentType: 'image/gif' }).catch(() => {}); });
  }
  if (editor === 'hold') {
    const gate = new Promise(resolve => releases.push(resolve));
    await page.route('**/editor.mjs', async route => { await gate; await route.continue().catch(() => {}); });
  }
  if (clock) await page.clock.install();
  try {
    await page.goto(base, { waitUntil: editor === 'hold' ? 'commit' : 'domcontentloaded' });
    await page.locator('#startupScreen').waitFor({ state: 'attached' });
    return { context, page, errors, calls, downloads, release: () => releases.forEach(resolve => resolve()) };
  } catch (error) { releases.forEach(resolve => resolve()); await context.close(); throw error; }
}
async function checked(name, options, run) {
  const session = await open(options);
  try { const evidence = await run(session); assert.deepEqual(session.errors, []); assert.deepEqual(session.calls, []); results.push({ test: name, status: 'passed', ...evidence }); }
  catch (error) { results.push({ test: name, status: 'failed', error: error.message }); await session.page.screenshot({ path: path.join(qa, 'failure-' + name + '.png') }).catch(() => {}); throw error; }
  finally { session.release(); await session.context.close(); }
}
async function playing(page) {
  await page.waitForFunction(() => document.documentElement.dataset.startup === 'playing');
  assert.equal(await page.locator('#startupScreen').isVisible(), true);
  assert.equal(await page.locator('#app').evaluate(app => app.inert), true);
  assert.equal(await page.locator('#app').getAttribute('aria-hidden'), 'true');
  assert.equal(await page.locator('#app').evaluate(app => getComputedStyle(app).visibility), 'hidden');
  assert.notEqual(await page.locator('html').getAttribute('data-ready'), 'true');
}
async function complete(page, reason) {
  await page.waitForFunction(() => document.documentElement.dataset.startup === 'complete' && document.documentElement.dataset.ready === 'true');
  assert.equal(await page.locator('#startupScreen').isVisible(), false);
  assert.equal(await page.locator('#app').evaluate(app => app.inert), false);
  assert.notEqual(await page.locator('#app').getAttribute('aria-hidden'), 'true');
  assert.equal(await page.locator('#app').evaluate(app => getComputedStyle(app).visibility), 'visible');
  assert.equal(await page.locator('#startupAnimation').getAttribute('src'), null, 'The finished GIF is unloaded');
  if (reason) assert.equal(await page.locator('html').getAttribute('data-startup-reason'), reason);
}
async function loaded(page) { await page.waitForFunction(() => window.__startupLoads.length > 0); }
async function editorInitialized(page) { await page.waitForFunction(() => window.__startupTransitions.some(entry => entry.ready === 'true')); }
async function bounds(page) {
  return page.evaluate(() => {
    const rect = element => { const r = element.getBoundingClientRect(); return { x: r.x, y: r.y, right: r.right, bottom: r.bottom, width: r.width, height: r.height }; };
    const image = document.querySelector('#startupAnimation'), box = rect(image), scale = Math.min(box.width / image.naturalWidth, box.height / image.naturalHeight);
    return { viewport: { width: innerWidth, height: innerHeight }, screen: rect(document.querySelector('#startupScreen')), image: { ...box, naturalWidth: image.naturalWidth, naturalHeight: image.naturalHeight, fit: getComputedStyle(image).objectFit, content: { x: box.x + (box.width - image.naturalWidth * scale) / 2, y: box.y + (box.height - image.naturalHeight * scale) / 2, width: image.naturalWidth * scale, height: image.naturalHeight * scale } }, skip: { ...rect(document.querySelector('#skipStartup')), hit: (() => { const button = document.querySelector('#skipStartup'), r = button.getBoundingClientRect(); return button.contains(document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2)); })() } };
  });
}
function fits(info) {
  assert.deepEqual([info.screen.x, info.screen.y, info.screen.width, info.screen.height], [0, 0, info.viewport.width, info.viewport.height]);
  assert.deepEqual([info.image.naturalWidth, info.image.naturalHeight], [1280, 720]); assert.equal(info.image.fit, 'contain');
  const content = info.image.content;
  assert.ok(Math.abs(content.width / content.height - 16 / 9) < .0001, 'Rendered artwork retains its full 16:9 frame');
  assert.ok(content.x >= -.5 && content.y >= -.5 && content.x + content.width <= info.viewport.width + .5 && content.y + content.height <= info.viewport.height + .5);
  assert.ok(info.skip.x >= 0 && info.skip.y >= 0 && info.skip.right <= info.viewport.width && info.skip.bottom <= info.viewport.height); assert.equal(info.skip.hit, true);
}

test('served startup animation preserves every original GIF byte, frame and delay', async () => {
  const response = await fetch(base + '/startup.gif'), served = Buffer.from(await response.arrayBuffer());
  assert.equal(response.status, 200); assert.equal(response.headers.get('content-type')?.split(';')[0], 'image/gif');
  assert.equal(sha(gif), sourceHash); assert.equal(sha(served), sourceHash);
  assert.deepEqual(metadata(served), { width: 1280, height: 720, delays: Array(80).fill(80), loop: 0, frames: 80, cycleMs: 6400 });
  results.push({ test: 'byte-exact-startup-gif', status: 'passed', bytes: served.length, sha256: sha(served) });
});

test('a native full startup cycle plays first, then reveals the ready editor once', async () => checked('natural-cycle', {}, async ({ page }) => {
  await loaded(page); await playing(page); const geometry = await bounds(page); fits(geometry);
  const initial = await page.locator('#startupAnimation').screenshot({ path: path.join(qa, 'light-initial.png') });
  await page.waitForTimeout(1800); await playing(page);
  const mid = await page.locator('#startupAnimation').screenshot({ path: path.join(qa, 'light-mid-animation.png') });
  await page.screenshot({ path: path.join(qa, 'light-mid-cycle.png') });
  assert.notEqual(sha(initial), sha(mid), 'Real browser screenshots show native GIF progression');
  await page.waitForTimeout(600); await playing(page);
  await page.screenshot({ path: path.join(qa, 'light-startup.png') });
  await complete(page, 'played');
  const timeline = await page.evaluate(() => ({ loadedAt: window.__startupLoads[0], completed: window.__startupTransitions.find(entry => entry.startup === 'complete'), transitions: window.__startupTransitions }));
  const elapsed = timeline.completed.at - timeline.loadedAt;
  assert.ok(elapsed >= 6300 && elapsed <= 8500, `One 6400ms native cycle completes after load (${elapsed.toFixed(1)}ms)`);
  assert.equal(await page.locator('#stage').evaluate(stage => stage === document.activeElement), true);
  await page.screenshot({ path: path.join(qa, 'light-editor-revealed.png') });
  return { geometry, elapsedMs: elapsed, timeline };
}));

for (const theme of ['light', 'dark']) for (const viewport of viewports) {
  if (theme === 'light' && viewport.width === 1672) continue;
  const name = `${theme}-${viewport.width}x${viewport.height}`;
  test(`fullscreen startup retains the complete artwork and a usable Skip button at ${name}`, async () => checked(name, { theme, viewport }, async ({ page }) => {
    await loaded(page); await playing(page); const geometry = await bounds(page); fits(geometry);
    if (theme === 'dark' && viewport.width === 1672) { await page.waitForTimeout(1800); await page.screenshot({ path: path.join(qa, 'dark-mid-cycle.png') }); await page.waitForTimeout(600); await playing(page); await page.screenshot({ path: path.join(qa, 'dark-startup.png') }); }
    else await page.screenshot({ path: path.join(qa, name + '-startup.png') });
    await page.locator('#skipStartup').click(); await complete(page, 'skipped');
    assert.equal(await page.locator('html').getAttribute('data-theme'), theme);
    return { geometry };
  }));
}

test('startup blocks editor shortcuts, paste, drop and wheel, supports native keyboard dismissal, and restores normal controls', async () => checked('keyboard-and-input-guard', {}, async ({ page, downloads }) => {
  await loaded(page); await editorInitialized(page); await playing(page);
  await page.keyboard.press('t'); await page.keyboard.press('b'); await page.keyboard.press('Control+s');
  await page.mouse.move(700, 450); await page.mouse.wheel(0, 120);
  const prevented = await page.evaluate(() => {
    const file = new File(['not imported during startup'], 'Blocked.png', { type: 'image/png' }), transfer = new DataTransfer(); transfer.items.add(file);
    const paste = new ClipboardEvent('paste', { clipboardData: transfer, bubbles: true, cancelable: true }), drop = new DragEvent('drop', { dataTransfer: transfer, bubbles: true, cancelable: true }), wheel = new WheelEvent('wheel', { deltaY: 120, bubbles: true, cancelable: true });
    for (const event of [paste, drop, wheel]) document.querySelector('#stage').dispatchEvent(event);
    return [paste.defaultPrevented, drop.defaultPrevented, wheel.defaultPrevented];
  });
  assert.deepEqual(prevented, [true, true, true]); assert.deepEqual(downloads, []);
  assert.equal(await page.locator('.layer-row').count(), 0); assert.equal(await page.locator('.toolrail [data-tool].active').getAttribute('data-tool'), 'move');
  for (let index = 0; index < 4; index++) { await page.keyboard.press(index % 2 ? 'Shift+Tab' : 'Tab'); assert.equal(await page.evaluate(() => document.querySelector('#app').contains(document.activeElement)), false, 'Keyboard focus cannot enter the inert editor'); }
  await page.keyboard.press('Escape'); await complete(page, 'skipped');
  await page.locator('#addText').click(); assert.equal(await page.locator('.toolrail [data-tool].active').getAttribute('data-tool'), 'text');
  return { prevented, downloads, editorInputRestored: true };
}));

test('Skip pressed before editor loading finishes stays gated even beyond the safety timeout', async () => checked('skip-delayed-editor', { editor: 'hold', clock: true }, async ({ page, release }) => {
  await page.locator('#skipStartup').waitFor({ state: 'visible' }); await playing(page);
  await page.locator('#skipStartup').click();
  assert.equal(await page.locator('#skipStartup').isDisabled(), true);
  assert.equal(await page.locator('#skipStartup').innerText(), 'Opening…');
  await page.clock.fastForward(17000); await playing(page);
  assert.notEqual(await page.locator('html').getAttribute('data-ready'), 'true', 'No unready editor is revealed by a timeout');
  release(); await complete(page, 'skipped');
  return { waitMs: 17000, stayedInertUntilEditorReady: true };
}));

test('a failed startup image falls back promptly without locking the ready editor', async () => checked('failed-gif', { image: 'fail' }, async ({ page }) => {
  await complete(page, 'asset-error');
  await page.locator('#projectName').click(); assert.equal(await page.locator('#dialog').isVisible(), true); await page.locator('#cancelDialog').click();
  return { fallbackReason: 'asset-error', editorControlsUsable: true };
}));

test('a never-loaded image has an eight-second fallback and a late response never restores the splash', async () => checked('hanging-gif', { image: 'hold', clock: true }, async ({ page, release }) => {
  await editorInitialized(page); await playing(page);
  // The installed clock also advances during real page setup. Leave room for
  // that elapsed time when checking the boundary, instead of racing at 7.9s.
  await page.clock.fastForward(6000); await playing(page);
  await page.clock.fastForward(2200); await complete(page, 'load-timeout');
  release(); await page.waitForTimeout(100);
  await page.clock.fastForward(17000); await complete(page, 'load-timeout');
  return { fallbackMs: 8000, lateImageCannotResurface: true };
}));

test('the startup plays again on reload in the same session and on a fresh open', async () => checked('every-open', {}, async ({ page }) => {
  await loaded(page); await playing(page); await page.locator('#skipStartup').click(); await complete(page, 'skipped');
  await page.reload({ waitUntil: 'domcontentloaded' }); await loaded(page); await playing(page);
  await page.locator('#skipStartup').click(); await complete(page, 'skipped');
  const fresh = await open();
  try { await loaded(fresh.page); await playing(fresh.page); await fresh.page.locator('#skipStartup').click(); await complete(fresh.page, 'skipped'); assert.deepEqual(fresh.errors, []); assert.deepEqual(fresh.calls, []); }
  finally { fresh.release(); await fresh.context.close(); }
  return { repeatedOnReload: true, repeatedOnFreshOpen: true };
}));

});
