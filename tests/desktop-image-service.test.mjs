import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {mkdtemp,rm} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {newProject,addRaster} from '../public/core.mjs';
import {prepareImageRequest} from '../desktop-image-request.mjs';
import {createDesktopSheetService,SHEET_MODELS} from '../desktop-sheet-service.mjs';
import {createServer} from '../server.mjs';

const pixel='iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a7x8AAAAASUVORK5CYII=';
const image={name:'Original.png',source:'data:image/png;base64,'+pixel,width:1,height:1};
const key='sk-image-test-not-a-real-credential';
const json=(value,status=200)=>new Response(JSON.stringify(value),{status,headers:{'Content-Type':'application/json'}});
function fixture(edit=false){let project=newProject(1,1,'Night city');if(edit)project=addRaster(project,image).project;project.prompt='Create a cinematic night city with violet lights.';return{requestId:randomUUID(),project,model:'gpt-image-2.5-sunburst',composition:edit?image:null,guide:null,referencePreviews:[],areaMasks:[]};}
async function setup(t,options={}){
  const directory=await mkdtemp(path.join(os.tmpdir(),'asun-image-generation-')),calls=[];
  const fetchImpl=async(url,init={})=>{calls.push({url,init});if(url.endsWith('/models'))return json({data:SHEET_MODELS.map(m=>({id:m.id}))});return options.reply?options.reply(url,init):json({data:[{b64_json:pixel}]});};
  const service=createDesktopSheetService({directory,label:'image',prepareRequest:prepareImageRequest,getKey:()=>key,fetchImpl,...options});t.after(async()=>{service.dispose();await rm(directory,{recursive:true,force:true});});return{service,directory,calls,fetchImpl};
}
async function done(service,id){for(let i=0;i<200;i++){const job=await service.job(id);if(!['queued','running'].includes(job.status))return job;await new Promise(resolve=>setTimeout(resolve,10));}throw new Error('Mock image request did not finish.');}
const posts=calls=>calls.filter(call=>call.init.method==='POST');

test('main-page prompt-only generation uses the generations API and returns an image-mode result',async t=>{
  const{service,calls}=await setup(t),request=fixture();const status=await service.status();assert.equal(status.authenticated,true);assert.match(status.message,/Generating images/);assert.equal(posts(calls).length,0);
  await service.start(request);const result=await done(service,request.requestId);assert.equal(result.status,'completed',result.message);assert.equal(result.mode,'image');assert.equal(result.views,undefined);assert.equal(result.image.source,'data:image/png;base64,'+pixel);assert.match(result.image.name,/generated image\.png$/);assert.equal(posts(calls).length,1);
  const post=posts(calls)[0],body=JSON.parse(post.init.body);assert.equal(post.url,'https://api.openai.com/v1/images/generations');assert.equal(post.init.headers['Content-Type'],'application/json');assert.equal(body.model,'gpt-image-2.5-sunburst');assert.equal(body.n,1);assert.equal(body.output_format,'png');assert.match(body.prompt,/cinematic night city/);assert.doesNotMatch(body.prompt,/exactly 7|WHITE \(#FFFFFF\)|Required views/);
});
test('main-page source editing uses multipart edits with the actual composition image',async t=>{
  const{service,calls}=await setup(t),request=fixture(true);request.project.imageOutput={version:1,aspect:'1:1'};const before=JSON.stringify(request.project);await service.start(request);const result=await done(service,request.requestId);assert.equal(result.status,'completed',result.message);
  const post=posts(calls)[0];assert.equal(post.url,'https://api.openai.com/v1/images/edits');assert.equal(post.init.body.get('model'),request.model);assert.equal(post.init.body.get('size'),'1024x1024');assert.equal(post.init.body.getAll('image[]').length,1);assert.equal(Buffer.from(await post.init.body.get('image[]').arrayBuffer()).toString('base64'),pixel);assert.match(post.init.body.get('prompt'),/cinematic night city/);assert.doesNotMatch(post.init.body.get('prompt'),/exactly 7/);assert.equal(JSON.stringify(request.project),before);
});
test('main-page request recovery does not generate another paid image and changed prompts need a new ID',async t=>{
  const{service,directory,calls,fetchImpl}=await setup(t),request=fixture();await service.start(request);await done(service,request.requestId);const recovered=createDesktopSheetService({directory,label:'image',prepareRequest:prepareImageRequest,getKey:()=>key,fetchImpl});t.after(()=>recovered.dispose());assert.equal((await recovered.job(request.requestId)).status,'completed');await recovered.start(request);assert.equal(posts(calls).length,1);const changed=structuredClone(request);changed.project.prompt='A sunny meadow';await assert.rejects(recovered.start(changed),/different image settings/);assert.equal(posts(calls).length,1);
});
test('main-page provider failures remain failed and never auto-retry',async t=>{
  const{service,calls}=await setup(t,{reply:()=>json({error:{message:'Billing is unavailable '+key}},402)}),request=fixture();await service.start(request);const result=await done(service,request.requestId);assert.equal(result.status,'failed');assert.match(result.message,/No automatic retry/);assert.equal(result.message.includes(key),false);assert.equal(result.mode,'image');await service.start(request);assert.equal(posts(calls).length,1);
});
test('image routes and sheet routes require their own token and keep original local protection',async t=>{
  const{service,calls}=await setup(t),sheetService={token:'independent-sheet-token',status:async()=>({token:'independent-sheet-token',models:[],configured:false,authenticated:false}),dispose(){}};
  const server=createServer({images:service,sheets:sheetService,detection:{token:'test-detection',status:async()=>({available:false}),dispose(){}}});await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));t.after(()=>new Promise(resolve=>{server.close(resolve);server.closeAllConnections();}));
  const base='http://127.0.0.1:'+server.address().port,status=await(await fetch(base+'/api/images/status')).json(),headers={'Content-Type':'application/json','X-Asun-Image-Token':status.token},request=fixture();
  assert.notEqual(status.token,sheetService.token);assert.equal((await fetch(base+'/api/images/status',{headers:{Origin:'https://outside.invalid'}})).status,403);assert.equal((await fetch(base+'/api/images/generate',{method:'POST',headers,body:JSON.stringify(request)})).status,403);
  assert.equal((await fetch(base+'/api/images/generate',{method:'POST',headers:{...headers,Origin:base,'X-Asun-Image-Token':sheetService.token},body:JSON.stringify(request)})).status,403);assert.equal((await fetch(base+'/api/images/generate',{method:'POST',headers:{...headers,Origin:base,'Content-Type':'text/plain'},body:'test'})).status,415);
  assert.equal((await fetch(base+'/api/images/jobs/'+request.requestId,{headers:{'X-Asun-Sheet-Token':sheetService.token}})).status,403);assert.equal((await fetch(base+'/api/images/jobs/not-an-id',{headers})).status,400);
  const accepted=await fetch(base+'/api/images/generate',{method:'POST',headers:{...headers,Origin:base},body:JSON.stringify(request)});assert.equal(accepted.status,202);await done(service,request.requestId);const result=await(await fetch(base+'/api/images/jobs/'+request.requestId,{headers})).json();assert.equal(result.status,'completed');assert.equal(result.mode,'image');assert.equal(posts(calls).length,1);
  assert.equal((await fetch(base+'/data/image-jobs/'+request.requestId+'.png')).status,404);assert.equal((await fetch(base+'/desktop-image-request.mjs')).status,404);
});
