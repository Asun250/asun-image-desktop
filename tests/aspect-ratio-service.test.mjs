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
import {createServer} from '../server.mjs';

const json=value=>new Response(JSON.stringify(value),{headers:{'Content-Type':'application/json'}});
function png(width,height,color=128){
  const crc=bytes=>{let value=0xffffffff;for(const byte of bytes){value^=byte;for(let i=0;i<8;i++)value=(value>>>1)^((value&1)?0xedb88320:0);}return(value^0xffffffff)>>>0;};
  const chunk=(kind,bytes)=>{const data=Buffer.concat([Buffer.from(kind),bytes]),length=Buffer.alloc(4),check=Buffer.alloc(4);length.writeUInt32BE(bytes.length);check.writeUInt32BE(crc(data));return Buffer.concat([length,data,check]);};
  const header=Buffer.alloc(13);header.writeUInt32BE(width);header.writeUInt32BE(height,4);header[8]=8;header[9]=2;
  const row=Buffer.alloc(width*3+1,color);row[0]=0;
  return Buffer.concat([Buffer.from([137,80,78,71,13,10,26,10]),chunk('IHDR',header),chunk('IDAT',deflateSync(Buffer.concat(Array.from({length:height},()=>row)))),chunk('IEND',Buffer.alloc(0))]);
}
const portraitReference=png(1080,1920,90),landscapeReference=png(1920,1080,180);
const photo=(name,width,height,bytes)=>({name,width,height,source:'data:image/png;base64,'+bytes.toString('base64')});
function fixture(aspect='9:16',{references=false,model='gpt-image-2.5-sunburst',quality='high'}={}){
  let project=newProject(1600,1000,'Aspect request fixture');
  if(references){project=addReference(project,photo('Wide original.png',1920,1080,landscapeReference));project=addReference(project,photo('Portrait original.png',1080,1920,portraitReference));}
  project.prompt='Keep the entire composition and all original proportions.';project.imageOutput={version:1,aspect};
  return {requestId:randomUUID(),project,model,quality};
}
async function setup(t,{width=864,height=1536,claimedSize='864x1536'}={}){
  const directory=await mkdtemp(path.join(os.tmpdir(),'asun-aspect-service-')),calls=[],bytes=png(width,height);
  const fetchImpl=async(url,init={})=>{
    calls.push({url,init});
    if(url==='https://api.openai.com/v1/models')return json({data:SHEET_MODELS.map(item=>({id:item.id}))});
    assert.match(url,/^https:\/\/api\.openai\.com\/v1\/images\/(generations|edits)$/);
    assert.equal(init.method,'POST');return json({size:claimedSize,data:[{b64_json:bytes.toString('base64')}]});
  };
  const service=createDesktopSheetService({directory,label:'image',prepareRequest:prepareImageRequest,getKey:()=> 'sk-aspect-fixture-not-real',fetchImpl});
  t.after(async()=>{service.dispose();assert.equal(path.dirname(path.resolve(directory)),path.resolve(os.tmpdir()));assert.match(path.basename(directory),/^asun-aspect-service-/);await rm(directory,{recursive:true,force:true});});
  return {directory,calls,bytes,service};
}
const posts=calls=>calls.filter(call=>call.init.method==='POST');
async function finished(service,id){
  for(let i=0;i<300;i++){const job=await service.job(id);if(!['queued','running'].includes(job.status))return job;await new Promise(resolve=>setTimeout(resolve,10));}
  throw new Error('Mock aspect job did not finish.');
}

for(const [aspect,width,height] of [['9:16',864,1536],['16:9',1536,864]])for(const references of [false,true]){
  test(`${aspect} reaches the ${references?'multipart edits':'JSON generations'} API as ${width}x${height}`,async t=>{
    const {directory,calls,bytes,service}=await setup(t,{width,height,claimedSize:`${width}x${height}`});
    const request=fixture(aspect,{references}),before=structuredClone(request.project);
    await service.start(request);const result=await finished(service,request.requestId);assert.equal(result.status,'completed',result.message);
    assert.equal(posts(calls).length,1);const post=posts(calls)[0];
    if(references){
      assert.match(post.url,/\/images\/edits$/);const body=post.init.body;
      assert.equal(body.get('size'),`${width}x${height}`);assert.equal(body.get('model'),request.model);assert.equal(body.get('quality'),'high');assert.equal(body.get('n'),'1');
      assert.equal(body.has('width'),false);assert.equal(body.has('height'),false);assert.equal(body.has('aspect_ratio'),false);
      const images=body.getAll('image[]');assert.equal(images.length,2);
      assert.deepEqual(Buffer.from(await images[0].arrayBuffer()),landscapeReference);assert.deepEqual(Buffer.from(await images[1].arrayBuffer()),portraitReference);
      assert.deepEqual(await readFile(path.join(directory,request.requestId+'.input-1.png')),landscapeReference);
      assert.deepEqual(await readFile(path.join(directory,request.requestId+'.input-2.png')),portraitReference);
    }else{
      assert.match(post.url,/\/images\/generations$/);const body=JSON.parse(post.init.body);
      assert.equal(body.size,`${width}x${height}`);assert.equal(body.model,request.model);assert.equal(body.quality,'high');assert.equal(body.n,1);
      for(const key of ['width','height','aspect_ratio'])assert.equal(Object.hasOwn(body,key),false);
    }
    assert.equal(result.settings.size,`${width}x${height}`);assert.equal(result.settings.outputFraming.aspect,aspect);
    assert.equal(result.outputCheck.requestedRatio,aspect);assert.equal(result.outputCheck.actualRatio,aspect);assert.equal(result.outputCheck.matches,true);
    const saved=await readFile(path.join(directory,request.requestId+'.png'));assert.deepEqual(saved,bytes);
    assert.equal(inspectSheetImage(saved).width,width);assert.equal(inspectSheetImage(saved).height,height);assert.deepEqual(request.project,before);
  });
}

