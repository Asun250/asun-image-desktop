import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { chromium } from 'playwright';
import { createServer } from '../server.mjs';

const qa = path.resolve('qa', 'reference-board-style');
let server, browser, page;
const errors = [];
before(async () => {
  await mkdir(qa, { recursive: true });
  server = createServer();
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  browser = await chromium.launch({ headless: true }); page = await browser.newPage();
  page.on('pageerror', error => errors.push(error.message));
  page.on('request', request => { if (![base, 'data:', 'blob:'].some(prefix => request.url().startsWith(prefix))) errors.push('Unexpected remote request: ' + request.url()); });
  await page.goto(base + '/health');
  await page.evaluate(async () => {
    window.core = await import('/core.mjs'); window.board = await import('/reference-board.mjs');
    window.fixture = (name, color, width, height) => {
      const canvas = document.createElement('canvas'); canvas.width = width; canvas.height = height;
      const ctx = canvas.getContext('2d'); ctx.fillStyle = color; ctx.fillRect(0, 0, width, height);
      ctx.fillStyle = '#fff4e5'; ctx.fillRect(width * .09, height * .12, width * .82, height * .73);
      ctx.fillStyle = '#88a583'; ctx.fillRect(width * .14, height * .26, width * .24, height * .38);
      ctx.fillStyle = '#d89a6e'; ctx.fillRect(width * .57, height * .34, width * .25, height * .36);
      const marker = Math.max(12, Math.min(width, height) * .06);
      for (const [x, y, color] of [[0, 0, '#ff0000'], [width - marker, 0, '#0000ff'], [0, height - marker, '#008000'], [width - marker, height - marker, '#ff8000']]) { ctx.fillStyle = color; ctx.fillRect(x, y, marker, marker); }
      return { name, width, height, source: canvas.toDataURL() };
    };
    window.pixel = (canvas, x, y) => [...canvas.getContext('2d').getImageData(Math.floor(x), Math.floor(y), 1, 1).data];
    const c = window.core, main = window.fixture('Editable MAIN.png', '#d7e4e5', 800, 500);
    let project = c.addRaster(c.newProject(), main).project;
    for (const [name, color, width, height] of [['Warm oak and soft light.png', '#e6bd94', 400, 240], ['Soft botanical texture.png', '#a9c1a0', 240, 360], ['Cream stone finish.png', '#e8e1d1', 400, 280]]) project = c.addReference(project, window.fixture(name, color, width, height));
    const [oak, plant, stone] = project.references;
    project = c.updateReferenceNotes(project, oak.id, 'Use this warm oak finish only.\nKeep the existing desk shape and proportions.');
    project = c.updateReferenceNotes(project, plant.id, 'Use the gentle green palette.\nPreserve the original window, glass, and reflections.');
    for (const [content, x, ids, comment] of [['1', 170, [oak.id, plant.id], 'Update the desk material.\nPreserve its shape and placement.'], ['2', 420, [stone.id], 'Use this stone finish on the selected area only.'], ['3', 620, [oak.id], 'Keep the scene lighting and composition.']]) {
      const added = c.addText(project, { content, x, y: 160, fontSize: 44, color: '#ff0000', width: 70, height: 70 });
      project = c.updateLabelComment(c.linkReferences(added.project, added.layerId, ids), added.layerId, comment);
    }
    window.demo = project; window.originalMain = main.source;
  });
});
after(async () => { try { assert.deepEqual(errors, []); } finally { await browser?.close(); if (server) await new Promise(resolve => server.close(resolve)); } });

