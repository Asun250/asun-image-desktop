import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {mkdtemp,readFile,readdir,rm} from 'node:fs/promises';
import {deflateSync} from 'node:zlib';
import os from 'node:os';
import path from 'node:path';
import {newProject,addReference} from '../public/core.mjs';
import {prepareImageRequest} from '../desktop-image-request.mjs';
import {createDesktopSheetService,inspectSheetImage,SHEET_MODELS} from '../desktop-sheet-service.mjs';

const credential='sk-output-fixture-not-a-real-key';
const json=value=>new Response(JSON.stringify(value),{headers:{'Content-Type':'application/json'}});

// Complete, decodable PNGs let these tests check encoded pixels rather than
// trusting metadata supplied by the provider or the browser preview.
function png(width,height,color=128) {
  const crc=bytes=>{let value=0xffffffff;for(const byte of bytes){value^=byte;for(let i=0;i<8;i++)value=(value>>>1)^((value&1)?0xedb88320:0);}return(value^0xffffffff)>>>0;};
  const chunk=(kind,bytes)=>{const content=Buffer.concat([Buffer.from(kind),bytes]),length=Buffer.alloc(4),check=Buffer.alloc(4);length.writeUInt32BE(bytes.length);check.writeUInt32BE(crc(content));return Buffer.concat([length,content,check]);};
  const header=Buffer.alloc(13);header.writeUInt32BE(width);header.writeUInt32BE(height,4);header[8]=8;header[9]=2;
  const row=Buffer.alloc(width*3+1,color);row[0]=0;
  return Buffer.concat([Buffer.from([137,80,78,71,13,10,26,10]),chunk('IHDR',header),chunk('IDAT',deflateSync(Buffer.concat(Array.from({length:height},()=>row)))),chunk('IEND',Buffer.alloc(0))]);
}
const firstReference=png(2160,3840,80),secondReference=png(1024,1536,160);
const portrait=png(864,1536,100),landscape=png(1536,1024,200);
const photo=(name,width,height,bytes)=>({name,width,height,source:'data:image/png;base64,'+bytes.toString('base64')});
function fixture({references=true,model='gpt-image-2.5-sunburst',quality='max'}={}) {
  let project=newProject(1600,1000,'Portrait output regression');
  if(references){project=addReference(project,photo('Portrait Blender blockout.png',2160,3840,firstReference));project=addReference(project,photo('Appearance.png',1024,1536,secondReference));}
  project.prompt='Generate exactly 9:16 portrait. Preserve Image 1 framing and use Image 2 appearance.';
  return {requestId:randomUUID(),project,model,quality};
}
async function setup(t,{bytes=portrait,returnedSize='864x1536'}={}) {
  const directory=await mkdtemp(path.join(os.tmpdir(),'asun-output-test-')),calls=[];
  const fetchImpl=async(url,init={})=>{calls.push({url,init});if(url.endsWith('/models'))return json({data:SHEET_MODELS.map(model=>({id:model.id}))});return json({size:returnedSize,quality:'max',data:[{b64_json:bytes.toString('base64')}]});};
  const service=createDesktopSheetService({directory,label:'image',prepareRequest:prepareImageRequest,getKey:()=>credential,fetchImpl});
  t.after(async()=>{service.dispose();assert.equal(path.dirname(path.resolve(directory)),path.resolve(os.tmpdir()));assert.match(path.basename(directory),/^asun-output-test-/);await rm(directory,{recursive:true,force:true});});
  return {directory,calls,service};
}
const posts=calls=>calls.filter(call=>call.init.method==='POST');
async function finished(service,id) {
  for(let i=0;i<200;i++){const result=await service.job(id);if(!['queued','running'].includes(result.status))return result;await new Promise(resolve=>setTimeout(resolve,10));}
  throw new Error('Mock portrait request did not finish.');
}

