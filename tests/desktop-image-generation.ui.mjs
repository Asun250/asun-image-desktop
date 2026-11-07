import {test,before,after,beforeEach,afterEach} from 'node:test';
import assert from 'node:assert/strict';
import {mkdir,writeFile} from 'node:fs/promises';
import path from 'node:path';
import {chromium} from 'playwright';
import {createServer} from '../server.mjs';
import {prepareImageRequest} from '../desktop-image-request.mjs';
import {newProject,addRaster,addText,addDrawing,addReference,linkReferences,updateLabelComment,serializeProject,updateLayer,attachObjectRegion,referenceProject,updateReferenceAnnotations} from '../public/core.mjs';

const qa=path.resolve('qa','desktop-image-generation');
const model='gpt-image-2.5-sunburst',alternateModel='gpt-image-1.5';
let server,browser,context,page,base,errors,requests,polls,mode,providerReady,completedSource,uploadDelay,finishedPolls;
const evidence=[];
before(async()=>{
  await mkdir(qa,{recursive:true});
  server=createServer({detection:{token:'image-test',status:async()=>({available:false}),dispose(){}},sheets:{dispose(){}},images:{dispose(){}}});
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  base=`http://127.0.0.1:${server.address().port}`;browser=await chromium.launch({headless:true});
});
after(async()=>{
  await writeFile(path.join(qa,'report.json'),JSON.stringify({kind:'mocked-provider-ui-verification',paidCalls:0,evidence},null,2));
  await browser?.close();if(server)await new Promise(resolve=>server.close(resolve));
});
beforeEach(async()=>{
  errors=[];requests=[];polls=0;mode='running';providerReady=true;completedSource='';uploadDelay=0;finishedPolls=0;
  context=await browser.newContext({viewport:{width:1440,height:1000},acceptDownloads:true});
  await context.route('**/*',async route=>{
    const url=new URL(route.request().url());
    if(url.origin!==base){await route.abort();return;}
    const json=(body,status=200)=>route.fulfill({status,contentType:'application/json',body:JSON.stringify(body)});
    if(url.pathname==='/api/generation-queue/status')return json({error:'Legacy mock route'},404);
    if(url.pathname==='/api/images/status')return json({configured:providerReady,authenticated:providerReady,models:providerReady?[{id:model,label:'GPT Image 2.5',available:true},{id:alternateModel,label:'GPT Image 1.5 · detailed image generation model',available:true}]:[],token:'qa-image-token',message:providerReady?'Connected to a test image provider.':'Image generation is not connected. Configure the local image provider, then check again.'});
    if(url.pathname==='/api/images/generate'){
      assert.equal(route.request().method(),'POST');assert.equal(route.request().headers()['x-asun-image-token'],'qa-image-token');
      const body=route.request().postDataJSON();requests.push(body);if(uploadDelay)await new Promise(resolve=>setTimeout(resolve,uploadDelay));return json({id:body.requestId,status:'running'});
    }
    if(url.pathname.startsWith('/api/images/jobs/')){
      polls++;if(mode==='completed')finishedPolls++;const id=url.pathname.split('/').at(-1);
      return json(mode==='failed'?{id,status:'failed',message:'Test provider declined this image request. Your photos are safe.'}:mode==='completed'?{id,status:'completed',image:{source:completedSource,width:960,height:640,name:'Generated image.png'}}:{id,status:'running'});
    }
    // Sheets are separate and should not be invoked by ordinary image generation.
    if(url.pathname.startsWith('/api/sheets/'))return json({configured:false,authenticated:false,models:[],token:'sheet-qa',message:'Sheet test service disconnected.'});
    await route.continue();
  });
  page=await context.newPage();page.on('pageerror',error=>errors.push(error.message));
  await page.goto(base);await page.waitForFunction(()=>document.documentElement.dataset.ready==='true');
  if(await page.locator('#skipStartup').isVisible())await page.locator('#skipStartup').click();
  completedSource=await fixture('#5e99ad',960,640,true);
});
afterEach(async info=>{
  try{
    if(info.error)await page.screenshot({path:path.join(qa,'failure-'+info.name.replace(/\W+/g,'-')+'.png')});
    assert.deepEqual(errors,[],'The browser raises no uncaught errors.');
    for(const request of requests){
      const prepared=prepareImageRequest(request);assert.equal(prepared.mode,'image');
      assert.doesNotMatch(prepared.prompt,/exactly 7 distinct camera angles|pure WHITE \(#FFFFFF\) background/,'Normal image generation never receives sheet instructions.');
    }
    evidence.push({name:info.name,passed:!info.error,requests:requests.length,polls});
  }finally{await context?.close();}
});
async function fixture(color,width=480,height=320,result=false){
  return page.evaluate(({color,width,height,result})=>{
    const canvas=document.createElement('canvas');canvas.width=width;canvas.height=height;const ctx=canvas.getContext('2d');
    ctx.fillStyle='#e8e0d4';ctx.fillRect(0,0,width,height);ctx.fillStyle=color;ctx.fillRect(width*.15,height*.2,width*.7,height*.6);
    if(result){ctx.fillStyle='#17303e';ctx.font='22px Arial';ctx.fillText('QA fixture: simulated image provider output',20,height-25);}
    return canvas.toDataURL('image/png');
  },{color,width,height,result});
}
async function solid(color,width=40,height=40){
  return page.evaluate(({color,width,height})=>{const c=document.createElement('canvas');c.width=width;c.height=height;const ctx=c.getContext('2d');ctx.fillStyle=color;ctx.fillRect(0,0,width,height);return c.toDataURL('image/png');},{color,width,height});
}
async function pixels(source,points){
  return page.evaluate(async({source,points})=>{const image=new Image();image.src=source;await image.decode();const c=document.createElement('canvas');c.width=image.width;c.height=image.height;const ctx=c.getContext('2d');ctx.drawImage(image,0,0);return points.map(([x,y])=>Array.from(ctx.getImageData(x,y,1,1).data));},{source,points});
}
const file=(source,name)=>({name,mimeType:'image/png',buffer:Buffer.from(source.split(',')[1],'base64')});
async function ready(){await page.waitForFunction(()=>!document.querySelector('#generate')?.disabled);}
async function setPrompt(value){await page.locator('#prompt').fill(value);await page.locator('#prompt').dispatchEvent('change');}
async function requested(count=1){for(let i=0;i<100;i++){if(requests.length>=count)return;await new Promise(resolve=>setTimeout(resolve,50));}assert.fail(`Expected ${count} generation requests, got ${requests.length}.`);}
async function importMain(){
  const source=await fixture('#d18141');await page.locator('#imageInput').setInputFiles(file(source,'Original canvas.png'));
  await page.waitForFunction(()=>document.querySelectorAll('.layer-row').length===1&&!document.body.classList.contains('busy'));return source;
}
async function download(pending){const entry=await pending,stream=await entry.createReadStream(),chunks=[];for await(const chunk of stream)chunks.push(chunk);return{name:entry.suggestedFilename(),buffer:Buffer.concat(chunks)};}
async function savedProject(){const pending=page.waitForEvent('download');await page.locator('#saveProject').click();const saved=await download(pending);await page.waitForTimeout(725);return JSON.parse(saved.buffer.toString());}
async function closeResult(){if(await page.locator('#desktopImageResultDialog').isVisible())await page.locator('[data-image-result-close]').first().click();}
async function finishJob(){
  mode='completed';await page.locator('#imageGenerationResult').waitFor({state:'visible'});assert.equal(await page.locator('#desktopImageResultDialog').isVisible(),false,'Completion does not open a modal over ongoing edits.');await page.locator('#imageGenerationResult').click();await page.locator('#desktopImageResultDialog').waitFor({state:'visible'});await page.locator('[data-image-result]').waitFor({state:'visible'});
  assert.equal(await page.locator('[data-image-result]').getAttribute('src'),completedSource);
  await page.waitForFunction(()=>document.querySelector('#generate')?.getAttribute('aria-busy')!=='true');
}
async function importProject(project){
  await page.locator('#projectInput').setInputFiles({name:'Image generation QA.asun',mimeType:'application/json',buffer:Buffer.from(serializeProject(project))});
  await page.waitForFunction(count=>document.querySelectorAll('.layer-row').length===count&&!document.body.classList.contains('busy'),project.layers.length);
}

test('mainpage supports prompt-only generation with a selected image model and visible progress',async()=>{
  uploadDelay=1000;
  await setPrompt('A red paper kite above a green coastal meadow.');await ready();
  await page.locator('#model').selectOption(alternateModel);
  // GPT Image 1.5 cannot preserve the blank 1600 × 1000 canvas's 8:5 ratio.
  // Choose its supported format explicitly; the app must not substitute one.
  assert.equal(await page.locator('#generate').isDisabled(),true);
  await page.locator('#imageOutputAspect').selectOption('3:2');
  await page.locator('#generate').click();await requested();
  assert.equal(await page.locator('#generate').isDisabled(),true);
  assert.equal(await page.locator('#generate .image-generation-spinner').count(),1);
  await page.locator('#generate').evaluate(button=>button.click());await page.waitForTimeout(150);
  assert.equal(requests.length,1,'A duplicate click cannot create another request.');
  await ready();assert.equal(await page.locator('#model').isEnabled(),true,'A queued job releases the model selector.');assert.equal(await page.locator('#imageQuality').isEnabled(),true);
  assert.equal(requests[0].model,alternateModel);assert.equal(requests[0].project.prompt,'A red paper kite above a green coastal meadow.');
  assert.equal(prepareImageRequest(requests[0]).size,'1536x1024');
  assert.equal(requests[0].project.original,null);assert.deepEqual(requests[0].project.layers,[]);
  assert.doesNotMatch(JSON.stringify(requests[0]),/exactly 7 distinct camera angles|WHITE \(#FFFFFF\)|character \/ item reference sheet/);
  assert.match(await page.locator('#imageGenerationStatus').textContent(),/queue|keep editing|job/i);
  await page.screenshot({path:path.join(qa,'mainpage-image-generating.png')});await finishJob();
  await page.screenshot({path:path.join(qa,'mainpage-image-result-light.png')});
  const pending=page.waitForEvent('download');await page.locator('[data-image-result-download]').click();const result=await download(pending);
  assert.match(result.name,/\.png$/);assert.deepEqual(result.buffer,Buffer.from(completedSource.split(',')[1],'base64'));
  await closeResult();const after=await savedProject();assert.equal(after.original,null);assert.deepEqual(after.layers,[]);assert.equal(after.references.length,0);assert.equal(requests.length,1);
});

test('canvas and reference generation preserves original work until the returned image is explicitly added',async()=>{
  const original=await importMain(),reference=await fixture('#6e9b68',220,220);
  await page.locator('#referenceInput').setInputFiles(file(reference,'Reference material.png'));
  await page.waitForFunction(()=>document.querySelectorAll('#referenceList .reference-card').length===1&&!document.body.classList.contains('busy'));
  await setPrompt('Use the reference material on the central object and keep its framing.');const before=await savedProject();await ready();
  await page.locator('#generate').click();await requested();
  assert.equal(requests[0].project.assets[requests[0].project.original.assetId].source,original);
  assert.equal(requests[0].project.references[0].source,reference);assert.equal(requests[0].project.prompt,before.prompt);
  await finishJob();await closeResult();const untouched=await savedProject();assert.deepEqual(untouched,before,'Merely generating and closing the preview leaves the native project unchanged.');
  // The completed image must remain available when the result is reopened.
  const reopen=page.locator('[data-image-open-result],#imageGenerationResult');
  if(await reopen.count())await reopen.first().click();
  else await page.locator('#imageGenerationStatus').getByRole('button').first().click();
  await page.locator('#desktopImageResultDialog').waitFor({state:'visible'});
  await page.locator('[data-image-result-reference]').click();await closeResult();
  const withReference=await savedProject();assert.deepEqual(withReference.original,before.original);assert.deepEqual(withReference.layers,before.layers);assert.deepEqual(withReference.assets,before.assets);assert.equal(withReference.references.at(-1).source,completedSource);
  if(await reopen.count())await reopen.first().click();else await page.locator('#imageGenerationStatus').getByRole('button').first().click();
  await page.locator('[data-image-result-layer]').click();await closeResult();
  const withLayer=await savedProject();assert.deepEqual(withLayer.original,before.original);assert.deepEqual(withLayer.layers.slice(0,before.layers.length),before.layers);
  const layer=withLayer.layers.at(-1);assert.equal(layer.kind,'raster');assert.equal(withLayer.assets[layer.assetId].source,completedSource);
  assert.ok(layer.x>=0&&layer.y>=0&&layer.x+layer.width<=withLayer.width+0.1&&layer.y+layer.height<=withLayer.height+0.1,'The explicitly added result fits the composition.');
  await page.locator('#undo').click();const undone=await savedProject();assert.deepEqual(undone,withReference,'Adding the result layer is one undoable operation.');assert.equal(requests.length,1);
});

test('numbered area comments and references can generate without a top-level prompt',async()=>{
  const original=await fixture('#bc8d66'),reference=await fixture('#52889d',220,220);
  let project=addRaster(newProject(480,320,'Numbered edit'),{name:'Numbered source.png',source:original,width:480,height:320}).project;
  const added=addText(project,{content:'1',x:190,y:100,width:45,height:55,fontSize:36,color:'#ff0000'});project=added.project;
  project=addReference(project,{name:'Target material.png',source:reference,width:220,height:220});
  project=linkReferences(project,added.layerId,[project.references[0].id]);project=updateLabelComment(project,added.layerId,'Apply this material to the numbered object.');
  await importProject(project);assert.equal(await page.locator('#prompt').inputValue(),'');await ready();
  await page.locator('#generate').click();await requested();
  const numbered=requests[0].project.layers.find(layer=>layer.referenceComment);
  assert.equal(numbered.referenceComment,'Apply this material to the numbered object.');assert.deepEqual(numbered.referenceIds,[project.references[0].id]);
  assert.equal(requests[0].project.references[0].source,reference);await finishJob();assert.equal(requests.length,1);
});

test('rendered request separates clean composition, annotation guides and clipped disconnected group masks',async()=>{
  const original=await solid('#804020'),hidden=await solid('#0000ff'),refSource=await solid('#206080');
  const base=addRaster(newProject(80,60,'Grouped material edit'),{name:'Four corners.png',source:original,width:40,height:40},{fitDocument:false});
  let project=updateLayer(base.project,base.layerId,{x:10,y:10,width:40,height:40,brightness:50,mask:[{mode:'hide',size:12,points:[[5,5]]},{mode:'restore',size:4,points:[[5,5]]}]});
  const extra=addRaster(project,{name:'Hidden source.png',source:hidden,width:40,height:40},{fitDocument:false});project=updateLayer(extra.project,extra.layerId,{visible:false});
  project=addReference(project,{name:'Blue appearance.png',source:refSource,width:40,height:40});const ref=project.references[0];
  const refAnnotated=addDrawing(referenceProject(ref),{mode:'pencil',color:'#00ff00',size:6,points:[[8,20],[30,20]]});
  project=updateReferenceAnnotations(project,ref.id,refAnnotated.project.layers.slice(1));
  const numbered=addText(project,{content:'1',x:25,y:15,width:10,height:12,fontSize:10,color:'#ff0000'});project=numbered.project;
  project=linkReferences(project,numbered.layerId,[ref.id]);project=updateLabelComment(project,numbered.layerId,'Use the blue reference on all four corner objects.');
  project=attachObjectRegion(project,numbered.layerId,{version:1,assetId:project.original.assetId,rasterLayerId:base.layerId,sourceWidth:40,sourceHeight:40,mask:{width:4,height:4,counts:[0,1,2,1,8,1,2,1]},group:{areaCount:4}});
  project=addDrawing(project,{mode:'pencil',color:'#00ff00',size:4,points:[[25,30],[35,30]]}).project;
  await importProject(project);await ready();await page.locator('#generate').click();await requested();const input=requests[0];
  assert.deepEqual([input.composition.width,input.composition.height],[80,60]);assert.deepEqual([input.guide.width,input.guide.height],[80,60]);
  const compositionPixels=await pixels(input.composition.source,[[2,2],[35,35],[12,15],[15,15],[30,30]]);
  assert.equal(compositionPixels[0][3],0,'Hidden layers and empty canvas remain transparent in the clean composition.');
  assert.deepEqual(compositionPixels[1],[64,32,16,255],'The clean composition reflects the raster placement and brightness adjustment.');
  assert.equal(compositionPixels[2][3],0,'A hidden part of the source is masked out.');assert.equal(compositionPixels[3][3],255,'A restored part of the source is visible.');
  assert.deepEqual(compositionPixels[4],[64,32,16,255],'The drawing stroke is absent from the clean composition.');
  assert.deepEqual((await pixels(input.guide.source,[[30,30]]))[0],[0,255,0,255],'The drawing stroke is visible in its separate annotation guide.');
  assert.equal(input.referencePreviews.length,1);assert.equal(input.referencePreviews[0].id,ref.id);assert.equal(input.project.references[0].source,refSource);
  assert.deepEqual((await pixels(input.referencePreviews[0].image.source,[[20,20]]))[0],[0,255,0,255],'Reference markings are sent in a separate preview.');
  assert.equal(input.areaMasks.length,1);assert.equal(input.areaMasks[0].id,numbered.layerId);
  const maskPixels=await pixels(input.areaMasks[0].image.source,[[2,2],[45,15],[15,45],[45,45],[30,30],[12,15],[15,15]]);
  assert.deepEqual(maskPixels,[[0,0,0,255],[255,255,255,255],[255,255,255,255],[255,255,255,255],[0,0,0,255],[0,0,0,255],[255,255,255,255]],'Group masks select disconnected areas, exclude gaps, and honor hide/restore strokes.');
  const prepared=prepareImageRequest(input);assert.match(prepared.prompt,/"groupAreaCount": 4/);assert.match(prepared.prompt,/Use the blue reference on all four corner objects/);assert.ok(prepared.images.some(image=>image.bytes.equals(Buffer.from(refSource.split(',')[1],'base64'))));
  await finishJob();assert.equal(requests.length,1);
});

test('image provider failure is visible and a retry requires a new explicit click',async()=>{
  await setPrompt('A soft red kite against a grey sky.');await ready();mode='failed';
  await page.locator('#generate').click();await requested();
  await page.waitForFunction(()=>document.querySelector('#imageGenerationStatus')?.textContent.includes('Test provider declined'));
  await page.waitForTimeout(1700);assert.equal(requests.length,1);assert.equal(await page.locator('#desktopImageResultDialog').isVisible(),false);
  await ready();mode='completed';await page.locator('#generate').click();await requested(2);await finishJob();assert.notEqual(requests[0].requestId,requests[1].requestId);
});

test('an in-flight main image request is recovered after reload without a duplicate generation',async()=>{
  await setPrompt('A red kite on a grassy hill.');await ready();await page.locator('#generate').click();await requested();const id=requests[0].requestId;
  providerReady=false;await page.reload();await page.waitForFunction(()=>document.documentElement.dataset.ready==='true');
  if(await page.locator('#skipStartup').isVisible())await page.locator('#skipStartup').click();
  assert.equal(await page.locator('#prompt').inputValue(),'');assert.equal(await page.locator('#generate').isDisabled(),true);
  await finishJob();assert.equal(requests.length,1);assert.equal(requests[0].requestId,id);
});

test('an open previous-result preview keeps its download and add actions bound while a newer image completes',async()=>{
  await setPrompt('A blue glass object.');await ready();await page.locator('#generate').click();await requested();await finishJob();const first=completedSource;
  await closeResult();await setPrompt('A green glass object.');mode='running';await ready();await page.locator('#generate').click();await requested(2);
  await page.locator('#imageGenerationResult').click();await page.locator('#desktopImageResultDialog').waitFor({state:'visible'});
  assert.equal(await page.locator('[data-image-result]').getAttribute('src'),first);
  completedSource=await fixture('#64904f',960,640,true);const second=completedSource;mode='completed';
  const priorPolls=finishedPolls;for(let i=0;i<100&&finishedPolls===priorPolls;i++)await page.waitForTimeout(50);assert(finishedPolls>priorPolls);await page.waitForTimeout(100);
  assert.equal(await page.locator('[data-image-result]').getAttribute('src'),first,'Finishing a newer job does not silently replace an already open preview.');
  const pending=page.waitForEvent('download');await page.locator('[data-image-result-download]').click();const saved=await download(pending);
  assert.deepEqual(saved.buffer,Buffer.from(first.split(',')[1],'base64'),'Save image saves the image currently displayed.');
  await page.locator('[data-image-result-reference]').click();await closeResult();const project=await savedProject();
  assert.equal(project.references.at(-1).source,first,'Add to references adds the displayed image, not the newer unseen result.');
  await page.locator('#imageGenerationResult').click();await page.locator('#desktopImageResultDialog').waitFor({state:'visible'});
  assert.equal(await page.locator('[data-image-result]').getAttribute('src'),second,'Reopening result displays the latest completed image.');assert.equal(requests.length,2);
});

test('main generation stays unavailable until connected and blank requests cannot be submitted',async()=>{
  await page.waitForFunction(()=>document.querySelector('#model')?.options.length===2);assert.equal(await page.locator('#generate').isDisabled(),true);
  await setPrompt('A colorful paper sculpture.');await ready();await page.locator('#prompt').fill('');
  assert.equal(await page.locator('#generate').isDisabled(),true,'Clearing a previously committed prompt disables Generate immediately.');
  providerReady=false;await page.reload();await page.waitForFunction(()=>document.documentElement.dataset.ready==='true');
  if(await page.locator('#skipStartup').isVisible())await page.locator('#skipStartup').click();
  await setPrompt('A glass sculpture on a table.');
  await page.waitForFunction(()=>/not connected|disconnected/i.test(document.querySelector('#imageGenerationStatus')?.textContent||document.querySelector('#imageConnectionState')?.textContent||''));
  assert.equal(await page.locator('#generate').isDisabled(),true);assert.equal(requests.length,0);assert.equal(await page.locator('#desktopImageResultDialog').isVisible(),false);
});

test('image model and generate controls remain usable in dark compact and wide desktop layouts',async()=>{
  await importMain();await setPrompt('Keep the composition and use frosted glass.');await ready();await page.locator('#model').selectOption(alternateModel);await page.locator('#themeToggle').click();
  for(const [width,height] of [[1440,900],[1024,768]]){
    await page.setViewportSize({width,height});
    const metrics=await page.locator('.composer').evaluate(el=>({width:el.clientWidth,scroll:el.scrollWidth,controls:[...el.querySelectorAll('#prompt,#model,#generate')].map(control=>({id:control.id,...control.getBoundingClientRect().toJSON()}))}));
    assert.ok(metrics.scroll<=metrics.width+1,`Composer does not overflow at ${width}px`);
    for(const control of metrics.controls)assert.ok(control.left>=0&&control.right<=width+1&&control.width>70,`${control.id} fits on screen at ${width}px.`);
    for(let i=0;i<metrics.controls.length;i++)for(let j=i+1;j<metrics.controls.length;j++){const a=metrics.controls[i],b=metrics.controls[j];assert.ok(Math.min(a.right,b.right)-Math.max(a.left,b.left)<=1||Math.min(a.bottom,b.bottom)-Math.max(a.top,b.top)<=1,`${a.id} and ${b.id} do not overlap.`);}
    await page.locator('#toast').waitFor({state:'hidden'});
    await page.screenshot({path:path.join(qa,`mainpage-image-controls-dark-${width}.png`)});
  }
  mode='completed';await page.locator('#generate').click();await finishJob();
  await page.screenshot({path:path.join(qa,'mainpage-image-result-dark-1024.png')});
  const dialog=await page.locator('#desktopImageResultDialog').boundingBox();assert.ok(dialog.x>=0&&dialog.x+dialog.width<=1024&&dialog.y>=0&&dialog.y+dialog.height<=768);
});