test('the styled board keeps exact mappings, full image frames, original project data and theme-independent PNG bytes', async () => {
  const result = await page.evaluate(async () => {
    const project = window.demo, before = JSON.stringify(project), layout = window.board.referenceBoardLayout(project);
    document.documentElement.dataset.theme = 'light'; const light = await window.board.renderReferenceBoard(project), first = await window.board.exportReferenceBoard(project);
    document.documentElement.dataset.theme = 'dark'; const second = await window.board.exportReferenceBoard(project);
    const firstBytes = new Uint8Array(await first.arrayBuffer()), secondBytes = new Uint8Array(await second.arrayBuffer());
    const samples = layout.tiles.filter(tile => tile.image).map(tile => {
      const image = tile.image, source = tile.group.reference;
      return { labels: tile.group.labels, ratio: image.width / image.height, expectedRatio: source.width / source.height, corners: [[.015, .015], [.985, .015], [.015, .985], [.985, .985]].map(([x, y]) => window.pixel(light, image.x + image.width * x, image.y + image.height * y)) };
    });
    return { png: [...firstBytes], sameBytes: first.size === second.size && firstBytes.every((byte, index) => byte === secondBytes[index]), sourceSame: project.assets[project.original.assetId].source === window.originalMain, projectSame: JSON.stringify(project) === before, samples, mainRatio: layout.main.width / layout.main.height, expectedMainRatio: project.width / project.height, photoLabels: window.board.linkedReferences(project).map(group => group.labels), comments: window.board.linkedLabelComments(project).map(group => [group.label, group.comment]), size: [layout.width, layout.height] };
  });
  assert.equal(result.sameBytes, true, 'Selected UI appearance never changes exported PNG bytes');
  assert.equal(result.sourceSame, true); assert.equal(result.projectSame, true);
  assert.deepEqual(result.photoLabels, [['1', '3'], ['1'], ['2']]);
  assert.deepEqual(result.comments.map(([label]) => label), ['1', '2', '3']);
  assert.ok(Math.abs(result.mainRatio - result.expectedMainRatio) < 1e-9);
  for (const sample of result.samples) { assert.ok(Math.abs(sample.ratio - sample.expectedRatio) < 1e-9); assert.deepEqual(sample.corners, [[255, 0, 0, 255], [0, 0, 255, 255], [0, 128, 0, 255], [255, 128, 0, 255]], 'All four photo corners remain visible'); }
  const png = Buffer.from(result.png); await writeFile(path.join(qa, 'mixed-board.png'), png);
  delete result.png; await writeFile(path.join(qa, 'mixed-board-report.json'), JSON.stringify({ ...result, sha256: createHash('sha256').update(png).digest('hex') }, null, 2));
});

test('every wrapped label, filename and note still fits its established frame and every note line has readable rendered ink', async () => {
  const result = await page.evaluate(async () => {
    const c = window.core, b = window.board;
    let project = c.newProject(240, 160);
    const note = 'Keep the complete scene.\nCafé 日本 Ω — retain the natural texture.\n' + 'Use this detail without changing composition. '.repeat(30);
    project = c.addReference(project, window.fixture('Long descriptive reference filename '.repeat(9) + '.png', '#e6bd94', 180, 300));
    const added = c.addText(project, { content: '12 ' + 'Area description '.repeat(12), x: 10, y: 10, width: 70, height: 50 });
    project = c.updateReferenceNotes(c.linkReferences(added.project, added.layerId, [project.references[0].id]), project.references[0].id, note);
    const layout = b.referenceBoardLayout(project), tile = layout.tiles[0], output = await b.renderReferenceBoard(project), ctx = output.getContext('2d');
    const fits = (font, lines, width) => { ctx.font = font; return lines.every(line => ctx.measureText(line).width <= width + .01); };
    const ink = tile.noteLines.map((line, index) => {
      if (!line.trim()) return true;
      const data = ctx.getImageData(Math.floor(tile.notesFrame.x), Math.floor(tile.notesFrame.y + (index + 1) * 32), Math.floor(tile.notesFrame.width), 32).data;
      let dark = 0; for (let i = 0; i < data.length; i += 4) if (data[i] < 80 && data[i + 1] < 80 && data[i + 2] < 80) dark++;
      return dark > 40;
    });
    return { labelsFit: fits('600 24px Arial', tile.labelLines, tile.width - 48), namesFit: fits('20px Arial', tile.nameLines, tile.width - 48), notesFit: fits('24px Arial', tile.noteLines, tile.notesFrame.width), retained: tile.noteLines.join('\n').replaceAll('\n', '') === note.replaceAll('\n', ''), notesWithin: tile.notesFrame.y + tile.notesFrame.height <= tile.y + tile.height, ink, lineCount: tile.noteLines.length };
  });
  assert.equal(result.labelsFit, true); assert.equal(result.namesFit, true); assert.equal(result.notesFit, true); assert.equal(result.retained, true); assert.equal(result.notesWithin, true); assert.ok(result.ink.every(Boolean));
  await writeFile(path.join(qa, 'text-fit-report.json'), JSON.stringify(result, null, 2));
});
