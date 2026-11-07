import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {deflateSync} from 'node:zlib';
import {newProject, addRaster, addReference, addText, addDrawing, attachObjectRegion, linkReferences, updateLabelComment, updateLayer, referenceProject, updateReferenceAnnotations} from '../public/core.mjs';
import {imageGenerationPlan, hasImageGenerationInstructions, buildImageGenerationPrompt, imageGenerationPreviewDimensions} from '../public/image-generation-request.mjs';
import {prepareImageRequest} from '../desktop-image-request.mjs';

function png(width = 4, height = 4, red = 170) {
  const crc = bytes => {let result = 0xffffffff;for (const byte of bytes) {result ^= byte;for (let i = 0; i < 8; i++) result = (result >>> 1) ^ ((result & 1) ? 0xedb88320 : 0);}return (result ^ 0xffffffff) >>> 0;};
  const chunk = (kind, bytes) => {const data = Buffer.concat([Buffer.from(kind), bytes]), length = Buffer.alloc(4), checksum = Buffer.alloc(4);length.writeUInt32BE(bytes.length);checksum.writeUInt32BE(crc(data));return Buffer.concat([length, data, checksum]);};
  const header = Buffer.alloc(13);header.writeUInt32BE(width, 0);header.writeUInt32BE(height, 4);header[8] = 8;header[9] = 2;
  const scanlines = Buffer.alloc(height * (1 + width * 3));
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) scanlines[y * (1 + width * 3) + 1 + x * 3] = red;
  return Buffer.concat([Buffer.from([137,80,78,71,13,10,26,10]), chunk('IHDR', header), chunk('IDAT', deflateSync(scanlines)), chunk('IEND', Buffer.alloc(0))]);
}
const image = (name = 'Image.png', red = 170, width = 4, height = 4) => ({name, width, height, source:'data:image/png;base64,' + png(width, height, red).toString('base64')});
const request = project => ({requestId:randomUUID(), model:'gpt-image-2.5-sunburst', project, composition:project.layers.some(layer => layer.kind === 'raster' && layer.visible) ? image('Composition.png',170,project.width,project.height) : null});
function main() {const project=addRaster(newProject(), image('Current canvas.png')).project;project.imageOutput={version:1,aspect:'source'};return project;}
function areaFixture() {
  let project = addReference(main(), image('Bird appearance.png', 100));
  project.width=1024;project.height=1024;
  const added = addText(project, {content:'1', x:1, y:1, width:2, height:2, fontSize:1, color:'#ff0000'});
  project = linkReferences(added.project, added.layerId, [project.references[0].id]);
  project = updateLabelComment(project, added.layerId, 'Make all four birds look like the reference.');
  project = attachObjectRegion(project, added.layerId, {version:1, assetId:project.original.assetId, rasterLayerId:project.layers[0].id, sourceWidth:4, sourceHeight:4, mask:{width:4, height:4, counts:[0,1,2,1,8,1,2,1]}, group:{areaCount:4}});
  return {project, labelId:added.layerId, referenceId:project.references[0].id};
}

test('ordinary generation ignores sheet presets and uses global prompt without seven-view or white-background rules', () => {
  const project = main();project.prompt = 'A cinematic city street at night';project.sheetPreset = {active:true, views:7, notes:'IGNORE THIS SHEET NOTE', sourceId:'old deleted sheet source'};
  const before = structuredClone(project), prepared = prepareImageRequest(request(project));
  assert.equal(prepared.mode, 'image');
  assert.match(prepared.prompt, /A cinematic city street at night/);
  assert.match(prepared.prompt, /ONE finished image/);
  assert.equal(prepared.prompt.includes('IGNORE THIS SHEET NOTE'), false);
  assert.equal(prepared.prompt.includes('seven'), false);
  assert.equal(prepared.prompt.includes('#FFFFFF'), false);
  assert.deepEqual(project, before);
  assert.equal(Object.hasOwn(imageGenerationPlan(project).project, 'sheetPreset'), false);
});

test('blank canvas with a prompt is text-to-image; empty instructions are rejected before any paid work', () => {
  const project = newProject(1024, 1536);project.prompt = 'An origami phoenix in a glass garden';
  project.imageOutput={version:1,aspect:'2:3'};
  const prepared = prepareImageRequest({...request(project), composition:null});
  assert.equal(prepared.images.length, 0);
  assert.equal(prepared.size, '1024x1536');
  assert.match(prepared.prompt, /no base composition/);
  assert.equal(hasImageGenerationInstructions(project), true);
  project.prompt = '  ';
  assert.equal(hasImageGenerationInstructions(project), false);
  assert.throws(() => prepareImageRequest(request(project)), /Describe the image/);
  assert.throws(() => imageGenerationPlan(main()), /Describe the image/);
});

