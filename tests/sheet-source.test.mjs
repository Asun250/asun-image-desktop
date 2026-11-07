import {test} from 'node:test';
import assert from 'node:assert/strict';
import {newProject, addRaster, addReference, removeReference, saveVariant, restoreVariant, serializeProject, parseProject} from '../public/core.mjs';
import {defaultSheetPreset, validateSheetPreset, getSheetPreset, getSheetSource, getSheetSources, withSheetPreset, sheetAngles, buildSheetPrompt} from '../public/sheet-preset.mjs';
import {exportSheetPack} from '../public/sheet-pack.mjs';

const red = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg==';
const transparent = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=';
const image = (name, source = red) => ({name, source, width:1, height:1});
function fixture() {
  let project = addRaster(newProject(), image('Canvas original.png')).project;
  project = addReference(project, image('Character reference.png', transparent));
  project = addReference(project, image('Extra details.png'));
  project.prompt = 'An unrelated scene edit';
  return project;
}

test('new sheets default to seven distinct views on white; saved nine-view presets stay compatible', () => {
  const project = fixture();
  assert.equal(defaultSheetPreset().views, 7);
  assert.equal(Object.hasOwn(defaultSheetPreset(), 'sourceId'), false);
  for (const subject of ['character', 'item', 'building']) {
    const preset = {...defaultSheetPreset(), subject};
    assert.equal(sheetAngles(preset).length, 7);
    assert.equal(new Set(sheetAngles(preset)).size, 7);
    assert.equal(sheetAngles(preset).includes(subject === 'character' ? 'Elevated front' : 'Top'), true);
    const prompt = buildSheetPrompt(withSheetPreset(project, {subject}));
    assert.match(prompt, /exactly 7 distinct camera angles/);
    assert.match(prompt, /pure WHITE \(#FFFFFF\) background/);
    assert.match(prompt, /ONE output image/);
    assert.equal(prompt.includes(project.prompt), false);
  }
  const old = {...defaultSheetPreset(), views:9};
  assert.deepEqual(validateSheetPreset(old, project), old);
  assert.equal(sheetAngles(old).length, 9);
  assert.deepEqual(getSheetPreset({...project, sheetPreset:old}), old);
});

test('subject sources can be references or canvas assets without changing the composition', () => {
  const project = fixture(), before = structuredClone(project), reference = project.references[0];
  const selected = withSheetPreset(project, {sourceId:reference.id, referenceIds:[reference.id, project.references[1].id]});
  assert.equal(getSheetSource(selected).id, reference.id);
  assert.equal(getSheetSource(project).id, project.original.assetId);
  assert.equal(getSheetSource(newProject()), null);
  assert.equal(getSheetSources(selected).length, 3);
  assert.deepEqual(project, before);
  assert.deepEqual(selected.original, before.original);
  assert.deepEqual(selected.layers, before.layers);
  assert.deepEqual(selected.assets, before.assets);
  assert.equal(selected.prompt, before.prompt);
  assert.deepEqual(parseProject(serializeProject(selected)), selected);
  assert.equal(buildSheetPrompt(selected).split(reference.name).length-1, 1, 'The MAIN is named once as a subject, not duplicated in supplemental references.');
  assert.equal(buildSheetPrompt(selected).includes(project.references[1].name), true);
  assert.equal(getSheetSource(withSheetPreset(selected, {sourceId:project.original.assetId})).id, project.original.assetId);
});

test('saved source selection rejects missing or unsupported data without weakening strict settings', () => {
  const project = fixture(), preset = defaultSheetPreset();
  for (const sourceId of ['', null, undefined, 5, {}, 'x'.repeat(201), 'missing-source', '__proto__']) {
    assert.throws(() => withSheetPreset(project, {sourceId}), /sheet subject photo/);
  }
  assert.throws(() => validateSheetPreset({...preset, unsupported:true}, project), /Unsupported/);
  const {notes, ...incomplete} = preset;
  assert.throws(() => validateSheetPreset(incomplete, project), /Unsupported/);
  assert.throws(() => withSheetPreset(project, {arbitrary:'setting'}), /Unsupported/);
});

test('deleting the chosen reference repairs active and variant presets, restoring the original MAIN', () => {
  let project = fixture();
  const referenceId = project.references[0].id;
  project = withSheetPreset(project, {sourceId:referenceId, referenceIds:project.references.map(reference => reference.id)});
  project = saveVariant(project, 'Reference sheet');
  const next = removeReference(project, referenceId);
  assert.equal(Object.hasOwn(next.sheetPreset, 'sourceId'), false);
  assert.equal(Object.hasOwn(next.variants[0].sheetPreset, 'sourceId'), false);
  assert.equal(next.sheetPreset.referenceIds.includes(referenceId), false);
  assert.equal(getSheetSource(next).id, project.original.assetId);
  assert.equal(getSheetSource(restoreVariant(next, next.variants[0].id)).id, project.original.assetId);
  assert.equal(project.sheetPreset.sourceId, referenceId, 'Removal must not mutate the previous history state.');
});

test('sheet pack promotes the selected reference to MAIN and preserves its exact original bytes once', async () => {
  const original = fixture(), source = original.references[0];
  const project = withSheetPreset(original, {sourceId:source.id, referenceIds:original.references.map(reference => reference.id)});
  const before = structuredClone(project), pack = await exportSheetPack(project);
  assert.deepEqual(project, before);
  assert.equal(pack.mapping.cleanMain.referenceId, source.id);
  assert.equal(pack.mapping.cleanMain.sourceId, source.id);
  assert.equal(Object.hasOwn(pack.mapping.cleanMain, 'assetId'), false);
  assert.equal(pack.mapping.cleanMain.originalFilename, source.name);
  assert.equal(pack.assets[0].role, 'main');
  assert.equal(pack.assets.length, 2);
  assert.deepEqual(Buffer.from(await pack.assets[0].blob.arrayBuffer()), Buffer.from(source.source.split(',')[1], 'base64'));
  assert.equal(pack.mapping.sheetReferences.length, 1);
  assert.equal(pack.mapping.sheetReferences[0].referenceId, original.references[1].id);
  assert.equal(pack.files.filter(file => file.name.startsWith('originals/')).length, 2);
  assert.equal(pack.mapping.angles.length, 7);
  assert.match(pack.request.prompt, /pure WHITE/);
});

test('reference-only projects can create a pack; original-source packs retain asset identity', async () => {
  const referenceOnly = addReference(newProject(), image('Only subject.png', transparent));
  const selected = withSheetPreset(referenceOnly, {sourceId:referenceOnly.references[0].id});
  const pack = await exportSheetPack(selected);
  assert.equal(selected.original, null);
  assert.equal(pack.mapping.cleanMain.referenceId, referenceOnly.references[0].id);
  const project = withSheetPreset(fixture(), {}), originalPack = await exportSheetPack(project);
  assert.equal(originalPack.mapping.cleanMain.assetId, project.original.assetId);
  assert.equal(Object.hasOwn(originalPack.mapping.cleanMain, 'sourceId'), false);
  await assert.rejects(exportSheetPack(withSheetPreset(newProject(), {})), /Choose a subject photo/);
});
