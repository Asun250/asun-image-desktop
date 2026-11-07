import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {deflateSync} from 'node:zlib';
import {newProject,addRaster,addReference,addText,addDrawing,updateLayer,referenceProject,updateReferenceAnnotations,updateReferenceNotes,removeReference,saveVariant,restoreVariant,parseProject,serializeProject} from '../public/core.mjs';
import {defaultSheetPreset,getSheetPreset,getSheetSource,getSheetSubjectSources,getSheetPhoto,getSheetInputPhotos,getSheetDetailSources,withSheetPreset,withSheetPhotoEdits,buildSheetPrompt,validateSheetPreset} from '../public/sheet-preset.mjs';
import {sheetGenerationPlan,buildSheetGenerationInput,sheetPreviewDimensions} from '../public/sheet-generation-input.mjs';
import {prepareSheetRequest} from '../desktop-sheet-service.mjs';
import {exportSheetPack} from '../public/sheet-pack.mjs';

function png(red=100,width=4,height=4){
  const crc=bytes=>{let n=0xffffffff;for(const byte of bytes){n^=byte;for(let i=0;i<8;i++)n=(n>>>1)^((n&1)?0xedb88320:0);}return(n^0xffffffff)>>>0;};
  const chunk=(kind,bytes)=>{const data=Buffer.concat([Buffer.from(kind),bytes]),size=Buffer.alloc(4),check=Buffer.alloc(4);size.writeUInt32BE(bytes.length);check.writeUInt32BE(crc(data));return Buffer.concat([size,data,check]);};
  const header=Buffer.alloc(13);header.writeUInt32BE(width,0);header.writeUInt32BE(height,4);header[8]=8;header[9]=2;
  const scan=Buffer.alloc(height*(1+width*3));for(let y=0;y<height;y++)for(let x=0;x<width;x++)scan[y*(1+width*3)+1+x*3]=red;
  return Buffer.concat([Buffer.from([137,80,78,71,13,10,26,10]),chunk('IHDR',header),chunk('IDAT',deflateSync(scan)),chunk('IEND',Buffer.alloc(0))]);
}
const image=(name,red=100,width=4,height=4)=>({name,source:'data:image/png;base64,'+png(red,width,height).toString('base64'),width,height});
function fixture(){
  let project=addRaster(newProject(),image('Front building.png',10)).project;
  project=addRaster(project,image('Side building.png',20)).project;
  const primary=project.original.assetId,side=project.layers.at(-1).assetId;
  project=addReference(project,image('Rear building.png',30));const rear=project.references.at(-1).id;
  project=addReference(project,image('Stone detail.png',40));const detail=project.references.at(-1).id;
  project=addReference(project,image('Unused photo.png',50));
  project=withSheetPreset(project,{subject:'building',subjectIds:[side,rear],referenceIds:[rear,detail],notes:'Only the Example building.'});
  return {project,primary,side,rear,detail};
}
function textMark(photo,text='Example only'){
  return addText(referenceProject(photo),{content:text,x:0,y:0,width:3,height:2,fontSize:1,color:'#ff0000'}).project.layers.slice(1);
}
const payload=project=>({requestId:randomUUID(),project,model:'gpt-image-1'});
const previews=project=>sheetGenerationPlan(project).annotated.map(({photo},index)=>({id:photo.id,image:image('Guide.png',200+index)}));

test('legacy preset v1 remains unchanged; multi-photo fields validate without loosening annotation rules',()=>{
  const {project,primary}=fixture(),legacy=defaultSheetPreset();
  assert.deepEqual(validateSheetPreset(legacy,project),legacy);
  assert.equal(Object.hasOwn(legacy,'subjectIds'),false);assert.equal(Object.hasOwn(legacy,'photoEdits'),false);
  for(const subjectIds of [[primary,primary],['missing'],[null],'bad'])assert.throws(()=>withSheetPreset(project,{subjectIds}),/subject photo/);
  const valid={id:primary,annotations:[],notes:''};
  for(const photoEdits of [[valid,valid],[{...valid,id:'missing'}],[{...valid,notes:9}],[{...valid,notes:'x'.repeat(2001)}],[{...valid,extra:true}]])assert.throws(()=>withSheetPreset(project,{photoEdits}),/photo/);
  assert.throws(()=>withSheetPhotoEdits(project,primary,{annotations:[project.layers[0]]}),/only contain text or drawings/);
  const unsafe=textMark(getSheetPhoto(project,primary));unsafe[0].referenceIds=[project.references[0].id];
  assert.throws(()=>withSheetPhotoEdits(project,primary,{annotations:unsafe}),/cannot contain/);
  assert.throws(()=>withSheetPhotoEdits(project,primary,{source:'replacement'}),/Unsupported/);
});