test('four-object group carries its shared instruction, exact reference bytes and an explicit disconnected selection mask', () => {
  const {project, labelId, referenceId} = areaFixture(), before = structuredClone(project);
  const body = {...request(project), guide:image('Annotation guide.png',170,1024,1024), areaMasks:[{id:labelId, image:image('Selection.png',255,1024,1024)}]};
  const prepared = prepareImageRequest(body);
  assert.equal(prepared.images.length, 4);
  assert.deepEqual(prepared.images[2].bytes, png(4, 4, 100));
  assert.match(prepared.prompt, /Make all four birds look like the reference/);
  assert.match(prepared.prompt, /"groupAreaCount": 4/);
  assert.match(prepared.prompt, /disconnected objects/);
  assert.match(prepared.prompt, /not the gaps or the entire bounding rectangle/);
  assert.match(prepared.prompt, /"role": "area selection mask"/);
  assert.ok(prepared.prompt.includes(referenceId));
  assert.equal(hasImageGenerationInstructions(project), true);
  assert.deepEqual(project, before);
});

test('hidden and off-canvas labels never expose their references as global inputs', () => {
  let {project, labelId, referenceId} = areaFixture();
  project = updateLayer(project, labelId, {visible:false});project.prompt = 'Warm evening light';
  let plan = imageGenerationPlan(project);
  assert.equal(plan.areas.length, 0);
  assert.equal(plan.references.some(reference => reference.id === referenceId), false);
  project = updateLayer(project, labelId, {visible:true, x:4000});
  plan = imageGenerationPlan(project);
  assert.equal(plan.areas.length, 0);
  assert.equal(plan.references.length, 0);
  project = updateLayer(project, labelId, {x:1});
  project = updateLayer(project, project.layers[0].id, {visible:false});
  plan = imageGenerationPlan(project);
  assert.equal(plan.areas.length, 0);
  assert.equal(plan.references.length, 0);
  assert.equal(plan.hasComposition, false);
});

test('unlinked global references and their visible annotation previews are mapped separately from original bytes', () => {
  let project = addReference(main(), image('Global design.png', 50));project.prompt = 'Use this design in the scene';
  const reference = project.references[0];
  const annotation = addText(referenceProject(reference), {content:'Only this trim', x:0, y:0, width:3, height:2, fontSize:1}).project.layers.slice(1);
  project = updateReferenceAnnotations(project, reference.id, annotation);
  project.references[0].notes = 'Keep the copper trim';
  const prepared = prepareImageRequest({...request(project), referencePreviews:[{id:reference.id, image:image('Annotated global.png', 60)}]});
  assert.equal(prepared.images.length, 3);
  assert.deepEqual(prepared.images[1].bytes, png(4, 4, 50));
  assert.deepEqual(prepared.images[2].bytes, png(4, 4, 60));
  assert.match(prepared.prompt, /reference annotation guide/);
  assert.match(prepared.prompt, /global prompt/);
  assert.match(prepared.prompt, /Keep the copper trim/);
  assert.throws(() => prepareImageRequest(request(project)), /Reference annotation guides/);
  assert.throws(() => prepareImageRequest({...request(project), referencePreviews:[{id:'not-selected', image:image()}]}), /unknown or duplicate/);
});

test('composition and guide inputs must match the current preview geometry, with no unexpected inputs', () => {
  const project = main();project.prompt = 'Add morning sunshine';
  assert.throws(() => prepareImageRequest({...request(project), composition:null}), /composition image.*missing/);
  assert.throws(() => prepareImageRequest({...request(project), composition:image('Wrong size.png', 1, 1, 1)}), /current canvas dimensions/);
  assert.throws(() => prepareImageRequest({...request(project), guide:image()}), /no visible annotation/);
  const empty = newProject();empty.prompt = 'A mountain';
  assert.throws(() => prepareImageRequest({...request(empty), composition:image()}), /no visible raster canvas/);
  assert.deepEqual(imageGenerationPreviewDimensions(5200, 2600), {width:2600, height:1300});
});

test('ambiguous labels, missing masks, extra masks, and missing overflow boards fail explicitly', () => {
  let {project, labelId} = areaFixture();
  assert.throws(() => prepareImageRequest({...request(project), guide:image('Guide.png',170,1024,1024)}), /Area selection masks/);
  assert.throws(() => prepareImageRequest({...request(project), guide:image('Guide.png',170,1024,1024), areaMasks:[{id:'wrong', image:image()}]}), /unknown or duplicate/);
  const duplicate = addText(project, {content:'1', x:0, y:0, width:1, height:1, fontSize:1});
  project = updateLabelComment(duplicate.project, duplicate.layerId, 'A different instruction');
  assert.throws(() => imageGenerationPlan(project), /different references or instructions/);
  project = main();project.prompt = 'Reference all these objects';
  for (let i = 0; i < 16; i++) project = addReference(project, image('Reference ' + i));
  assert.throws(() => prepareImageRequest(request(project)), /Reference boards are missing/);
});

