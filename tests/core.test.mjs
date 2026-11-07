import { test } from 'node:test';
import assert from 'node:assert/strict';
import { newProject, addRaster, addText, updateText, addDrawing, layerSourceDimensions, updateLayer, reorderLayer, removeLayer, duplicateLayer, addMaskStroke, saveVariant, restoreVariant, addReference, referenceLinks, linkReferences, linkReference, removeReference, referenceProject, updateReferenceAnnotations, updateReferenceNotes, MAX_REFERENCE_NOTE_LENGTH, serializeProject, parseProject, History, VERSION, MAX_STROKE_POINTS } from '../public/core.mjs';
import {linkedReferences} from '../public/reference-board.mjs';
const source = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg==';
const raster = (name = 'Original.png') => ({ name, source, width: 800, height: 600 });
function withImage() { return addRaster(newProject(),raster()); }
test('import fits first document and preserves all source bytes', () => {
  const before = newProject(), {project,layerId} = addRaster(before,raster());
  assert.deepEqual([project.width,project.height],[800,600]);
  assert.equal(before.layers.length,0);
  const edited = updateLayer(project,layerId,{x:35,y:22,width:400,height:300,opacity:0.4});
  assert.equal(edited.assets[edited.layers[0].assetId].source,source);
  assert.equal(project.layers[0].x,0);
});
test('reorder, duplicate and delete preserve original for before/after', () => {
  let { project,layerId } = withImage();
  const duplicate = duplicateLayer(project,layerId);
  project = reorderLayer(duplicate.project,duplicate.layerId,0);
  assert.equal(project.layers[0].id,duplicate.layerId);
  assert.equal(project.layers[0].assetId,project.layers[1].assetId);
  project = removeLayer(removeLayer(project,layerId),duplicate.layerId);
  assert.equal(project.layers.length,0);
  assert.equal(project.assets[project.original.assetId].source,source);
});
test('undo and redo restore transforms, masks, visibility and source bytes', () => {
  const {project,layerId} = withImage(), history = new History(project);
  const moved = updateLayer(project,layerId,{x:100,visible:false});
  history.commit(moved,'Move and hide');
  const painted = addMaskStroke(moved,layerId,{mode:'hide',size:30,points:[[12,14],[45,60]]});
  history.commit(painted,'Paint mask');
  assert.deepEqual(history.undo(),moved);
  assert.deepEqual(history.undo(),project);
  assert.deepEqual(history.redo(),moved);
  assert.deepEqual(history.redo(),painted);
  assert.equal(history.commit(painted,'No operation'),false);
});
test('editing after undo invalidates redo, returned history state is isolated', () => {
  const {project,layerId} = withImage(), history = new History(project);
  history.commit(updateLayer(project,layerId,{x:40}),'Move');
  history.undo();
  history.commit(updateLayer(project,layerId,{y:80}),'Move again');
  assert.equal(history.canRedo,false);
  const external = history.project; external.layers[0].x = 999;
  assert.equal(history.project.layers[0].x,0);
});
test('project save and reopen preserve masks, references, variants, prompt and originals', () => {
  const {project,layerId} = withImage();
  let edited = addMaskStroke(project,layerId,{mode:'hide',size:25,points:[[10,20],[30,40]]});
  edited = addMaskStroke(edited,layerId,{mode:'restore',size:10,points:[[10,20]]});
  edited = addReference(edited,raster('Reference.png')); edited.prompt = 'Warm studio lighting';
  edited = saveVariant(edited,'Warm version');
  const reopened = parseProject(serializeProject(edited));
  assert.deepEqual(reopened,edited);
  const changed = updateLayer(reopened,layerId,{brightness:130,visible:false});
  const restored = restoreVariant(changed,changed.variants[0].id);
  assert.equal(restored.layers[0].brightness,100);
  assert.equal(restored.layers[0].visible,true);
  assert.equal(restored.references[0].source,source);
});
test('invalid files and hostile dimensions fail with useful errors', () => {
  assert.throws(() => parseProject('nope'),/could not be read/);
  assert.throws(() => parseProject('{}'),/supported Asun/);
  assert.throws(() => newProject(999999,999999),/32 megapixels/);
  assert.throws(() => addRaster(newProject(),{...raster(),source:'https://example.com/image.png'}),/PNG, JPEG/);
  const {project,layerId} = withImage();
  assert.throws(() => updateLayer(project,layerId,{width:-1}),/layer size/);
  assert.throws(() => updateLayer(project,layerId,{x:NaN}),/layer position/);
  assert.throws(() => updateLayer(project,layerId,{opacity:2}),/appearance/);
  assert.throws(() => addMaskStroke(project,layerId,{mode:'hide',size:10,points:[[Infinity,0]]}),/mask point/);
  assert.throws(() => updateLayer(project,layerId,{source:'replacement'}),/Unsupported/);
});
test('missing assets, duplicate layer IDs and future formats are rejected', () => {
  const {project} = withImage();
  const missing = structuredClone(project); missing.assets = {};
  assert.throws(() => parseProject(JSON.stringify(missing)),/missing its original/);
  const duplicate = structuredClone(project); duplicate.layers.push(duplicate.layers[0]);
  assert.throws(() => parseProject(JSON.stringify(duplicate)),/Duplicate/);
  assert.throws(() => parseProject(JSON.stringify({...project,version:999})),/supported Asun/);
});
test('new layer is fitted within existing document', () => {
  const {project} = withImage();
  const next = addRaster(project,{...raster('Large'),width:1600,height:400}).project;
  assert.deepEqual([next.width,next.height],[800,600]);
  assert.deepEqual([next.layers[1].x,next.layers[1].y,next.layers[1].width,next.layers[1].height],[0,200,800,200]);
});
test('text stays editable across transform, update, undo, variants and reopening', () => {
  const {project: original} = withImage();
  const added = addText(original,{content:'First note',x:120,y:80,fontSize:36,color:'#eba76f',width:220,height:60});
  const layer = added.project.layers.at(-1);
  assert.equal(layer.kind,'text');
  assert.deepEqual(layerSourceDimensions(added.project,layer),{width:220,height:60});
  assert.equal(original.layers.length,1);
  const scaled = updateLayer(added.project,added.layerId,{width:440,height:120});
  const edited = updateText(scaled,added.layerId,{content:'Second note',width:240,height:70,color:'#ff0000'});
  assert.deepEqual([edited.layers.at(-1).width,edited.layers.at(-1).height],[480,140]);
  assert.equal(edited.layers.at(-1).text.content,'Second note');
  const history = new History(added.project);
  history.commit(edited,'Edit text');
  assert.deepEqual(history.undo(),added.project);
  assert.deepEqual(history.redo(),edited);
  const saved = saveVariant(edited,'With text');
  const reopened = parseProject(serializeProject(saved));
  assert.deepEqual(reopened,saved);
  const removed = removeLayer(reopened,added.layerId);
  assert.equal(restoreVariant(removed,saved.variants[0].id).layers.at(-1).text.content,'Second note');
  assert.equal(edited.assets[edited.original.assetId].source,source);
});
test('drawing strokes crop document points into independent editable local layers', () => {
  const before = newProject();
  const points = [[10,15],[30,25],[10,15]];
  const pencil = addDrawing(before,{mode:'pencil',color:'#ff0000',size:4,points});
  const layer = pencil.project.layers[0];
  assert.deepEqual([layer.x,layer.y,layer.width,layer.height],[7,12,26,16]);
  assert.deepEqual(layer.drawing.points,[[3,3],[23,13],[3,3]]);
  assert.deepEqual(layerSourceDimensions(pencil.project,layer),{width:26,height:16});
  assert.equal(layer.opacity,1);
  points[0][0]=999;
  assert.equal(layer.drawing.points[0][0],3);
  const highlight = addDrawing(pencil.project,{mode:'highlight',color:'#ffff00',size:20,points:[[50,50]]});
  assert.equal(highlight.project.layers[1].opacity,0.35);
  assert.equal(highlight.project.layers[1].drawing.mode,'highlight');
  assert.equal(highlight.project.original,null);
  const duplicate = duplicateLayer(highlight.project,highlight.layerId);
  assert.notEqual(duplicate.layerId,highlight.layerId);
  assert.deepEqual(duplicate.project.layers[2].drawing,duplicate.project.layers[1].drawing);
  const rasterAdded = addRaster(highlight.project,raster());
  assert.equal(rasterAdded.project.original.assetId,rasterAdded.project.layers[2].assetId);
});
test('version 1 projects and their saved variants migrate without losing source or masks', () => {
  const {project,layerId} = withImage();
  const saved = saveVariant(addMaskStroke(project,layerId,{mode:'hide',size:5,points:[[4,6]]}),'Legacy variant');
  saved.version = 1;
  for (const layer of saved.layers) delete layer.kind;
  for (const variant of saved.variants) for (const layer of variant.layers) delete layer.kind;
  const oldJSON = JSON.stringify(saved), reopened = parseProject(oldJSON);
  assert.equal(reopened.version,VERSION);
  assert.equal(reopened.layers[0].kind,'raster');
  assert.equal(reopened.variants[0].layers[0].kind,'raster');
  assert.deepEqual(reopened.layers[0].mask,saved.layers[0].mask);
  assert.equal(reopened.assets[reopened.original.assetId].source,source);
  assert.equal(JSON.parse(serializeProject(saved)).version,VERSION);
  assert.equal(restoreVariant(saved,saved.variants[0].id).layers[0].kind,'raster');
  assert.equal(JSON.stringify(saved),oldJSON,'Migration does not mutate imported state');
});
test('annotation validation rejects unbounded text, unsafe style, brushes and malformed points', () => {
  const project = newProject(), text = {content:'Note',x:10,y:10,fontSize:36,color:'#123456',width:100,height:60};
  assert.throws(() => addText(project,{...text,content:' '}),/annotation text/);
  assert.throws(() => addText(project,{...text,content:'x'.repeat(10001)}),/annotation text/);
  assert.throws(() => addText(project,{...text,fontFamily:'url(remote)'}),/text style/);
  assert.throws(() => addText(project,{...text,width:32768,height:32768}),/source size/);
  assert.throws(() => addText(project,{...text,color:'red'}),/text style/);
  assert.throws(() => addDrawing(project,{mode:'spray',color:'#123456',size:10,points:[[0,0]]}),/drawing brush/);
  assert.throws(() => addDrawing(project,{mode:'pencil',color:'#123456',size:10,points:[[Infinity,0]]}),/drawing point/);
  assert.throws(() => addDrawing(project,{mode:'pencil',color:'#123456',size:10,points:Array(MAX_STROKE_POINTS+1).fill([0,0])}),/drawing stroke/);
  assert.throws(() => addDrawing(project,{mode:'pencil',color:'#123456',size:10,points:[[0,0],[40000,40000]]}),/source size/);
  const {project:drawn} = addDrawing(project,{mode:'pencil',color:'#123456',size:10,points:[[10,10]]});
  drawn.layers[0].drawing.points[0][0] = -1;
  assert.throws(() => parseProject(JSON.stringify(drawn)),/outside their source/);
});
test('reference links survive text edits, duplicate, history, variants and project reopening',() => {
  let {project}=withImage();project=addReference(project,raster('Appearance.png'));
  const referenceId=project.references[0].id;
  const added=addText(project,{content:'1',x:20,y:20,width:60,height:60});
  const linked=linkReference(added.project,added.layerId,referenceId),history=new History(linked);
  assert.equal(added.project.layers.at(-1).referenceId,undefined,'Linking does not mutate the input');
  const edited=updateText(linked,added.layerId,{content:'2',color:'#ff0000'});
  assert.deepEqual(referenceLinks(edited.layers.at(-1)),[referenceId]);
  const duplicated=duplicateLayer(edited,added.layerId);
  assert.deepEqual(referenceLinks(duplicated.project.layers.at(-1)),[referenceId]);
  const saved=saveVariant(duplicated.project,'With appearance link');
  const reopened=parseProject(serializeProject(saved));assert.deepEqual(reopened,saved);
  const unlinked=linkReference(reopened,added.layerId,null);
  assert.equal(Object.hasOwn(unlinked.layers.find(layer=>layer.id===added.layerId),'referenceIds'),false);
  assert.deepEqual(referenceLinks(restoreVariant(unlinked,saved.variants[0].id).layers.find(layer=>layer.id===added.layerId)),[referenceId]);
  history.commit(linkReference(linked,added.layerId,null),'Unlink photo');
  assert.deepEqual(referenceLinks(history.undo().layers.at(-1)),[referenceId]);
  assert.deepEqual(referenceLinks(history.redo().layers.at(-1)),[]);
  assert.equal(reopened.references[0].source,source);assert.equal(reopened.assets[reopened.original.assetId].source,source);
});
test('removing a reference clears current and variant links while leaving other photos and source bytes',() => {
  let {project}=withImage();project=addReference(addReference(project,raster('First.png')),raster('Second.png'));
  const [first,second]=project.references;
  const one=addText(project,{content:'1',x:20,y:20,width:60,height:60});project=linkReference(one.project,one.layerId,first.id);
  const two=addText(project,{content:'2',x:80,y:20,width:60,height:60});project=linkReference(two.project,two.layerId,second.id);
  project=saveVariant(project,'Linked labels');
  const removed=removeReference(project,first.id);
  assert.deepEqual(removed.references.map(reference=>reference.id),[second.id]);
  for(const layers of [removed.layers,removed.variants[0].layers]) {
    assert.deepEqual(referenceLinks(layers.find(layer=>layer.id===one.layerId)),[]);
    assert.deepEqual(referenceLinks(layers.find(layer=>layer.id===two.layerId)),[second.id]);
  }
  assert.deepEqual(parseProject(serializeProject(removed)),removed);
  assert.equal(project.references[0].source,source,'The original state remains recoverable through history');
  assert.equal(removed.references[0].source,source);assert.equal(removed.assets[removed.original.assetId].source,source);
});
test('duplicate reference IDs, dangling links and links on image layers are rejected',() => {
  let {project,layerId}=withImage();project=addReference(project,raster('Reference.png'));
  const duplicate=structuredClone(project);duplicate.references.push(duplicate.references[0]);
  assert.throws(()=>parseProject(JSON.stringify(duplicate)),/Duplicate or invalid reference/);
  assert.throws(()=>linkReference(project,layerId,project.references[0].id),/text label/);
  const text=addText(project,{content:'1',x:10,y:10,width:60,height:60});
  assert.throws(()=>linkReference(text.project,text.layerId,'missing-photo'),/available reference/);
  assert.throws(()=>removeReference(project,'missing-photo'),/unavailable/);
  const dangling=structuredClone(text.project);dangling.layers.at(-1).referenceId='missing-photo';
  assert.throws(()=>parseProject(JSON.stringify(dangling)),/invalid reference photo link/);
  const imageLink=structuredClone(project);imageLink.layers[0].referenceId=project.references[0].id;
  assert.throws(()=>parseProject(JSON.stringify(imageLink)),/invalid reference photo link/);
  const saved=saveVariant(linkReference(text.project,text.layerId,project.references[0].id),'Linked');saved.variants[0].layers.at(-1).referenceId='missing';
  assert.throws(()=>parseProject(JSON.stringify(saved)),/invalid reference photo link/);
});
test('linked references group trimmed labels once and ignore hidden, transparent and off-canvas labels',() => {
  let {project}=withImage();project=addReference(addReference(project,raster('First.png')),raster('Second.png'));
  const [first,second]=project.references;
  function label(content,referenceId,patch={}) {
    const added=addText(project,{content,x:20,y:20,width:60,height:60});project=linkReference(added.project,added.layerId,referenceId);
    if(Object.keys(patch).length)project=updateLayer(project,added.layerId,patch);
  }
  label(' 2 ',second.id);label('1',first.id);label('3',first.id);label('1',first.id);
  label('Hidden',second.id,{visible:false});label('Transparent',second.id,{opacity:0});label('Outside',second.id,{x:project.width});
  assert.deepEqual(linkedReferences(project).map(group=>[group.reference.id,group.labels]),[[second.id,['2']],[first.id,['1','3']]]);
  assert.deepEqual(linkedReferences(newProject()),[]);
});
test('one label can link more than twelve photos, preserving order and removing only one photo',()=>{
  let project=newProject();for(let index=0;index<25;index++)project=addReference(project,raster(`Photo ${index}.png`));
  const added=addText(project,{content:'1',x:20,y:20,width:60,height:60}),ids=project.references.map(reference=>reference.id);
  project=linkReferences(added.project,added.layerId,[...ids,ids[0]]);
  assert.deepEqual(referenceLinks(project.layers[0]),ids,'Duplicate link choices are stored once');
  const returned=referenceLinks(project.layers[0]);returned.pop();assert.equal(project.layers[0].referenceIds.length,25);
  const duplicate=duplicateLayer(project,added.layerId);project=saveVariant(duplicate.project,'Many photos');
  const reopened=parseProject(serializeProject(project));assert.deepEqual(reopened,project);
  const removed=removeReference(reopened,ids[12]);
  for(const layers of [removed.layers,removed.variants[0].layers])for(const layer of layers)assert.deepEqual(referenceLinks(layer),ids.filter(referenceId=>referenceId!==ids[12]));
  assert.equal(linkedReferences(removed).length,24);
  const unlinked=linkReferences(removed,added.layerId,[]);assert.equal(Object.hasOwn(unlinked.layers[0],'referenceIds'),false);
  assert.throws(()=>linkReferences(project,added.layerId,['missing']),/available reference/);
  const malformed=structuredClone(project);malformed.layers[0].referenceIds.push(ids[0]);assert.throws(()=>parseProject(JSON.stringify(malformed)),/invalid reference photo link/);
});
test('version 2 single links and reference photos migrate to version 3 without losing saved variants',()=>{
  let project=addReference(newProject(),raster('Original photo.png'));
  const added=addText(project,{content:'1',x:20,y:20,width:60,height:60});project=saveVariant(linkReference(added.project,added.layerId,project.references[0].id),'Old link');
  project.version=2;for(const layers of [project.layers,project.variants[0].layers])for(const layer of layers){layer.referenceId=layer.referenceIds[0];delete layer.referenceIds;}
  for(const reference of project.references)delete reference.annotations;
  const oldJSON=JSON.stringify(project),reopened=parseProject(oldJSON);
  assert.equal(reopened.version,3);assert.deepEqual(reopened.references[0].annotations,[]);
  assert.deepEqual(reopened.layers[0].referenceIds,[project.references[0].id]);assert.equal(Object.hasOwn(reopened.layers[0],'referenceId'),false);
  assert.deepEqual(reopened.variants[0].layers[0].referenceIds,reopened.layers[0].referenceIds);
  assert.equal(reopened.references[0].source,source);assert.equal(JSON.stringify(project),oldJSON);
  assert.equal(JSON.parse(serializeProject(project)).version,3);
});
test('reference annotations stay native and editable while original photo bytes remain separate',()=>{
  let project=addReference(newProject(),raster('Editable reference.png'));
  const reference=project.references[0],base=referenceProject(reference),baseId=base.layers[0].id;
  assert.equal(baseId,`reference-base-${reference.id}`);assert.equal(referenceProject(reference).layers[0].assetId,base.layers[0].assetId);
  const text=addText(base,{content:'Detail',x:10,y:10,fontSize:30,color:'#ff0000',width:130,height:50});
  const painted=addDrawing(text.project,{mode:'pencil',color:'#0000ff',size:10,points:[[30,80],[120,80]]});
  const annotations=painted.project.layers.filter(layer=>layer.kind!=='raster');
  project=updateReferenceAnnotations(project,reference.id,annotations);
  annotations[0].text.content='Outside mutation';assert.equal(project.references[0].annotations[0].text.content,'Detail');
  assert.equal(project.references[0].source,source);assert.deepEqual(project.references[0].annotations.map(layer=>layer.kind),['text','drawing']);
  const reopened=parseProject(serializeProject(project)),editable=referenceProject(reopened.references[0]);
  assert.equal(editable.layers.length,3);assert.equal(editable.layers[0].id,baseId);assert.equal(editable.assets[editable.layers[0].assetId].source,source);
  const changed=updateText(editable,editable.layers[1].id,{content:'Revised',color:'#008000'});
  project=updateReferenceAnnotations(reopened,reference.id,changed.layers.filter(layer=>layer.kind!=='raster'));
  assert.equal(project.references[0].annotations[0].text.content,'Revised');assert.equal(project.references[0].source,source);
  const history=new History(reopened);history.commit(project,'Edit reference annotations');assert.equal(history.undo().references[0].annotations[0].text.content,'Detail');assert.equal(history.redo().references[0].annotations[0].text.content,'Revised');
});
test('reference annotation validation rejects embedded images, recursive links and invalid native controls',()=>{
  const project=addReference(newProject(),raster()),reference=project.references[0],editable=referenceProject(reference);
  assert.throws(()=>updateReferenceAnnotations(project,reference.id,[editable.layers[0]]),/only contain text or drawings/);
  const text=addText(editable,{content:'1',x:10,y:10,width:60,height:60}).project.layers[1];
  for(const patch of [{referenceIds:[reference.id]},{referenceId:reference.id},{annotations:[]},{assetId:'source'}])assert.throws(()=>updateReferenceAnnotations(project,reference.id,[{...text,...patch}]),/nested content/);
  assert.throws(()=>updateReferenceAnnotations(project,reference.id,[{...text,x:Infinity}]),/layer position/);
  const unsafe=structuredClone(text);unsafe.text.image=source;assert.throws(()=>updateReferenceAnnotations(project,reference.id,[unsafe]),/annotation content/);
  assert.throws(()=>updateReferenceAnnotations(project,reference.id,[{...text,id:`reference-base-${reference.id}`}]),/annotation identifier/);
});