test('subject roles dedupe selected IDs and detail roles cannot duplicate subject photos',()=>{
  const {project,primary,side,rear,detail}=fixture(),mixed=withSheetPreset(project,{subjectIds:[primary,side,rear]});
  assert.deepEqual(getSheetSubjectSources(mixed).map(photo=>photo.id),[primary,side,rear]);
  assert.deepEqual(getSheetDetailSources(mixed).map(photo=>photo.id),[detail]);
  assert.deepEqual(getSheetInputPhotos(mixed).map(entry=>[entry.role,entry.photo.id]),[['main',primary],['subject',side],['subject',rear],['reference',detail]]);
  assert.equal(getSheetPhoto(mixed,'missing'),null);
});

test('photo edits inherit existing reference annotations then remain isolated from original bytes and shared references',()=>{
  let {project,rear}=fixture();
  const originalPhoto=getSheetPhoto(project,rear),annotations=textMark(originalPhoto,'Rear facade only');
  project=updateReferenceAnnotations(project,rear,annotations);project=updateReferenceNotes(project,rear,'Original reference note');
  const before=structuredClone(project);
  assert.deepEqual(getSheetPhoto(project,rear).annotations,annotations);
  const edited=withSheetPhotoEdits(project,rear,{notes:'Use only the circled rear wall.'});
  assert.equal(getSheetPhoto(edited,rear).notes,'Use only the circled rear wall.');
  assert.deepEqual(getSheetPhoto(edited,rear).annotations,annotations);
  assert.equal(edited.references.find(photo=>photo.id===rear).notes,'Original reference note');
  assert.deepEqual(edited.layers,before.layers);assert.deepEqual(edited.original,before.original);assert.deepEqual(edited.assets,before.assets);
  assert.equal(getSheetPhoto(edited,rear).source,originalPhoto.source);
  const returned=getSheetPhoto(edited,rear);returned.annotations[0].text.content='Not saved';
  assert.equal(getSheetPhoto(edited,rear).annotations[0].text.content,'Rear facade only');
  assert.deepEqual(project,before);
  const cleared=withSheetPhotoEdits(edited,rear,{annotations:[],notes:''});
  assert.deepEqual(getSheetPhoto(cleared,rear).annotations,[]);assert.equal(getSheetPhoto(cleared,rear).notes,'');
});

test('saved projects and variants retain editable per-photo marks; deletion repairs all saved subject/detail/edit links',()=>{
  let {project,rear}=fixture();project=withSheetPhotoEdits(project,rear,{annotations:textMark(getSheetPhoto(project,rear)),notes:'Exact annotated target'});
  project=saveVariant(project,'Sheet photo notes');
  const reopened=parseProject(serializeProject(project));assert.deepEqual(reopened,project);
  const changed=withSheetPhotoEdits(reopened,rear,{notes:'Changed later'});
  const restored=restoreVariant(changed,changed.variants[0].id);assert.equal(getSheetPhoto(restored,rear).notes,'Exact annotated target');
  const removed=removeReference(changed,rear);
  for(const owner of [removed,...removed.variants]){
    assert.equal(owner.sheetPreset.subjectIds.includes(rear),false);
    assert.equal(owner.sheetPreset.referenceIds.includes(rear),false);
    assert.equal(owner.sheetPreset.photoEdits.some(edit=>edit.id===rear),false);
  }
  assert.doesNotThrow(()=>parseProject(serializeProject(removed)));
});

