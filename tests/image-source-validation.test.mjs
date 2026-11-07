import {test} from 'node:test';
import assert from 'node:assert/strict';
import {isRasterDataURL,validatedOriginalPayload,clearImageSourceValidationCache} from '../public/image-source-validation.mjs';
import {newProject,addRaster,validateProject} from '../public/core.mjs';

test('immutable source checks keep their original strict validation rules',()=>{
  for(const source of [null,3,'','data:image/png;base64,A!AA','data:image/svg+xml;base64,AAAA','http://example.com/image.png'])assert.equal(isRasterDataURL(source),false);
  for(const type of ['png','jpeg','webp'])assert.equal(isRasterDataURL(`data:image/${type};base64,AAAA`),true);
  for(const source of [null,'data:image/png;base64,A','data:image/png;base64,AA=','data:image/png;base64,A===','data:image/png;base64,=AAA','data:image/png;base64,AAAA!'])assert.throws(()=>validatedOriginalPayload(source),/unavailable/);
  assert.equal(validatedOriginalPayload('data:image/png;base64,AA=='),'AA==');
  assert.equal(validatedOriginalPayload('data:image/png;base64,AAA='),'AAA=');
  assert.equal(validatedOriginalPayload('data:image/png;base64,AAAA'),'AAAA');
});
test('unchanged source bytes are checked once; clearing caches and changed bytes are checked again',()=>{
  clearImageSourceValidationCache();const source='data:image/png;base64,'+'AAAA'.repeat(20000);
  const original=RegExp.prototype.exec;let scans=0;
  RegExp.prototype.exec=function(value){if(value===source)scans++;return original.call(this,value);};
  try{
    assert.equal(isRasterDataURL(source),true);validatedOriginalPayload(source);const first=scans;
    assert.equal(first,2);
    for(let i=0;i<40;i++){assert.equal(isRasterDataURL(source),true);assert.equal(validatedOriginalPayload(source).length,80000);}
    assert.equal(scans,first);
    assert.equal(isRasterDataURL(source+'!'),false);assert.throws(()=>validatedOriginalPayload(source+'!'));
    clearImageSourceValidationCache();isRasterDataURL(source);validatedOriginalPayload(source);assert.equal(scans,4);
  }finally{RegExp.prototype.exec=original;clearImageSourceValidationCache();}
});
test('source caching does not bypass edited dimension, metadata or reference validation',()=>{
  const image={name:'one.png',source:'data:image/png;base64,AAAA',width:100,height:100};
  const {project}=addRaster(newProject(),image);validateProject(project);
  const asset=Object.values(project.assets)[0];asset.width=-1;assert.throws(()=>validateProject(project),/dimensions/);
  asset.width=100;asset.originalFile={name:'one.png',mimeType:'image/png',byteLength:3};assert.throws(()=>validateProject(project),/original file/);
  delete asset.originalFile;asset.source+='!';assert.throws(()=>validateProject(project),/original image/);
});
