import {test,beforeEach,afterEach} from 'node:test';
import assert from 'node:assert/strict';
import {isRasterDataURL,validatedOriginalPayload,clearImageSourceValidationCache} from '../public/image-source-validation.mjs';
import {newProject,addRaster,addReference,validateProject} from '../public/core.mjs';

beforeEach(()=>clearImageSourceValidationCache());
afterEach(()=>clearImageSourceValidationCache());
function observe(source,run){
  const original=RegExp.prototype.exec;let count=0;
  RegExp.prototype.exec=function(value){if(value===source)count++;return original.call(this,value);};
  try{return run(()=>count);}finally{RegExp.prototype.exec=original;}
}
test('source validation uses LRU eviction after128 entries without altering accepted payloads',()=>{
  const sources=Array.from({length:129},(_,i)=>'data:image/png;base64,'+Buffer.from(`source ${i}`).toString('base64'));
  observe(sources[0],scans=>{
    sources.slice(0,128).forEach(source=>assert.equal(isRasterDataURL(source),true));assert.equal(scans(),1);
    assert.equal(isRasterDataURL(sources[0]),true);assert.equal(scans(),1,'Recent access refreshes cache order.');
    assert.equal(isRasterDataURL(sources[128]),true);assert.equal(isRasterDataURL(sources[0]),true);assert.equal(scans(),1);
    for(let i=1;i<129;i++)isRasterDataURL(sources[i]);
    assert.equal(isRasterDataURL(sources[0]),true);assert.equal(scans(),2,'An evicted source is revalidated.');
    assert.equal(validatedOriginalPayload(sources[0]),sources[0].split(',')[1]);assert.equal(scans(),3);
    validatedOriginalPayload(sources[0]);assert.equal(scans(),3);
  });
});
test('source-validation budget counts retained source strings independently of entry count',()=>{
  // Invalid strings fail immediately but occupy the same cache-key memory as
  // valid sources, allowing a deterministic budget check without decoding images.
  const sources=Array.from({length:3},(_,i)=>'x'.repeat(34*1024*1024)+i);
  observe(sources[0],scans=>{
    sources.forEach(source=>assert.equal(isRasterDataURL(source),false));assert.equal(scans(),1);
    assert.equal(isRasterDataURL(sources[0]),false);assert.equal(scans(),2,'Three68 MiB keys exceed the192 MiB budget.');
    assert.throws(()=>validatedOriginalPayload(sources[0]),/unavailable/);assert.equal(scans(),3);
    assert.throws(()=>validatedOriginalPayload(sources[0]),/unavailable/);assert.equal(scans(),3);
  });
});
test('an oversized source is not retained by the validation cache',()=>{
  const source='x'.repeat(97*1024*1024);
  observe(source,scans=>{
    assert.equal(isRasterDataURL(source),false);assert.equal(isRasterDataURL(source),false);assert.equal(scans(),2);
    assert.throws(()=>validatedOriginalPayload(source),/unavailable/);assert.throws(()=>validatedOriginalPayload(source),/unavailable/);assert.equal(scans(),4);
  });
});
test('cached raster bytes cannot bypass changed references or original metadata',()=>{
  const source='data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg==';
  const originalFile={name:'image.png',mimeType:'image/png',byteLength:Buffer.from(source.split(',')[1],'base64').length};
  const image={name:'image.png',source,width:1,height:1,originalFile};
  let {project}=addRaster(newProject(),image);project=addReference(project,image);validateProject(project);
  const reference=project.references[0];
  reference.width=0;assert.throws(()=>validateProject(project),/dimensions/);reference.width=1;
  reference.originalFile.byteLength++;assert.throws(()=>validateProject(project),/original file/);reference.originalFile.byteLength--;
  reference.originalFile.mimeType='image/jpeg';assert.throws(()=>validateProject(project),/original file/);reference.originalFile.mimeType='image/png';
  reference.preview={kind:'generated-thumbnail',source,width:2,height:1};assert.throws(()=>validateProject(project),/thumbnail/);delete reference.preview;
  validateProject(project);reference.source+='!';assert.throws(()=>validateProject(project),/reference image/);
});