test('reference notes preserve exact multiline instructions, shared links and native annotations through history and reopening',()=>{
  let {project}=withImage();project=addReference(project,raster('Snow reference.png'));
  const reference=project.references[0];assert.equal(reference.notes,'');
  const edit=addDrawing(referenceProject(reference),{mode:'pencil',color:'#ff0000',size:5,points:[[10,10],[40,30]]});
  project=updateReferenceAnnotations(project,reference.id,edit.project.layers.filter(layer=>layer.kind!=='raster'));
  for(const content of ['1','2']) {const added=addText(project,{content,x:10,y:10,width:60,height:60});project=linkReference(added.project,added.layerId,reference.id);}
  project=saveVariant(project,'Shared reference');
  const before=JSON.stringify(project),notes='Only apply snow caps.\r\nKeep glass clear.\n\nDo not alter the desk. 🏔️',next=updateReferenceNotes(project,reference.id,notes);
  assert.equal(JSON.stringify(project),before,'Editing notes leaves the input project untouched');
  assert.equal(next.references[0].notes,notes);assert.equal(next.references[0].source,source);
  assert.deepEqual(next.references[0].annotations,project.references[0].annotations);
  assert.deepEqual(next.layers,project.layers);assert.deepEqual(next.assets,project.assets);assert.deepEqual(next.variants,project.variants);
  assert.deepEqual(linkedReferences(next).map(group=>[group.labels,group.reference.notes]),[[['1','2'],notes]]);
  const reopened=parseProject(serializeProject(next));assert.deepEqual(reopened,next);
  assert.equal(restoreVariant(reopened,reopened.variants[0].id).references[0].notes,notes);
  const history=new History(project);history.commit(next,'Edit reference notes');assert.equal(history.undo().references[0].notes,'');assert.equal(history.redo().references[0].notes,notes);
});

