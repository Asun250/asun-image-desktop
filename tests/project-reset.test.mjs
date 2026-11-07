import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {deflateSync} from 'node:zlib';
import {newProject,addRaster,addText,addDrawing,addReference,addMaskStroke,attachObjectRegion,linkReferences,updateLabelComment,updateReferenceNotes,updateReferenceAnnotations,saveVariant,serializeProject,parseProject,History,validateProject,VERSION} from '../public/core.mjs';
import {originalBlob} from '../public/image-source.mjs';
import {nextObjectNumber} from '../public/object-regions.mjs';
import {hasProjectContent,resetProject} from '../public/project-reset.mjs';

const payload='iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg==';
const source='data:image/png;base64,'+payload;
const image=(name='Original.png')=>({name,width:1,height:1,source,originalFile:{name,mimeType:'image/png',byteLength:Buffer.from(payload,'base64').length},preview:{kind:'generated-thumbnail',width:1,height:1,source}});
function nextImage(){
  const crc=bytes=>{let value=0xffffffff;for(const byte of bytes){value^=byte;for(let bit=0;bit<8;bit++)value=(value>>>1)^((value&1)?0xedb88320:0);}return(value^0xffffffff)>>>0;};
  const chunk=(type,bytes)=>{const name=Buffer.from(type),length=Buffer.alloc(4),checksum=Buffer.alloc(4);length.writeUInt32BE(bytes.length);checksum.writeUInt32BE(crc(Buffer.concat([name,bytes])));return Buffer.concat([length,name,bytes,checksum]);};
  const width=320,height=240,name='Next scene.png',header=Buffer.alloc(13);header.writeUInt32BE(width);header.writeUInt32BE(height,4);header[8]=8;header[9]=2;
  const pixels=Buffer.alloc((width*3+1)*height,128);for(let row=0;row<height;row++)pixels[row*(width*3+1)]=0;
  const bytes=Buffer.concat([Buffer.from([137,80,78,71,13,10,26,10]),chunk('IHDR',header),chunk('IDAT',deflateSync(pixels)),chunk('IEND',Buffer.alloc(0))]);
  return {name,width,height,source:'data:image/png;base64,'+bytes.toString('base64'),originalFile:{name,mimeType:'image/png',byteLength:bytes.length}};
}
function fixture(){
  const imported=addRaster(newProject(),image()),label=addText(imported.project,{content:'1',fontSize:32,color:'#eba76f',x:0,y:0,width:45,height:50});
  let project=attachObjectRegion(label.project,label.layerId,{version:1,assetId:imported.project.layers[0].assetId,rasterLayerId:imported.layerId,sourceWidth:1,sourceHeight:1,mask:{width:1,height:1,counts:[0,1]}});
  project=updateLabelComment(project,label.layerId,'Remove the black bar.\nPreserve the entire scene.');
  project=addDrawing(project,{mode:'highlight',color:'#ffff00',size:20,points:[[20,30],[80,90]]}).project;
  project=addMaskStroke(project,imported.layerId,{mode:'hide',size:12,points:[[0,0],[1,1]]});
  project=addReference(project,image('Linked reference.png'));project=addReference(project,image('Unassigned reference.png'));project=linkReferences(project,label.layerId,[project.references[0].id]);project=updateReferenceNotes(project,project.references[0].id,'Only apply its texture.');
  const annotation=addText(newProject(),{content:'A',fontSize:12,color:'#ff0000',x:0,y:0,width:15,height:20}).project.layers;
  project=updateReferenceAnnotations(project,project.references[0].id,annotation);project.name='Saved rich scene';project.width=1224;project.height=816;project.prompt='Preserve the camera and composition.';project=saveVariant(project,'Before reset');
  return validateProject(project);
}
function freeze(value){if(value&&typeof value==='object'&&!Object.isFrozen(value)){Object.freeze(value);for(const child of Object.values(value))freeze(child);}return value;}
const digest=bytes=>createHash('sha256').update(bytes).digest('hex');

test('reset clears all current content into a fresh default project without changing the rich input',()=>{
  const project=fixture(),saved=serializeProject(project),before=structuredClone(project);assert.equal(hasProjectContent(project),true);
  const clean=resetProject(freeze(project));assert.deepEqual(clean,newProject());assert.equal(clean.version,VERSION);assert.notEqual(clean,project);assert.equal(hasProjectContent(clean),false);
  assert.deepEqual(project,before);assert.equal(serializeProject(project),saved);assert.equal(nextObjectNumber(clean),'1');
  const serialized=serializeProject(clean);assert.equal(serialized.includes(source),false);assert.equal(serialized.includes(payload),false);assert.equal(serialized.includes('Linked reference'),false);assert.equal(serialized.includes('Preserve the camera'),false);assert.deepEqual(parseProject(serialized),newProject());
});