test('reference-only portrait reaches the API as 864x1536 and saves original output pixels unchanged',async t=>{
  const {directory,calls,service}=await setup(t),request=fixture(),before=JSON.stringify(request.project);
  assert.equal(request.project.layers.length,0);
  await service.start(request);const result=await finished(service,request.requestId);
  assert.equal(result.status,'completed',result.message);
  assert.equal(posts(calls).length,1);
  const post=posts(calls)[0],form=post.init.body;
  assert.equal(post.url,'https://api.openai.com/v1/images/edits');
  assert.equal(form.get('model'),'gpt-image-2.5-sunburst');assert.equal(form.get('quality'),'max');assert.equal(form.get('size'),'864x1536');assert.equal(form.get('n'),'1');
  assert.match(form.get('prompt'),/864 × 1536/);assert.doesNotMatch(form.get('prompt'),/working canvas is 1600 × 1000/);
  const uploads=form.getAll('image[]');assert.equal(uploads.length,2);
  assert.deepEqual(Buffer.from(await uploads[0].arrayBuffer()),firstReference);
  assert.deepEqual(Buffer.from(await uploads[1].arrayBuffer()),secondReference);
  assert.deepEqual(await readFile(path.join(directory,request.requestId+'.input-1.png')),firstReference);
  assert.deepEqual(await readFile(path.join(directory,request.requestId+'.input-2.png')),secondReference);
  const saved=await readFile(path.join(directory,request.requestId+'.png'));
  assert.deepEqual(saved,portrait);assert.equal(saved.readUInt32BE(16),864);assert.equal(saved.readUInt32BE(20),1536);
  const inspected=inspectSheetImage(saved);assert.equal(inspected.width,864);assert.equal(inspected.height,1536);
  assert.equal(result.image.width,864);assert.equal(result.image.height,1536);assert.equal(result.outputCheck.matches,true);
  assert.equal(result.settings.outputFraming.source,'preset');assert.equal(result.settings.outputFraming.aspect,'9:16');assert.equal(result.settings.size,'864x1536');
  assert.deepEqual((await service.output(request.requestId)).bytes,portrait);
  assert.equal(JSON.stringify(request.project),before);
});

test('wrong provider pixels are preserved and warned about despite matching response metadata, without another POST',async t=>{
  const {directory,calls,service}=await setup(t,{bytes:landscape,returnedSize:'864x1536'}),request=fixture();
  await service.start(request);const result=await finished(service,request.requestId);
  assert.equal(result.status,'completed');assert.equal(result.returned.size,'864x1536');assert.equal(result.settings.size,'864x1536');
  assert.equal(result.image.width,1536);assert.equal(result.image.height,1024);assert.equal(result.outputCheck.matches,false);
  assert.equal(result.outputCheck.actualWidth,1536);assert.equal(result.outputCheck.actualHeight,1024);
  assert.match(result.message,/Output size mismatch/);assert.match(result.message,/not cropped or stretched/);assert.match(result.message,/No automatic retry/);
  const saved=await readFile(path.join(directory,request.requestId+'.png'));
  assert.deepEqual(saved,landscape);assert.equal(saved.readUInt32BE(16),1536);assert.equal(saved.readUInt32BE(20),1024);
  assert.deepEqual((await service.output(request.requestId)).bytes,landscape);
  await service.start(request);assert.equal(posts(calls).length,1);
});

test('explicit 9:16 prompt-only output uses portrait dimensions in the actual JSON request',async t=>{
  const {directory,calls,service}=await setup(t),request=fixture({references:false});request.project.imageOutput={version:1,aspect:'9:16'};
  await service.start(request);const result=await finished(service,request.requestId);assert.equal(result.status,'completed',result.message);
  assert.equal(posts(calls).length,1);const post=posts(calls)[0],body=JSON.parse(post.init.body);
  assert.equal(post.url,'https://api.openai.com/v1/images/generations');assert.equal(post.init.headers['Content-Type'],'application/json');
  assert.equal(body.size,'864x1536');assert.equal(body.model,request.model);assert.equal(body.quality,'max');assert.equal(body.n,1);
  assert.equal(Object.hasOwn(body,'width'),false);assert.equal(Object.hasOwn(body,'height'),false);assert.equal(Object.hasOwn(body,'aspect_ratio'),false);
  assert.equal(result.outputCheck.matches,true);assert.deepEqual(await readFile(path.join(directory,request.requestId+'.png')),portrait);
});

test('unsupported exact portrait aspect fails before admission or paid API calls and reports supported portrait size',async t=>{
  const {directory,calls,service}=await setup(t),request=fixture({model:'gpt-image-1.5',quality:'high'});
  await assert.rejects(service.start(request),error=>error.statusCode===400&&/1024 × 1536 \(2:3\)/.test(error.message)&&/No size was substituted/.test(error.message));
  assert.equal(posts(calls).length,0);assert.equal((await readdir(directory)).some(name=>name.startsWith(request.requestId)),false);
});