test('request fingerprints bind exact composition, references, instructions and model but not dormant sheet settings', () => {
  const project = main();project.prompt = 'Blue morning light';
  const body = request(project), first = prepareImageRequest(body);
  project.sheetPreset = {anything:'ignored'};
  assert.equal(prepareImageRequest(body).fingerprint, first.fingerprint);
  assert.notEqual(prepareImageRequest({...body, composition:image('Changed pixels.png', 30)}).fingerprint, first.fingerprint);
  assert.notEqual(prepareImageRequest({...body, model:'gpt-image-1.5'}).fingerprint, first.fingerprint);
  project.prompt = 'Orange evening light';
  assert.notEqual(prepareImageRequest(body).fingerprint, first.fingerprint);
  assert.throws(() => prepareImageRequest({...body, model:'unknown-model'}), /supported image model/);
  assert.throws(() => prepareImageRequest({...body, requestId:'bad'}), /request ID/);
});

test('ordinary prompt keeps annotation instructions distinct from requested artwork text', () => {
  const project = main();project.prompt = 'Create gold 3D text reading EXAMPLE CITY above the street';
  const prompt = buildImageGenerationPrompt(project);
  assert.match(prompt, /Render text as part of the artwork only when the user explicitly requests/);
  assert.match(prompt, /EXAMPLE CITY/);
  assert.match(prompt, /Do not copy these marks/);
});

function sketchFixture() {
  let project = main();
  project.sketch = {version:1,background:'#ffffff',surfaceLayerId:project.layers[0].id};
  const stroke = addDrawing(project,{mode:'pencil',color:'#222222',size:1,points:[[1,1],[2,2],[3,1]]});
  project = stroke.project;
  const highlight = addDrawing(project,{mode:'highlight',color:'#ffff00',size:1,points:[[0,3],[3,3]]});
  return {project:highlight.project,strokeId:stroke.layerId,highlightId:highlight.layerId};
}

test('sketch pencil content is the scene composition, while highlights and numbered references are a separate guide', () => {
  let {project,strokeId,highlightId} = sketchFixture();
  project = addReference(project,image('Subject appearance.png',110));
  const label = addText(project,{content:'1',x:1,y:1,width:2,height:2,fontSize:1,color:'#ff0000'});
  project = updateLabelComment(linkReferences(label.project,label.layerId,[project.references[0].id]),label.layerId,'Make the drawn bird match this photograph.');
  const before = structuredClone(project), plan = imageGenerationPlan(project);
  assert.equal(plan.isSketch,true);
  assert.equal(plan.hasComposition,true);
  assert.deepEqual(plan.compositionLayers.map(layer=>layer.id),[project.sketch.surfaceLayerId,strokeId]);
  assert.deepEqual(plan.annotationLayers.map(layer=>layer.id),[highlightId,label.layerId]);
  assert.equal(plan.areas[0].label,'1');
  assert.equal(plan.references.length,1);
  const prepared = prepareImageRequest({...request(project),guide:image('Sketch guide.png')});
  assert.equal(prepared.images.length,3);
  assert.equal(prepared.inputRoles[0].role,'drawn scene composition');
  assert.match(prepared.prompt,/DRAWN SCENE REFERENCE/);
  assert.match(prepared.prompt,/Do not discard the drawn subjects/);
  assert.match(prepared.prompt,/white sketch surface is drawing paper, not a required final white background/);
  assert.match(prepared.prompt,/Only its additional numbers/);
  assert.match(prepared.prompt,/Make the drawn bird match this photograph/);
  assert.deepEqual(project,before,'Planning preserves all editable strokes and reference bindings.');
});

test('visible sketch content can generate without typed instructions, but blank or hidden drawing cannot', () => {
  const {project,strokeId,highlightId} = sketchFixture();
  assert.equal(hasImageGenerationInstructions(project),true);
  assert.match(buildImageGenerationPrompt(project),/Develop the drawn scene into a finished image/);
  const hidden = updateLayer(project,strokeId,{visible:false});
  assert.equal(hasImageGenerationInstructions(hidden),false,'The white surface and highlight alone are not a drawn scene.');
  assert.throws(()=>imageGenerationPlan(hidden),/Describe the image/);
  const ordinary = structuredClone(project);delete ordinary.sketch;ordinary.prompt='A bird in a garden';
  const plan = imageGenerationPlan(ordinary);
  assert.equal(plan.isSketch,false);
  assert.equal(plan.compositionLayers.length,1);
  assert.deepEqual(plan.annotationLayers.map(layer=>layer.id),[strokeId,highlightId]);
  assert.doesNotMatch(buildImageGenerationPrompt(ordinary),/DRAWN SCENE REFERENCE/);
});