test('older missing reference notes remain blank without adding fields on reopen or a blank save',()=>{
  const project=addReference(newProject(),raster());delete project.references[0].notes;
  for(const version of [1,2,3]) {
    const legacy={...project,version},before=JSON.stringify(legacy),reopened=parseProject(before);
    assert.equal(Object.hasOwn(reopened.references[0],'notes'),false);
    assert.equal(Object.hasOwn(JSON.parse(serializeProject(legacy)).references[0],'notes'),false);
    const blank=updateReferenceNotes(reopened,reopened.references[0].id,'');assert.deepEqual(blank,reopened);
    assert.equal(new History(reopened).commit(blank,'Save blank notes'),false);
    assert.equal(JSON.stringify(legacy),before);
  }
});

test('reference note validation enforces string and length without changing sources or instructions',()=>{
  assert.equal(MAX_REFERENCE_NOTE_LENGTH,2000);
  const project=addReference(newProject(),raster()),referenceId=project.references[0].id,before=JSON.stringify(project);
  const max=updateReferenceNotes(project,referenceId,'x'.repeat(2000));assert.equal(parseProject(serializeProject(max)).references[0].notes.length,2000);
  for(const notes of [null,undefined,42,{},['Only snow'],'x'.repeat(2001)]) {
    assert.throws(()=>updateReferenceNotes(project,referenceId,notes),/notes must be text up to 2000/);
    const invalid=structuredClone(project);invalid.references[0].notes=notes;
    if(notes!==undefined)assert.throws(()=>parseProject(JSON.stringify(invalid)),/notes must be text up to 2000/);
  }
  assert.throws(()=>updateReferenceNotes(project,'missing','Only snow'),/unavailable/);
  assert.equal(JSON.stringify(project),before);
});