test('one undo restores every source, edit and variant byte-for-byte while redo returns to the fresh project',async()=>{
  const project=fixture(),oldSavedFile=Buffer.from(serializeProject(project)),oldHash=digest(oldSavedFile),history=new History(project),clean=resetProject(project);
  assert.equal(history.commit(clean,'Delete all — start fresh'),true);assert.equal(history.index,1);assert.equal(history.canUndo,true);assert.deepEqual(history.undo(),project);
  const restored=history.project,sourceId=project.original.assetId;
  assert.equal(digest(Buffer.from(await originalBlob(restored.assets[sourceId]).arrayBuffer())),digest(Buffer.from(payload,'base64')));
  for(const reference of restored.references)assert.equal(digest(Buffer.from(await originalBlob(reference).arrayBuffer())),digest(Buffer.from(payload,'base64')));
  assert.deepEqual(restored.references,project.references);assert.deepEqual(restored.variants,project.variants);assert.deepEqual(restored.layers,project.layers);assert.deepEqual(restored.original,project.original);
  assert.deepEqual(history.redo(),clean);assert.deepEqual(history.project,newProject());assert.equal(digest(oldSavedFile),oldHash);assert.deepEqual(parseProject(oldSavedFile.toString()),project);
});

test('default empty reset is an identity no-op but changed settings, whitespace prompts and retained data still count',()=>{
  const clean=newProject(),history=new History(clean);assert.equal(hasProjectContent(clean),false);assert.equal(resetProject(freeze(clean)),clean);assert.equal(history.commit(clean,'Delete all'),false);assert.equal(history.canUndo,false);
  for(const modified of [newProject(1000,700),newProject(1600,1000,'Custom name'),{...newProject(),prompt:'\n  '},saveVariant(newProject(),'Empty saved variant')]){
    assert.equal(hasProjectContent(modified),true);assert.deepEqual(resetProject(modified),newProject());
  }
  const retained=fixture();retained.layers=[];assert.equal(hasProjectContent(retained),true);assert.deepEqual(resetProject(retained),newProject());
  const referencesOnly=addReference(newProject(),image('Unassigned.png'));assert.equal(hasProjectContent(referencesOnly),true);assert.deepEqual(resetProject(referencesOnly),newProject());
});

test('reopening a reset project and importing a new photo establishes a new main source without carrying old links or bytes',()=>{
  const old=fixture(),clean=parseProject(serializeProject(resetProject(old))),newFile=nextImage(),imported=addRaster(clean,newFile);
  assert.deepEqual([imported.project.width,imported.project.height],[320,240]);assert.equal(imported.project.layers.length,1);assert.equal(imported.project.layers[0].id,imported.layerId);assert.equal(imported.project.original.assetId,imported.project.layers[0].assetId);assert.notEqual(imported.project.original.assetId,old.original.assetId);
  assert.deepEqual(Object.keys(imported.project.assets),[imported.project.original.assetId]);assert.equal(imported.project.assets[imported.project.original.assetId].originalFile.name,'Next scene.png');assert.equal(imported.project.assets[old.original.assetId],undefined);assert.deepEqual(imported.project.references,[]);assert.deepEqual(imported.project.variants,[]);assert.equal(imported.project.prompt,'');assert.equal(nextObjectNumber(imported.project),'1');assert.deepEqual(parseProject(serializeProject(imported.project)),imported.project);
  assert.equal(imported.project.assets[imported.project.original.assetId].source,newFile.source);assert.equal(serializeProject(imported.project).includes(source),false,'The newly saved project contains only the new image bytes');
});

test('supported legacy projects reset to the current schema and unsupported projects are rejected without mutation',()=>{
  for(const version of [1,2]){
    const legacy={...newProject(),version},before=JSON.stringify(legacy);assert.equal(hasProjectContent(legacy),true);const clean=resetProject(legacy);assert.equal(clean.version,VERSION);assert.deepEqual(clean,newProject());assert.equal(JSON.stringify(legacy),before);assert.deepEqual(parseProject(serializeProject(clean)),clean);
  }
  const invalid={...newProject(),version:999},before=JSON.stringify(invalid);assert.throws(()=>resetProject(invalid),/supported Asun IMG/);assert.equal(JSON.stringify(invalid),before);
});