test('removing a reference-only primary makes the next remaining subject available as MAIN, including saved variants',()=>{
  let project=addReference(newProject(),image('Primary subject.png',10));
  const primary=project.references[0].id;
  project=addReference(project,image('Remaining subject.png',20));const remaining=project.references[1].id;
  project=withSheetPreset(project,{sourceId:primary,subjectIds:[remaining]});project=saveVariant(project,'Reference-only sheet');
  const removed=removeReference(project,primary);
  assert.equal(removed.original,null);assert.equal(Object.hasOwn(removed.sheetPreset,'sourceId'),false);
  assert.equal(getSheetSource(removed).id,remaining);
  assert.deepEqual(getSheetSubjectSources(removed).map(photo=>photo.id),[remaining]);
  assert.equal(getSheetInputPhotos(removed)[0].role,'main');
  assert.equal(getSheetSource(restoreVariant(removed,removed.variants[0].id)).id,remaining);
  const reopened=parseProject(serializeProject(removed));assert.equal(getSheetSource(reopened).id,remaining);
  assert.equal(prepareSheetRequest(payload(reopened)).sourceName,'Remaining subject.png');
  assert.equal(getSheetSource(removeReference(removed,remaining)),null);
  // Existing canvas projects still fall back to their original image as before.
  const withOriginal=addRaster(project,image('Canvas original.png',30)).project;
  assert.equal(getSheetSource(removeReference(withOriginal,primary)).id,withOriginal.original.assetId);
});

test('sheet instructions identify the circled or named subject and separate visible annotation text from the artwork',()=>{
  let {project,primary,detail}=fixture();
  let annotations=textMark(getSheetPhoto(project,primary),'Example tower only');
  const second=addText(referenceProject(getSheetPhoto(project,primary)),{content:'HIDDEN SECRET',x:0,y:0,width:2,height:2,fontSize:1}).project.layers.at(-1);second.visible=false;annotations.push(second);
  project=withSheetPhotoEdits(project,primary,{annotations,notes:'Ignore the road and nearby hotels.'});
  project=withSheetPhotoEdits(project,detail,{notes:'Match this limestone.'});
  const prompt=buildSheetPrompt(project);
  assert.match(prompt,/circled, highlighted, arrowed or named/);assert.match(prompt,/building, not the surrounding skyline/);
  assert.match(prompt,/Example tower only/);assert.match(prompt,/Ignore the road/);assert.match(prompt,/Match this limestone/);
  assert.equal(prompt.includes('HIDDEN SECRET'),false);assert.equal(prompt.includes('Unused photo.png'),false);
  assert.match(prompt,/never include circles/);assert.match(prompt,/exactly 7 distinct/);assert.match(prompt,/pure WHITE/);
});

test('backend uploads all selected clean photos plus mapped guides, preserving byte-exact originals',()=>{
  let {project,primary,detail}=fixture();
  project=withSheetPhotoEdits(project,primary,{annotations:textMark(getSheetPhoto(project,primary)),notes:'Main facade only'});
  const drawn=addDrawing(referenceProject(getSheetPhoto(project,detail)),{mode:'highlight',color:'#ffff00',size:1,points:[[1,1],[2,2]]}).project.layers.slice(1);
  project=withSheetPhotoEdits(project,detail,{annotations:drawn,notes:'Use this stone pattern'});
  const before=structuredClone(project),guides=previews(project),prepared=prepareSheetRequest({...payload(project),annotationPreviews:guides});
  assert.equal(prepared.images.length,6);
  for(const red of [10,20,30,40])assert.ok(prepared.images.some(input=>input.bytes.equals(png(red))));
  assert.equal(prepared.images.some(input=>input.bytes.equals(png(50))),false);
  assert.match(prepared.prompt,/"role": "annotation guide"/);assert.match(prepared.prompt,/"originalImage": 1/);
  assert.ok(prepared.prompt.includes(primary));assert.ok(prepared.prompt.includes(detail));assert.match(prepared.prompt,/Use this stone pattern/);
  assert.deepEqual(project,before);
});

