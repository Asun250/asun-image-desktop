import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {deflateSync} from 'node:zlib';
import {newProject,addRaster,saveVariant,restoreVariant,validateProject} from '../public/core.mjs';
import {getBlockoutReview,blockoutOutputSize} from '../public/blockout-review-settings.mjs';
import {prepareImageRequest} from '../desktop-image-request.mjs';
function image(width=4,height=4,color=80) {
  const chunk=(type,data)=>{const size=Buffer.alloc(4);size.writeUInt32BE(data.length);return Buffer.concat([size,Buffer.from(type),data,Buffer.alloc(4)]);};
  const header=Buffer.alloc(13);header.writeUInt32BE(width);header.writeUInt32BE(height,4);header[8]=8;header[9]=2;
  const pixels=Buffer.alloc(height*(width*3+1),color);for(let y=0;y<height;y++)pixels[y*(width*3+1)]=0;
  const bytes=Buffer.concat([Buffer.from([137,80,78,71,13,10,26,10]),chunk('IHDR',header),chunk('IDAT',deflateSync(pixels)),chunk('IEND',Buffer.alloc(0))]);
  return {name:'Original blockout.png',width,height,source:'data:image/png;base64,'+bytes.toString('base64')};
}
function fixture(){const p=addRaster(newProject(),image()).project;p.prompt='Photoreal materials; retain this scene.';p.imageOutput={version:1,aspect:'source'};return p;}
function policy(project){return {...getBlockoutReview(project),enabled:true,assetId:project.original.assetId};}
const request=project=>({requestId:randomUUID(),project,model:'gpt-image-2.5-sunburst',quality:'high',composition:image(project.width,project.height,30)});

test('ordinary generation stays unchanged until a blockout is explicitly selected',()=>{
  const project=fixture(),prepared=prepareImageRequest(request(project));assert.equal(prepared.review,undefined);assert.equal(prepared.quality,'high');assert.equal(prepared.images.length,1);assert.equal(getBlockoutReview(project).enabled,false);
});
test('review freezes original source bytes independently of current composition and preserves image settings',()=>{
  const project=fixture();project.blockoutReview=policy(project);const before=structuredClone(project),prepared=prepareImageRequest(request(project));
  assert.deepEqual(project,before);assert.equal(prepared.review.sourceIndex,2);assert.equal(prepared.review.model,'gpt-6-astra');assert.equal(prepared.review.effort,'max');assert.equal(prepared.review.maxAttempts,3);
  assert.equal(prepared.review.source.bytes.toString('base64'),project.assets[project.original.assetId].source.split(',')[1]);assert.notEqual(prepared.images[0].sha256,prepared.review.source.sha256);assert.equal(prepared.images[1].sha256,prepared.review.source.sha256);assert.match(prepared.prompt,/Input 2.*ORIGINAL BLENDER BLOCKOUT/);assert.match(prepared.prompt,/Geometry changes are allowed only/);assert.equal(prepared.quality,'high');
});
test('matching source input is reused with both roles, not uploaded twice',()=>{
  const project=fixture();project.blockoutReview=policy(project);const prepared=prepareImageRequest({...request(project),composition:image()});assert.equal(prepared.images.length,1);assert.equal(prepared.review.sourceIndex,1);assert.equal(prepared.inputRoles.length,2);assert.match(prepared.prompt,/Input 1.*ORIGINAL BLENDER BLOCKOUT/);
});
test('Match source uses original blockout orientation over a changed canvas for output size',()=>{
  let project=addRaster(newProject(),image(8,4)).project;project.width=4;project.height=8;project.prompt='Use realistic materials';project.blockoutReview=policy(project);project.imageOutput={version:1,aspect:'source'};
  assert.equal(prepareImageRequest(request(project)).size,'1536x768');
});
test('reviewed sizes preserve exact source aspect and reject incompatible ratios or models before billing',()=>{
  assert.equal(blockoutOutputSize('gpt-image-2.5-sunburst',1920,1080),'1536x864');
  assert.equal(blockoutOutputSize('gpt-image-2.5-flare',1080,1920),'864x1536');
  assert.equal(blockoutOutputSize('gpt-image-1.5',600,400),'1536x1024');
  assert.throws(()=>blockoutOutputSize('gpt-image-1.5',1920,1080),/cannot keep/);
  assert.throws(()=>blockoutOutputSize('gpt-image-2.5-sunburst',941,1672),/cannot fit/);
  assert.throws(()=>blockoutOutputSize('gpt-image-2.5-sunburst',4000,1000),/between 1:3/);
});
test('missing source, unsupported reviewer settings and invalid budgets fail explicitly',()=>{
  const project=fixture();for(const changed of [{assetId:'missing'},{model:'gpt-other'},{effort:'ultra'},{maxAttempts:4},{maxAttempts:0},{authorizedChanges:'x'.repeat(2001)}]){
    project.blockoutReview={...policy(project),...changed};assert.throws(()=>prepareImageRequest(request(project)));
    delete project.blockoutReview;
  }
});
test('fingerprint binds review budget, exceptions and selected source',()=>{
  const project=fixture();project.blockoutReview=policy(project);const initial=prepareImageRequest(request(project)).fingerprint;
  project.blockoutReview.maxAttempts=2;assert.notEqual(prepareImageRequest(request(project)).fingerprint,initial);
  project.blockoutReview.maxAttempts=3;project.blockoutReview.authorizedChanges='Remove the left chair';const next=prepareImageRequest(request(project));assert.notEqual(next.fingerprint,initial);assert.match(next.prompt,/Remove the left chair/);
});
test('review policy survives native project and variant restoration without contaminating older variants',()=>{
  let project=fixture();project=saveVariant(project,'Before review');project.blockoutReview=policy(project);project=saveVariant(project,'Reviewed');const parsed=validateProject(JSON.parse(JSON.stringify(project)));
  assert.deepEqual(restoreVariant(parsed,project.variants[1].id).blockoutReview,policy(project));assert.equal(restoreVariant(parsed,project.variants[0].id).blockoutReview,undefined);
});
