import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { chromium } from 'playwright';
import { createServer } from '../server.mjs';

const qa = path.resolve('qa', 'detect-cta');
const viewports = [{ width: 1672, height: 941 }, { width: 1280, height: 800 }, { width: 1080, height: 720 }, { width: 2517, height: 1348 }];
const reports = [];
let server, browser, base;

before(async () => {
  await mkdir(qa, { recursive: true });
  server = createServer();
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${server.address().port}`;
  browser = await chromium.launch({ headless: true });
});
after(async () => {
  await writeFile(path.join(qa, 'report.json'), JSON.stringify({ detector: 'Mock SAM; no actual inference', results: reports }, null, 2));
  await browser?.close();
  if (server) await new Promise(resolve => server.close(resolve));
});

function rectangleMask(width, height, [x, y, w, h]) {
  const counts = [];
  let previous = false, run = 0;
  for (let row = 0; row < height; row++) for (let col = 0; col < width; col++) {
    const inside = col >= x && col < x + w && row >= y && row < y + h;
    if (inside === previous) run++;
    else { counts.push(run); run = 1; previous = inside; }
  }
  counts.push(run);
  return { width, height, counts };
}
function detection(body) {
  const box = body.prompt?.box;
  const rects = box ? [[Math.floor(box[0]), Math.floor(box[1]), Math.ceil(box[2]) - Math.floor(box[0]), Math.ceil(box[3]) - Math.floor(box[1])]] : [[70, 80, 160, 140], [370, 120, 160, 160]];
  return { width: body.width, height: body.height, model: 'Mock SAM', device: 'test', elapsedMs: 12,
    regions: rects.map((bbox, index) => ({ id: 'cta-' + index, bbox, area: bbox[2] * bbox[3], predicted_iou: .99, segmentation: rectangleMask(body.width, body.height, bbox) })) };
}
async function open({ viewport = viewports[0], theme = 'light', reducedMotion = 'no-preference' } = {}) {
  const context = await browser.newContext({ viewport, acceptDownloads: true, reducedMotion });
  await context.addInitScript(theme => localStorage.setItem('asun-image-appearance', theme), theme);
  const page = await context.newPage();
  const session = { context, page, errors: [], calls: [], hold: false, fail: false, release: null, held: null };
  page.on('pageerror', error => session.errors.push(error.message));
  page.on('request', request => {
    if (![base, 'data:', 'blob:'].some(prefix => request.url().startsWith(prefix))) session.errors.push('Unexpected remote request: ' + request.url());
  });
  await page.route('**/api/local-detection/status', route => route.fulfill({ json: { available: true, token: 'cta-qa-token', model: 'Mock SAM', device: 'test' } }));
  await page.route('**/api/local-detection', async route => {
    const body = route.request().postDataJSON();
    session.calls.push({ body, headers: route.request().headers() });
    if (session.hold) await new Promise(resolve => { session.release = resolve; session.held?.(); });
    await route.fulfill(session.fail ? { status: 503, json: { error: 'Mock local detector unavailable' } } : { json: detection(body) });
  });
  try {
    await page.goto(base);
    await page.locator('#skipStartup').click();
    await page.waitForFunction(() => document.documentElement.dataset.ready === 'true' && document.documentElement.dataset.appearanceReady === 'true');
    assert.equal(await page.locator('html').getAttribute('data-theme'), theme);
    return session;
  } catch (error) { await context.close(); throw error; }
}
async function checked(name, options, run) {
  const session = await open(options);
  try {
    await run(session);
    assert.deepEqual(session.errors, [], 'No browser errors or remote requests');
    reports.push({ test: name, status: 'passed' });
  } catch (error) {
    reports.push({ test: name, status: 'failed', error: error.message });
    await session.page.screenshot({ path: path.join(qa, 'failure-' + name.replace(/\W+/g, '-') + '.png') }).catch(() => {});
    throw error;
  } finally { session.release?.(); await session.context.close(); }
}
async function fixture(page, name = 'Preserved MAIN.png') {
  const source = await page.evaluate(() => {
    const canvas = document.createElement('canvas'); canvas.width = 640; canvas.height = 420;
    const ctx = canvas.getContext('2d'), gradient = ctx.createLinearGradient(0, 0, 640, 420);
    gradient.addColorStop(0, '#719dc6'); gradient.addColorStop(1, '#dde9ed');
    ctx.fillStyle = gradient; ctx.fillRect(0, 0, 640, 420);
    ctx.fillStyle = '#3d596c'; ctx.fillRect(70, 80, 160, 140);
    ctx.fillStyle = '#bd9874'; ctx.fillRect(370, 120, 160, 160);
    return canvas.toDataURL('image/png');
  });
  return { name, mimeType: 'image/png', buffer: Buffer.concat([Buffer.from(source.split(',')[1], 'base64'), Buffer.from('\nExact preserved original: ' + name)]) };
}
async function upload(page, image) {
  await page.locator('#imageInput').setInputFiles(image);
  await page.waitForFunction(() => document.querySelectorAll('.layer-row').length === 1 && !document.body.classList.contains('busy'));
  assert.equal(await page.locator('#autoDetect').isEnabled(), true);
}
async function save(page) {
  const pending = page.waitForEvent('download');
  await page.locator('#saveProject').click();
  const download = await pending, stream = await download.createReadStream(), chunks = [];
  for await (const chunk of stream) chunks.push(chunk);
  await page.waitForTimeout(725);
  return JSON.parse(Buffer.concat(chunks).toString());
}
async function point(page, x, y) {
  const box = await page.locator('#board').boundingBox();
  return { x: box.x + x * box.width / 640, y: box.y + y * box.height / 420 };
}
async function mark(page) {
  await page.locator('.toolrail [data-tool=pencil]').click();
  const start = await point(page, 100, 100);
  await page.mouse.move(start.x, start.y); await page.mouse.down();
  for (const [x, y] of [[250, 100], [250, 240], [100, 240], [100, 100]]) {
    const target = await point(page, x, y); await page.mouse.move(target.x, target.y, { steps: 5 });
  }
  await page.mouse.up();
  await page.locator('#detectMarkedArea').waitFor({ state: 'visible' });
}
async function metrics(page, selector = '#autoDetect') {
  return page.evaluate(selector => {
    const rect = element => { const r = element.getBoundingClientRect(); return { x: r.x, y: r.y, right: r.right, bottom: r.bottom, width: r.width, height: r.height }; };
    const button = document.querySelector(selector), style = getComputedStyle(button);
    const visible = element => { const r = element.getBoundingClientRect(), s = getComputedStyle(element); return r.width > 0 && r.height > 0 && s.visibility !== 'hidden' && s.display !== 'none'; };
    const controls = [...document.querySelectorAll('.toolbar button, .toolbar input, .toolbar select')].filter(visible).map(element => {
      const bounds = rect(element), hit = document.elementFromPoint(bounds.x + bounds.width / 2, bounds.y + bounds.height / 2);
      return { id: element.id || element.getAttribute('aria-label'), ...bounds, centerHit: element === hit || element.contains(hit), disabled: element.disabled };
    });
    const bounds = rect(button), inset = 7;
    return { viewport: { width: innerWidth, height: innerHeight }, document: { width: document.documentElement.scrollWidth, height: document.documentElement.scrollHeight }, toolbar: rect(document.querySelector('.toolbar')), button: { ...bounds, tag: button.tagName, type: button.type, fontSize: parseFloat(style.fontSize), background: style.backgroundColor, text: button.textContent.trim(), hitPoints: [[bounds.x + bounds.width / 2, bounds.y + bounds.height / 2], [bounds.x + inset, bounds.y + inset], [bounds.right - inset, bounds.bottom - inset]].map(([x, y]) => button.contains(document.elementFromPoint(x, y))) }, controls };
  }, selector);
}
function assertLayout(info, label, { auto = true } = {}) {
  const b = info.button, viewport = info.viewport;
  assert.ok(Math.abs(b.x + b.width / 2 - viewport.width / 2) <= 2, `${label}: detection button is centered in the viewport (${JSON.stringify(b)})`);
  assert.equal(b.tag, 'BUTTON'); assert.equal(b.type, 'button');
  assert.ok(b.hitPoints.every(Boolean), `${label}: center and inset perimeter clicks reach the native button`);
  assert.ok(Math.abs(b.height - 68) <= .5, `${label}: 68px detection control`);
  assert.ok(Math.abs(b.width - 184) <= 2, `${label}: approximately 184px detection control`);
  if (auto) assert.ok(Math.abs(b.fontSize - 26) <= .5, `${label}: 26px Auto detect label`);
  const rgb = b.background.match(/[\d.]+/g)?.map(Number) || [];
  assert.ok(rgb[0] >= 100 && rgb[1] >= 160 && rgb[2] >= 200 && rgb[2] > rgb[0] + 10, `${label}: light-blue button fill (${b.background})`);
  assert.equal(info.document.width, viewport.width, `${label}: no horizontal page overflow`);
  assert.equal(info.document.height, viewport.height, `${label}: complete workspace fits the window`);
  for (const control of info.controls) {
    assert.ok(control.x >= -.5 && control.y >= -.5 && control.right <= viewport.width + .5 && control.bottom <= viewport.height + .5, `${label}: ${control.id} stays in the viewport`);
    assert.ok(control.y >= info.toolbar.y - .5 && control.bottom <= info.toolbar.bottom + .5, `${label}: ${control.id} stays inside the toolbar`);
    assert.equal(control.centerHit, true, `${label}: ${control.id} is unobstructed at its center`);
  }
  for (let i = 0; i < info.controls.length; i++) for (let j = i + 1; j < info.controls.length; j++) {
    const a = info.controls[i], c = info.controls[j];
    const overlapX = Math.min(a.right, c.right) - Math.max(a.x, c.x), overlapY = Math.min(a.bottom, c.bottom) - Math.max(a.y, c.y);
    assert.ok(overlapX <= .5 || overlapY <= .5, `${label}: ${a.id} and ${c.id} must not overlap (${overlapX.toFixed(2)} × ${overlapY.toFixed(2)})`);
  }
}
async function animationMetrics(page) {
  return page.locator('.detect-glow').evaluate(svg => ({ ariaHidden: svg.getAttribute('aria-hidden'), pointerEvents: getComputedStyle(svg).pointerEvents, insideButton: Boolean(svg.closest('button')), bounds: (() => { const r = svg.getBoundingClientRect(); return { width: r.width, height: r.height }; })(), rects: [...svg.querySelectorAll('rect')].map(rect => {
    const style = getComputedStyle(rect);
    return { className: rect.getAttribute('class'), fill: style.fill, stroke: style.stroke, dasharray: style.strokeDasharray, offset: parseFloat(style.strokeDashoffset), pointerEvents: style.pointerEvents, filter: style.filter, animations: rect.getAnimations().map(animation => ({ playState: animation.playState, currentTime: animation.currentTime, duration: animation.effect.getTiming().duration, iterations: animation.effect.getTiming().iterations === Infinity ? 'infinite' : animation.effect.getTiming().iterations })) };
  }) }));
}
async function record(name, value) {
  reports.push({ artifact: name, ...value });
  await writeFile(path.join(qa, name + '.json'), JSON.stringify(value, null, 2));
}

for (const theme of ['light', 'dark']) for (const viewport of viewports) {
  const name = `${theme}-${viewport.width}x${viewport.height}`;
  test(`centered detection CTA and unobstructed move, text and highlight controls at ${name}`, async () => checked(name, { viewport, theme }, async ({ page, calls }) => {
    const states = { empty: await metrics(page) };
    assert.equal(await page.locator('#autoDetect').isDisabled(), true);
    assertLayout(states.empty, `${name} empty workspace`);
    await upload(page, await fixture(page));
    for (const tool of ['move', 'text', 'highlight']) {
      await page.locator(`.toolrail [data-tool=${tool}]`).click();
      states[tool] = await metrics(page);
      await writeFile(path.join(qa, name + '-bounds.json'), JSON.stringify(states, null, 2));
      assertLayout(states[tool], `${name} ${tool}`);
      assert.equal(states[tool].button.text, 'Auto detect');
      await page.screenshot({ path: path.join(qa, `${name}-${tool}.png`) });
    }
    assert.equal(calls.length, 0, 'Changing tools and rendering the CTA does not run inference');
    await record(name + '-bounds', states);
  }));
}

for (const theme of ['light', 'dark']) {
  test(`${theme} perimeter animation progresses on a decorative non-interactive border`, async () => checked(theme + '-animation', { theme }, async ({ page }) => {
    await upload(page, await fixture(page));
    await page.mouse.move(20, 20);
    const before = await animationMetrics(page);
    assert.equal(before.ariaHidden, 'true'); assert.equal(before.pointerEvents, 'none'); assert.equal(before.insideButton, false, 'The SVG decoration stays outside the native button');
    assert.ok(before.rects.length >= 2, 'The border includes a soft halo and edge');
    const animated = before.rects.filter(rect => rect.animations.length);
    assert.ok(animated.length > 0, 'The rendered border has active animations');
    for (const rect of before.rects) {
      assert.equal(rect.pointerEvents, 'none'); assert.equal(rect.fill, 'none');
      assert.notEqual(rect.stroke, 'none'); assert.notEqual(rect.dasharray, 'none');
      for (const animation of rect.animations) { assert.equal(animation.playState, 'running'); assert.equal(animation.duration, 7000); assert.equal(animation.iterations, 'infinite'); }
    }
    assert.ok(before.rects.some(rect => /blur\(/.test(rect.filter)), 'A blurred border makes the halo soft');
    await page.waitForTimeout(260);
    const after = await animationMetrics(page);
    assert.ok(after.rects.some((rect, index) => Math.abs(rect.offset - before.rects[index].offset) > .1), 'Computed border dash offsets change as the highlight travels');
    assert.ok(after.rects.some((rect, index) => rect.animations.some((animation, i) => animation.currentTime - (before.rects[index].animations[i]?.currentTime || 0) >= 150)), 'The actual animation timeline advances');
    assertLayout(await metrics(page), theme + ' animated halo');
    await record(theme + '-animation', { before, after });
  }));

  test(`${theme} native detection click retains running, ready and error states and exact original bytes`, async () => checked(theme + '-behavior', { theme }, async session => {
    const { page } = session, image = await fixture(page);
    await upload(page, image); const original = await save(page);
    session.hold = true;
    const held = new Promise(resolve => { session.held = resolve; });
    await page.locator('#autoDetect').click(); await held;
    await page.waitForFunction(() => document.querySelector('#detectionStatus').dataset.state === 'running');
    assert.equal(await page.locator('#autoDetect').getAttribute('aria-busy'), 'true');
    assert.equal(await page.locator('#autoDetect').innerText(), 'Detecting…');
    assert.equal(await page.locator('.detect-glow rect').count(), 2, 'Updating button text preserves the separate animated border');
    assertLayout(await metrics(page), theme + ' running');
    await page.locator('#autoDetect').click();
    assert.equal(session.calls.length, 1, 'A second click while running does not start another inference');
    session.release(); session.hold = false;
    await page.waitForFunction(() => document.querySelector('#detectionStatus').dataset.state === 'ready');
    assert.equal(await page.locator('#autoDetect').getAttribute('aria-busy'), 'false');
    assert.equal(await page.locator('#autoDetect').innerText(), 'Auto detect');
    assert.equal(await page.locator('#detectAgain').isVisible(), true);
    assert.equal(session.calls[0].headers['x-asun-detection-token'], 'cta-qa-token');
    assert.deepEqual([session.calls[0].body.width, session.calls[0].body.height], [640, 420]);
    assertLayout(await metrics(page), theme + ' ready');
    assert.deepEqual(await save(page), original, 'Detection and its animated UI do not change the editable document');
    session.fail = true;
    await page.locator('#detectAgain').click();
    await page.waitForFunction(() => document.querySelector('#detectionStatus').dataset.state === 'error');
    assert.equal(session.calls.length, 2);
    assert.equal(await page.locator('#autoDetect').getAttribute('aria-busy'), 'false');
    assert.equal(await page.locator('#autoDetect').isEnabled(), true);
    assert.match(await page.locator('#detectionStatus').innerText(), /try again|manually/i);
    assert.match(await page.locator('#toast').innerText(), /Mock local detector unavailable/);
    assertLayout(await metrics(page), theme + ' error');
    await page.screenshot({ path: path.join(qa, `${theme}-detector-error.png`) });
    const after = await save(page);
    assert.deepEqual(after, original, 'A failed local detector leaves the editable document intact');
    assert.deepEqual(Buffer.from(after.assets[after.original.assetId].source.split(',')[1], 'base64'), image.buffer, 'Saved original retains every uploaded byte');
    await page.locator('#addText').click();
    assertLayout(await metrics(page), theme + ' manual text after detector error');
    await record(theme + '-behavior', { requests: session.calls.length, states: ['running', 'ready', 'error'], originalBytes: image.buffer.length, originalBytesPreserved: true });
  }));

  test(`${theme} selected-mark detection stays centered and opens the existing guided selection`, async () => checked(theme + '-guided', { theme }, async ({ page, calls }) => {
    const image = await fixture(page); await upload(page, image); await mark(page);
    assert.equal(await page.locator('#autoDetect').isVisible(), false);
    assert.equal(await page.locator('#detectMarkedArea').isEnabled(), true);
    const before = await save(page), states = {};
    for (const viewport of viewports) {
      await page.setViewportSize(viewport);
      states[viewport.width] = await metrics(page, '#detectMarkedArea');
      await writeFile(path.join(qa, theme + '-guided-bounds.json'), JSON.stringify(states, null, 2));
      assertLayout(states[viewport.width], `${theme} guided ${viewport.width}`, { auto: false });
      await page.screenshot({ path: path.join(qa, `${theme}-${viewport.width}x${viewport.height}-guided.png`) });
    }
    await page.locator('#detectMarkedArea').click();
    await page.locator('#guidedDetectionDialog').waitFor({ state: 'visible' });
    await page.waitForFunction(() => !document.querySelector('#confirmGuidedDetection').disabled);
    assert.equal(calls.length, 1); assert.ok(Array.isArray(calls[0].body.prompt?.box), 'Native guided CTA invokes the existing prompt-based detector');
    assert.equal(await page.locator('#guidedDetectionPreview').isVisible(), true);
    await page.locator('#cancelGuidedDetection').click();
    await page.locator('#guidedDetectionDialog').waitFor({ state: 'hidden' });
    assert.deepEqual(await save(page), before, 'Canceling the proposal preserves the editable mark and document');
    assert.deepEqual(Buffer.from(before.assets[before.original.assetId].source.split(',')[1], 'base64'), image.buffer);
    await record(theme + '-guided-bounds', states);
  }));

  test(`${theme} reduced motion keeps the button usable with a static decorative perimeter`, async () => checked(theme + '-reduced-motion', { theme, reducedMotion: 'reduce' }, async ({ page }) => {
    await upload(page, await fixture(page));
    const before = await animationMetrics(page);
    assert.equal(await page.evaluate(() => matchMedia('(prefers-reduced-motion: reduce)').matches), true);
    assert.ok(before.rects.every(rect => rect.animations.length === 0), 'Reduced motion disables every border animation');
    await page.waitForTimeout(260);
    const after = await animationMetrics(page);
    assert.deepEqual(after.rects.map(rect => rect.offset), before.rects.map(rect => rect.offset), 'Border highlight remains stationary');
    assert.equal(after.pointerEvents, 'none');
    assertLayout(await metrics(page), theme + ' reduced motion');
    await page.screenshot({ path: path.join(qa, `${theme}-reduced-motion.png`) });
    await record(theme + '-reduced-motion', { before, after });
  }));
}