test('legacy unannotated requests work; missing, unknown, duplicate or wrong-sized guides fail before upload',()=>{
  let {project,primary,detail}=fixture();
  assert.equal(prepareSheetRequest(payload(project)).images.length,4);
  project=withSheetPhotoEdits(project,primary,{annotations:textMark(getSheetPhoto(project,primary)),notes:''});
  assert.throws(()=>prepareSheetRequest(payload(project)),/annotation guides are missing/);
  assert.throws(()=>prepareSheetRequest({...payload(project),annotationPreviews:[{id:detail,image:image('Wrong target')}]}),/unknown or duplicate/);
  assert.throws(()=>prepareSheetRequest({...payload(project),annotationPreviews:[{id:primary,image:image('Wrong size',2,1,1)}]}),/photo dimensions/);
  const guide=previews(project)[0];assert.throws(()=>prepareSheetRequest({...payload(project),annotationPreviews:[guide,guide]}),/annotation guides are missing/);
  assert.deepEqual(sheetPreviewDimensions(5200,2600),{width:2600,height:1300});
});

test('identical original bytes upload once with each photo ID mapped, while guides still identify the chosen photo',()=>{
  let project=addRaster(newProject(),image('Primary.png',10)).project;
  project=addReference(project,image('Same subject another filename.png',10));
  const id=project.references[0].id;project=withSheetPreset(project,{subjectIds:[id],referenceIds:[id]});
  const prepared=prepareSheetRequest(payload(project));assert.equal(prepared.images.length,1);
  assert.match(prepared.prompt,/Same subject another filename/);assert.ok(prepared.prompt.includes(id));
  assert.equal(getSheetDetailSources(project).length,0);
});

test('visible annotation guides are counted without a 16-source cap and excessive notes fail explicitly',()=>{
  let project=addRaster(newProject(),image('Primary.png',1)).project;
  for(let index=0;index<15;index++)project=addReference(project,image(`Detail ${index}.png`,index+2));
  project=withSheetPreset(project,{referenceIds:project.references.map(photo=>photo.id)});
  assert.equal(sheetGenerationPlan(project).imageCount,16);
  const marked=withSheetPhotoEdits(project,project.original.assetId,{annotations:textMark(getSheetPhoto(project,project.original.assetId))});
  assert.equal(sheetGenerationPlan(marked).imageCount,17);
  for(const photo of project.references)project=withSheetPhotoEdits(project,photo.id,{notes:'detail '.repeat(280)});
  project=withSheetPreset(project,{notes:'subject '.repeat(240)});
  assert.throws(()=>prepareSheetRequest(payload(project)),/Shorten the sheet notes/);
});

test('request pack includes every selected subject and detail original with roles and notes, without unselected photos',async()=>{
  let {project,side,detail}=fixture();project=withSheetPhotoEdits(project,side,{notes:'Subject side facade'});project=withSheetPhotoEdits(project,detail,{notes:'Stone detail instructions'});
  const before=structuredClone(project),input=await buildSheetGenerationInput(project);assert.deepEqual(input.annotationPreviews,[]);assert.deepEqual(input.project,project);
  const pack=await exportSheetPack(project);
  assert.equal(pack.mapping.mainImages.length,3);assert.equal(pack.mapping.sheetReferences.length,1);assert.equal(pack.mapping.generatedPreviews.length,0);
  assert.equal(pack.mapping.mainImages.find(photo=>photo.photoId===side).notes,'Subject side facade');
  assert.equal(pack.mapping.sheetReferences[0].notes,'Stone detail instructions');
  assert.equal(pack.files.filter(file=>file.name.startsWith('originals/')).length,4);
  for(const red of [10,20,30,40])assert.ok(await Promise.all(pack.assets.map(async asset=>Buffer.from(await asset.blob.arrayBuffer()).equals(png(red)))).then(results=>results.some(Boolean)));
  assert.equal(pack.request.prompt.includes('Unused photo.png'),false);assert.deepEqual(project,before);
});