test('download endpoint returns the exact original generated file with actual portrait dimensions',async t=>{
  const {directory,bytes,service}=await setup(t),request=fixture();
  await service.start(request);await finished(service,request.requestId);
  const server=createServer({images:service,generationQueue:service.queue,sheets:{token:'unrelated-sheet-token',dispose(){}},detection:{dispose(){}},imageSearch:{dispose(){}}});
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  t.after(()=>new Promise(resolve=>{server.close(resolve);server.closeAllConnections();}));
  const response=await fetch(`http://127.0.0.1:${server.address().port}/api/images/jobs/${request.requestId}/output`,{headers:{'X-Asun-Image-Token':service.token}});
  assert.equal(response.status,200);assert.equal(response.headers.get('content-type'),'image/png');
  const downloaded=Buffer.from(await response.arrayBuffer());assert.deepEqual(downloaded,bytes);assert.deepEqual(downloaded,await readFile(path.join(directory,request.requestId+'.png')));
  assert.equal(downloaded.readUInt32BE(16),864);assert.equal(downloaded.readUInt32BE(20),1536);
  assert.equal((await service.job(request.requestId)).outputCheck.actualRatio,'9:16');
});

for(const [name,width,height,aspectMatches] of [['wrong orientation',1536,864,false],['same ratio but wrong size',1080,1920,true],['one pixel different',865,1536,false]]){
  test(`encoded output flags ${name} even when provider metadata claims requested size`,async t=>{
    const {directory,calls,bytes,service}=await setup(t,{width,height,claimedSize:'864x1536'}),request=fixture();
    await service.start(request);const result=await finished(service,request.requestId);
    assert.equal(result.status,'completed');assert.equal(result.returned.size,'864x1536');assert.equal(result.image.width,width);assert.equal(result.image.height,height);
    assert.equal(result.outputCheck.matches,false);assert.equal(result.outputCheck.aspectMatches,aspectMatches);assert.equal(result.outputCheck.roundingAllowancePx,0);
    assert.match(result.message,/Output size mismatch/);assert.match(result.message,/not cropped or stretched/);assert.match(result.message,/No automatic retry/);
    if(aspectMatches)assert.match(result.message,/aspect ratio matches, but the pixel dimensions differ/);
    assert.deepEqual(await readFile(path.join(directory,request.requestId+'.png')),bytes);assert.deepEqual((await service.output(request.requestId)).bytes,bytes);
    await service.start(request);assert.equal(posts(calls).length,1);
  });
}

test('old model rejects 9:16 before submission, then sends explicitly selected supported portrait size',async t=>{
  const {directory,calls,service}=await setup(t,{width:1024,height:1536,claimedSize:'1024x1536'}),unsupported=fixture('9:16',{model:'gpt-image-1.5'});
  await assert.rejects(service.start(unsupported),error=>error.statusCode===400&&/1024 × 1536 \(2:3\)/.test(error.message)&&/No size was substituted/.test(error.message));
  assert.equal(posts(calls).length,0);assert.equal((await readdir(directory)).some(name=>name.startsWith(unsupported.requestId)),false);
  const supported=fixture('2:3',{model:'gpt-image-1.5'});await service.start(supported);const result=await finished(service,supported.requestId);
  assert.equal(result.status,'completed',result.message);assert.equal(JSON.parse(posts(calls)[0].init.body).size,'1024x1536');assert.equal(result.outputCheck.actualRatio,'2:3');assert.equal(result.outputCheck.matches,true);
});

test('catalog never enables retired GPT Image 1 and preserves existing high quality default',async t=>{
  const {calls,service}=await setup(t),status=await service.status();
  assert.equal(status.defaultQuality,'high');assert.equal(status.models.find(item=>item.id==='gpt-image-1').available,false);
  assert.equal(status.models.find(item=>item.id==='gpt-image-1').retired,true);assert.equal(status.models.find(item=>item.id==='gpt-image-2.5-sunburst').available,true);
  const request=fixture('1:1',{model:'gpt-image-1'});await assert.rejects(service.start(request),/retired/);assert.equal(posts(calls).length,0);
  const valid=fixture();delete valid.quality;await service.start(valid);const result=await finished(service,valid.requestId);assert.equal(result.status,'completed');
  assert.equal(JSON.parse(posts(calls)[0].init.body).quality,'high');assert.equal(result.settings.quality,'high');
});