test('original file identity and independent thumbnail survive edits, history, variants and reference projects',()=>{
  const byteLength=Buffer.from(source.split(',')[1],'base64').length,name='Original '+('雪'.repeat(300))+'.png';
  const image={name,source,width:800,height:600,originalFile:{name,mimeType:'image/png',byteLength},preview:{source,width:1,height:1,kind:'generated-thumbnail'}};
  const added=addRaster(newProject(),image),assetId=added.project.layers[0].assetId;
  let project=addReference(added.project,image);const referenceId=project.references[0].id;
  image.originalFile.name='External mutation';image.preview.kind='External mutation';
  assert.equal(project.assets[assetId].name,name);assert.equal(project.references[0].name,name);
  assert.equal(project.assets[assetId].originalFile.name,name);assert.equal(project.references[0].preview.kind,'generated-thumbnail');
  const before=structuredClone(project),edited=updateLayer(project,added.layerId,{x:-100,y:-80,width:400,height:300,brightness:125});
  project={...edited,width:400,height:300};
  const annotated=addText(project,{content:'Snow caps only',x:10,y:10,width:260,height:60});project=saveVariant(annotated.project,'Annotated crop');
  project=updateReferenceNotes(project,referenceId,'Keep original details.');
  const editable=referenceProject(project.references[0]),base=editable.assets[editable.layers[0].assetId];
  assert.deepEqual([base.source,base.originalFile,base.preview],[before.references[0].source,before.references[0].originalFile,before.references[0].preview]);
  const reopened=parseProject(serializeProject(project));assert.deepEqual(reopened,project);
  assert.deepEqual(reopened.assets[assetId],before.assets[assetId]);
  const history=new History(before);history.commit(project,'Crop and annotate');assert.deepEqual(history.undo(),before);assert.deepEqual(history.redo(),project);
  const legacy=structuredClone(before);delete legacy.assets[assetId].originalFile;delete legacy.assets[assetId].preview;delete legacy.references[0].originalFile;delete legacy.references[0].preview;
  assert.deepEqual(parseProject(serializeProject(legacy)),legacy,'Older missing metadata remains compatible without adding fields');
});

test('invalid file identity and thumbnail metadata cannot be saved as original source information',()=>{
  const byteLength=Buffer.from(source.split(',')[1],'base64').length,originalFile={name:'Original.png',mimeType:'image/png',byteLength},preview={source,width:1,height:1,kind:'generated-thumbnail'};
  for(const patch of [{name:''},{name:'x'.repeat(501)},{mimeType:'image/jpeg'},{byteLength:byteLength+1},{byteLength:Infinity},{byteLength:0}])assert.throws(()=>addRaster(newProject(),{...raster(),originalFile:{...originalFile,...patch}}),/original file information/);
  for(const patch of [{kind:'original'},{width:513},{height:0},{source:'https://example.com/thumbnail.png'}])assert.throws(()=>addReference(newProject(),{...raster(),preview:{...preview,...patch}}),/generated image thumbnail/);
  assert.throws(()=>addReference(newProject(),{...raster(),preview:{...preview,width:2}}),/does not match/);
  const project=addReference(newProject(),{...raster(),originalFile,preview});project.references[0].originalFile.byteLength++;
  assert.throws(()=>serializeProject(project),/original file information/);
});

