import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { chromium } from 'playwright';
import { createServer } from '../server.mjs';

const key = 'asun-image-appearance';
const qa = path.resolve('qa', 'appearance');
let server, browser, base;
before(async () => {
  await mkdir(qa, { recursive: true });
  server = createServer();
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${server.address().port}`;
  browser = await chromium.launch({ headless: true });
});
after(async () => {
  await browser?.close();
  if (server) await new Promise(resolve => server.close(resolve));
});

async function open(options = {}) {
  const context = await browser.newContext({ viewport: options.viewport || { width: 1672, height: 941 }, acceptDownloads: true });
  if (options.init) await context.addInitScript(options.init);
  const page = await context.newPage(), errors = [];
  page.on('pageerror', error => errors.push(error.message));
  page.on('request', request => {
    if (!request.url().startsWith(base) && !request.url().startsWith('data:') && !request.url().startsWith('blob:')) errors.push('Unexpected remote request: ' + request.url());
  });
  await page.route('**/api/local-detection/status', route => route.fulfill({ json: { available: false, message: 'Isolated appearance test' } }));
  await page.goto(base);
  await ready(page);
  return { context, page, errors };
}
async function ready(page) {
  await page.waitForFunction(() => document.documentElement.dataset.ready === 'true' && document.documentElement.dataset.appearanceReady === 'true');
}
async function finish(session) {
  try { assert.deepEqual(session.errors, []); } finally { await session.context.close(); }
}
async function fixture(page, name = 'Preserved main.png', width = 1000, height = 700) {
  const source = await page.evaluate(({ width, height }) => {
    const c = document.createElement('canvas'); c.width = width; c.height = height;
    const ctx = c.getContext('2d'), gradient = ctx.createLinearGradient(0, 0, width, height);
    gradient.addColorStop(0, '#759ac7'); gradient.addColorStop(1, '#c1d0dd');
    ctx.fillStyle = gradient; ctx.fillRect(0, 0, width, height);
    ctx.fillStyle = '#385467'; ctx.fillRect(width * .1, height * .53, width * .8, height * .28);
    ctx.fillStyle = '#bd9978'; ctx.fillRect(width * .08, height * .48, width * .84, height * .08);
    ctx.fillStyle = '#e5edf0'; ctx.fillRect(width * .25, height * .15, width * .5, height * .3);
    return c.toDataURL('image/png');
  }, { width, height });
  return { name, mimeType: 'image/png', buffer: Buffer.concat([Buffer.from(source.split(',')[1], 'base64'), Buffer.from('\nExact preserved original: ' + name)]) };
}
async function upload(page, image) {
  await page.locator('#imageInput').setInputFiles(image);
  await page.waitForFunction(() => !document.body.classList.contains('busy') && document.querySelectorAll('.layer-row').length === 1);
}
async function save(page) {
  const pending = page.waitForEvent('download'); await page.locator('#saveProject').click();
  const download = await pending, stream = await download.createReadStream(), chunks = [];
  for await (const chunk of stream) chunks.push(chunk);
  await page.waitForTimeout(725);
  return JSON.parse(Buffer.concat(chunks).toString());
}
async function number(page) {
  await page.locator('#addText').click();
  const rect = await page.locator('#board').boundingBox();
  await page.mouse.click(rect.x + rect.width * .32, rect.y + rect.height * .53);
  await page.locator('#textEditor').fill('1'); await page.locator('#textEditor').press('Enter');
  await page.locator('#textEditor').waitFor({ state: 'hidden' });
}
async function reference(page, image) {
  await page.locator('#linkReference').click(); await page.locator('#referenceDialog').waitFor({ state: 'visible' });
  await page.locator('#referenceFileInput').setInputFiles(image);
  await page.waitForFunction(() => !document.body.classList.contains('busy') && document.querySelector('#referenceEditorHost').dataset.refReady === 'true');
  await page.locator('#labelComment').fill('Keep the composition. Use the reference material for the desk.');
  await page.locator('#referenceNotes').fill('Use this finish only. Keep the existing shape and camera angle.');
}

test('light default, accessible theme switch and remembered reload never change the project or original pixels', async () => {
  const session = await open(), { page } = session;
  try {
    assert.equal(await page.locator('html').getAttribute('data-theme'), 'light');
    assert.equal(await page.locator('#themeToggle').getAttribute('aria-pressed'), 'false');
    assert.equal(await page.locator('#themeToggle .theme-label').innerText(), 'Light');
    assert.equal(await page.locator('#themeToggle .theme-icon use').getAttribute('href'), '#ui-sun');
    const image = await fixture(page); await upload(page, image); await number(page);
    const before = await save(page);
    const unchanged = async () => page.evaluate(() => ({
      saved: document.querySelector('#savedState').textContent,
      history: document.querySelector('#historyList').textContent,
      pixels: document.querySelector('#canvas').toDataURL(),
      selected: document.querySelector('.layer-row.selected').dataset.id,
      size: document.querySelector('#documentSize').textContent
    }));
    const state = await unchanged();
    await page.locator('#themeToggle').click();
    assert.equal(await page.locator('html').getAttribute('data-theme'), 'dark');
    assert.equal(await page.locator('#themeToggle').getAttribute('aria-label'), 'Switch to light mode');
    assert.equal(await page.locator('#themeToggle').getAttribute('aria-pressed'), 'true');
    assert.equal(await page.locator('#themeToggle .theme-label').innerText(), 'Dark');
    assert.equal(await page.locator('#themeToggle .theme-icon use').getAttribute('href'), '#ui-moon');
    assert.deepEqual(await unchanged(), state);
    assert.deepEqual(await save(page), before, 'The appearance preference never enters saved project data');
    const original = before.assets[before.original.assetId];
    assert.deepEqual(Buffer.from(original.source.split(',')[1], 'base64'), image.buffer);
    await page.reload(); await ready(page);
    assert.equal(await page.locator('html').getAttribute('data-theme'), 'dark');
    assert.equal(await page.evaluate(key => localStorage.getItem(key), key), 'dark');
    await page.locator('#themeToggle').click(); await page.reload(); await ready(page);
    assert.equal(await page.locator('html').getAttribute('data-theme'), 'light');
    assert.equal(await page.locator('#themeToggle').getAttribute('aria-label'), 'Switch to dark mode');
  } finally { await finish(session); }
});

test('a corrupted appearance preference uses the light default and a normal switch repairs it', async () => {
  const session = await open({ init: () => localStorage.setItem('asun-image-appearance', 'invalid-theme') }), { page } = session;
  try {
    assert.equal(await page.locator('html').getAttribute('data-theme'), 'light');
    await page.locator('#themeToggle').click();
    assert.equal(await page.evaluate(key => localStorage.getItem(key), key), 'dark');
  } finally { await finish(session); }
});

test('unavailable preference storage still allows both modes and falls back safely when reopened', async () => {
  const session = await open({ init: () => Object.defineProperty(window, 'localStorage', { get() { throw new DOMException('Disabled storage', 'SecurityError'); } }) }), { page } = session;
  try {
    assert.equal(await page.locator('html').getAttribute('data-theme'), 'light');
    await page.locator('#themeToggle').click(); assert.equal(await page.locator('html').getAttribute('data-theme'), 'dark');
    await page.locator('#themeToggle').click(); assert.equal(await page.locator('html').getAttribute('data-theme'), 'light');
    await page.locator('#themeToggle').click(); await page.reload(); await ready(page);
    assert.equal(await page.locator('html').getAttribute('data-theme'), 'light');
  } finally { await finish(session); }
});

test('remembered dark mode is applied before any stylesheet finishes loading', async () => {
  const context = await browser.newContext();
  await context.addInitScript(() => localStorage.setItem('asun-image-appearance', 'dark'));
  const page = await context.newPage(); let unblock;
  const gate = new Promise(resolve => { unblock = resolve; });
  await page.route('**/*.css', async route => { await gate; await route.continue(); });
  await page.route('**/api/local-detection/status', route => route.fulfill({ json: { available: false } }));
  try {
    const navigation = page.goto(base, { waitUntil: 'load' });
    await page.waitForFunction(() => document.documentElement.dataset.theme === 'dark');
    assert.equal(await page.locator('html').evaluate(root => root.style.colorScheme), 'dark');
    assert.notEqual(await page.locator('html').getAttribute('data-appearance-ready'), 'true', 'The choice is applied before DOM setup and the deferred editor');
    unblock(); await navigation; await ready(page);
  } finally { unblock(); await context.close(); }
});

test('inspector tabs follow selection, support roving keyboard focus and do not nudge the selected layer', async () => {
  const session = await open(), { page } = session;
  try {
    assert.equal(await page.locator('#showProperties').isDisabled(), true);
    assert.equal(await page.locator('#showLayers').getAttribute('aria-selected'), 'true');
    assert.equal(await page.locator('#transformPanel').isVisible(), false);
    await upload(page, await fixture(page));
    assert.equal(await page.locator('#showProperties').isEnabled(), true);
    assert.equal(await page.locator('#transformPanel').isVisible(), false);
    const x = await page.locator('#layerX').inputValue(), y = await page.locator('#layerY').inputValue();
    await page.locator('#showLayers').focus(); await page.keyboard.press('ArrowRight');
    assert.equal(await page.locator('#showProperties').evaluate(button => button === document.activeElement), true);
    assert.equal(await page.locator('#showProperties').getAttribute('aria-selected'), 'true');
    assert.equal(await page.locator('#showProperties').getAttribute('tabindex'), '0');
    assert.equal(await page.locator('#showLayers').getAttribute('tabindex'), '-1');
    assert.equal(await page.locator('#layerW').isVisible(), true);
    assert.equal(await page.locator('#layersPane').isVisible(), false);
    await page.keyboard.press('Home'); assert.equal(await page.locator('.panels').getAttribute('data-inspector'), 'layers');
    await page.keyboard.press('End'); assert.equal(await page.locator('.panels').getAttribute('data-inspector'), 'properties');
    await page.keyboard.press('ArrowRight'); assert.equal(await page.locator('.panels').getAttribute('data-inspector'), 'layers');
    await page.keyboard.press('ArrowLeft'); assert.equal(await page.locator('.panels').getAttribute('data-inspector'), 'properties');
    assert.equal(await page.locator('#layerX').inputValue(), x); assert.equal(await page.locator('#layerY').inputValue(), y);
    assert.equal(await page.locator('#historyCount').innerText(), '1 edits');
    await page.keyboard.press('Delete');
    assert.equal(await page.locator('#showProperties').isDisabled(), true);
    assert.equal(await page.locator('#showLayers').getAttribute('aria-selected'), 'true');
    assert.equal(await page.locator('#showLayers').evaluate(button => button === document.activeElement), true, 'Deleting the selected layer moves focus to the available Layers tab');
    await page.locator('#undo').click();
    assert.equal(await page.locator('#showProperties').isDisabled(), true, 'Undo restores the image without creating a selection');
    await page.locator('.layer-row').click(); assert.equal(await page.locator('#showProperties').isEnabled(), true);
  } finally { await finish(session); }
});

test('history collapse and keyboard mode switching survive an editor refresh without panning or changing edits', async () => {
  const session = await open(), { page } = session;
  try {
    await upload(page, await fixture(page));
    const board = await page.locator('#board').boundingBox();
    await page.locator('#toggleHistory').focus(); await page.keyboard.press('Space');
    assert.equal(await page.locator('#historyList').isVisible(), false);
    assert.equal(await page.locator('#toggleHistory').getAttribute('aria-expanded'), 'false');
    assert.equal(await page.locator('#toggleHistory').getAttribute('aria-label'), 'Expand history');
    await page.locator('#themeToggle').focus(); await page.keyboard.press('Space');
    assert.equal(await page.locator('html').getAttribute('data-theme'), 'dark');
    await page.locator('#duplicateLayer').click();
    assert.equal(await page.locator('#historyList').isVisible(), false, 'History stays collapsed after content is re-rendered');
    assert.equal(await page.locator('#historyList button').count(), 3);
    assert.deepEqual(await page.locator('#board').boundingBox(), board, 'Appearance buttons do not pan the canvas');
    await page.locator('#toggleHistory').focus(); await page.keyboard.press('Enter');
    assert.equal(await page.locator('#historyList').isVisible(), true);
    assert.equal(await page.locator('#toggleHistory').getAttribute('aria-expanded'), 'true');
    assert.equal(await page.locator('#toggleHistory').getAttribute('aria-label'), 'Collapse history');
  } finally { await finish(session); }
});

for (const theme of ['light', 'dark']) for (const viewport of [{ width: 1672, height: 941 }, { width: 1280, height: 800 }, { width: 1080, height: 720 }]) {
  test(`${theme} workspace fits ${viewport.width}×${viewport.height} with readable controls, numbered edit summary and a full image`, async () => {
    const session = await open({ viewport }), { page } = session;
    try {
      if (theme === 'dark') await page.locator('#themeToggle').click();
      await upload(page, await fixture(page)); await number(page); await reference(page, await fixture(page, 'Reference finish.png', 240, 160));
      await page.locator('#saveReferenceLink').click(); await page.locator('#referenceDialog').waitFor({ state: 'hidden' });
      await page.locator('#prompt').fill('Keep the composition and apply the numbered edits.'); await page.locator('#prompt').blur();
      await page.locator('#fit').click(); await page.locator('#toast').waitFor({ state: 'hidden' });
      const metrics = await page.evaluate(() => {
        const box = selector => { const r = document.querySelector(selector).getBoundingClientRect(); return { x: r.x, y: r.y, right: r.right, bottom: r.bottom, width: r.width, height: r.height }; };
        return { viewport: { width: innerWidth, height: innerHeight }, document: { width: document.documentElement.scrollWidth, height: document.documentElement.scrollHeight }, canvas: box('.canvas-area'), stage: box('#stage'), board: box('#board'), inspector: box('.panels'), navigatorHeading: box('.navigator h2'), composer: box('.composer'), prompt: box('#prompt'), rail: box('.toolrail'), font: parseFloat(getComputedStyle(document.querySelector('#prompt')).fontSize), visibleControls: ['#themeToggle', '#saveProject', '#export', '#autoDetect', '#copyReferencesTop', '#completeReferencePackTop'].map(id => ({ id, ...box(id) })) };
      });
      assert.equal(metrics.document.width, viewport.width, 'No horizontal page overflow');
      assert.equal(metrics.document.height, viewport.height, 'The complete workspace stays within the window');
      assert.ok(metrics.canvas.width >= 330, 'The image retains usable space even in a compact window');
      assert.ok(metrics.inspector.x >= metrics.canvas.right - 1, 'Inspector does not cover the image workspace');
      assert.ok(metrics.navigatorHeading.y >= metrics.inspector.y - 1 && metrics.navigatorHeading.bottom <= metrics.inspector.bottom, 'The Navigator heading stays visible when edit history refreshes');
      assert.ok(metrics.composer.y >= metrics.canvas.bottom - 1, 'Composer sits below the canvas');
      assert.ok(metrics.prompt.width >= 240 && metrics.font >= 13, 'Prompt remains readable');
      assert.ok(metrics.board.x >= metrics.stage.x - 1 && metrics.board.y >= metrics.stage.y - 1 && metrics.board.right <= metrics.stage.right + 1 && metrics.board.bottom <= metrics.stage.bottom + 1, 'Fit preserves the complete image in view');
      for (const control of metrics.visibleControls) assert.ok(control.width > 0 && control.height > 0 && control.x >= 0 && control.right <= viewport.width && control.bottom <= viewport.height, control.id + ' stays in view');
      assert.equal(await page.locator('#generate').isDisabled(), true);
      assert.equal(await page.locator('#editSummaryPanel').isVisible(), true);
      assert.match(await page.locator('#editSummaryPanel').innerText(), /Use the reference material/);
      await page.screenshot({ path: path.join(qa, `${theme}-${viewport.width}.png`) });
      await writeFile(path.join(qa, `${theme}-${viewport.width}-bounds.json`), JSON.stringify(metrics, null, 2));
    } finally { await finish(session); }
  });
}

for (const theme of ['light', 'dark']) test(`${theme} dialogs and linked-photo editor use the selected appearance with working notes and export controls`, async () => {
  const session = await open(), { page } = session;
  try {
    if (theme === 'dark') await page.locator('#themeToggle').click();
    await upload(page, await fixture(page)); await number(page); await reference(page, await fixture(page, 'Reference finish.png', 240, 160));
    assert.equal(await page.locator('#labelComment').isVisible(), true);
    assert.equal(await page.locator('#referenceNotes').isVisible(), true);
    const dialog = await page.locator('#referenceDialog').boundingBox();
    assert.ok(dialog.x >= 0 && dialog.y >= 0 && dialog.x + dialog.width <= 1672 && dialog.y + dialog.height <= 941);
    await page.screenshot({ path: path.join(qa, `${theme}-references.png`) });
    await page.locator('#referenceDialog').evaluate(dialog => { dialog.scrollTop = 0; });
    await page.screenshot({ path: path.join(qa, `${theme}-references-top.png`) });
    await page.locator('#saveReferenceLink').click(); await page.locator('#referenceDialog').waitFor({ state: 'hidden' });
    await page.locator('#export').click(); await page.locator('#dialog').waitFor({ state: 'visible' });
    assert.equal(await page.locator('#confirmDialog').isEnabled(), true);
    assert.equal(await page.locator('html').getAttribute('data-theme'), theme);
    await page.screenshot({ path: path.join(qa, `${theme}-export.png`) });
    await page.locator('#cancelDialog').click();
    await page.locator('#addText').click(); await page.locator('#textColorWheel').click(); await page.locator('#colorPicker').waitFor({ state: 'visible' });
    await page.screenshot({ path: path.join(qa, `${theme}-color-wheel.png`) });
    await page.keyboard.press('Escape');
  } finally { await finish(session); }
});
