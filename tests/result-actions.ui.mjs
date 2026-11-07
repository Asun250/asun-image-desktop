import {test,before,after,beforeEach,afterEach} from 'node:test';
import assert from 'node:assert/strict';
import {mkdir,writeFile} from 'node:fs/promises';
import path from 'node:path';
import {chromium} from 'playwright';
import {createServer} from '../server.mjs';
import {newProject,addRaster,addText,addDrawing,addReference,linkReferences,updateLabelComment,serializeProject,updateLayer,attachObjectRegion,referenceProject,updateReferenceAnnotations,updateReferenceNotes} from '../public/core.mjs';

const qa=path.resolve('qa','result-actions'),model='gpt-image-2.5-sunburst',otherModel='gpt-image-1.5';
const report={suite:'Completed output editing and exact generation setup reuse',paidCalls:0,cases:[]};
let server,browser,context,page,base,errors,requests,records,sources,output,holdCompletion,sourceFailure,sourceReads,sourceDelay;
before(async()=>{await mkdir(qa,{recursive:true});server=createServer({detection:{status:async()=>({available:false}),dispose(){}},sheets:{dispose(){}},images:{dispose(){}}});await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));base=`http://127.0.0.1:${server.address().port}`;browser=await chromium.launch({headless:true});});
after(async()=>{await writeFile(path.join(qa,'report.json'),JSON.stringify(report,null,2));await browser?.close();if(server)await new Promise(resolve=>server.close(resolve));});
beforeEach(async()=>{
  errors=[];requests=[];records=new Map();sources=new Map();sourceReads=[];holdCompletion=false;sourceFailure='';sourceDelay=0;
  context=await browser.newContext({viewport:{width:1440,height:1000},acceptDownloads:true});
  await context.addInitScript(()=>localStorage.setItem('asun-image-appearance','dark'));
  page=await context.newPage();page.on('pageerror',error=>errors.push(error.message));
  output=await fixture('#548d9b',960,640,'Generated image — simulated provider for UI verification');
  await context.route('**/*',async route=>{
    const request=route.request(),url=new URL(request.url());
    if(url.origin!==base){errors.push('External request blocked: '+url.origin);return route.abort();}
    const json=(data,status=200)=>route.fulfill({status,contentType:'application/json',body:JSON.stringify(data)});
    if(url.pathname==='/api/generation-queue/status')return json({error:'Legacy mock route'},404);
    if(url.pathname.startsWith('/api/sheets/'))return json({configured:false,authenticated:false,models:[],token:'qa-sheet',message:'Sheet generation is disconnected for the main result suite.'});
    if(url.pathname==='/api/images/status')return json({configured:true,authenticated:true,models:[{id:model,label:'GPT Image 2.5 · Sunburst',available:true},{id:otherModel,label:'GPT Image 1.5',available:true}],token:'qa-result',message:'Mock provider ready.'});
    if(url.pathname==='/api/images/generate'){
      assert.equal(request.method(),'POST');assert.equal(request.headers()['x-asun-image-token'],'qa-result');
      const body=request.postDataJSON();requests.push(body);sources.set(body.requestId,structuredClone(body.project));
      const record={id:body.requestId,status:'completed',mode:'image',model:body.model,sourceName:body.project.name,sourceProjectAvailable:true,image:{name:'Generated result.png',source:output,width:960,height:640},settings:{model:body.model,quality:body.quality,size:'1024x1024',prompt:body.project.prompt,inputs:[]},availableInputs:[],outputAvailable:true};records.set(record.id,record);return json({id:record.id,status:'running'},202);
    }
    const match=/^\/api\/images\/jobs\/([^/]+)(?:\/(project))?$/.exec(url.pathname);
    if(match){assert.equal(request.headers()['x-asun-image-token'],'qa-result');const [,id,asset]=match,record=records.get(id);if(!record)return json({error:'Saved generation missing.'},404);
      if(asset){sourceReads.push(id);if(sourceDelay)await new Promise(resolve=>setTimeout(resolve,sourceDelay));if(sourceFailure==='missing')return json({error:'Saved editable setup is unavailable. Your current project has not changed.'},404);if(sourceFailure==='corrupt')return json({project:{format:'bad',layers:[]}});return json({project:sources.get(id)});}
      return json(holdCompletion?{id,status:'running'}:record);
    }
    if(url.pathname==='/api/local-detection/status')return json({available:false,message:'Detection unavailable in UI suite. Manual selection remains available.'});
    if(request.method()==='POST'&&url.pathname.startsWith('/api/')){errors.push('Unexpected API POST: '+url.pathname);return json({error:'Not allowed in UI verification.'},500);}
    return route.continue();
  });
  await page.goto(base);await page.waitForFunction(()=>document.documentElement.dataset.ready==='true');
  if(await page.locator('#skipStartup').isVisible())await page.locator('#skipStartup').click();
  await page.waitForFunction(()=>document.querySelector('#model')?.value==='gpt-image-2.5-sunburst');
});
afterEach(async info=>{try{if(info.error)await page.screenshot({path:path.join(qa,'failure-'+info.name.replace(/\W+/g,'-')+'.png')});assert.deepEqual(errors,[]);report.cases.push({name:info.name,status:info.error?'failed':'passed',error:info.error?.message,generationRequests:requests.length,sourceReads});}finally{await context?.close();}});
async function fixture(color,width=480,height=320,label='Original source image'){
  return page.evaluate(({color,width,height,label})=>{const c=document.createElement('canvas');c.width=width;c.height=height;const x=c.getContext('2d');x.fillStyle='#eee8dd';x.fillRect(0,0,width,height);x.fillStyle=color;x.fillRect(width*.2,height*.2,width*.6,height*.55);x.fillStyle='#183d42';x.fillRect(width*.63,height*.35,width*.1,height*.25);x.fillStyle='#1a2935';x.font=`${Math.max(12,Math.round(width*.023))}px Arial`;x.fillText(label,width*.035,height*.92);return c.toDataURL();},{color,width,height,label});
}
async function richProject(){
  const source=await fixture('#b9804f'),reference=await fixture('#5f9e64',240,180,'Reference material'),second=await fixture('#ad78bd',220,160,'Secondary appearance');
  const baseLayer=addRaster(newProject(480,320,'Exact reference and detection source'),{name:'Original building.png',source,width:480,height:320});
  let project=updateLayer(baseLayer.project,baseLayer.layerId,{brightness:93,mask:[{mode:'hide',size:8,points:[[20,20],[40,20]]},{mode:'restore',size:3,points:[[25,20]]}]});
  for(const [name,image,width,height]of [['Appearance.png',reference,240,180],['Other view.png',second,220,160]])project=addReference(project,{name,source:image,width,height});
  project=updateReferenceNotes(project,project.references[0].id,'Use only the green surface. Preserve the building proportions.');
  let annotations=addDrawing(referenceProject(project.references[0]),{mode:'pencil',color:'#ff0000',size:6,points:[[40,40],[180,40],[180,120]]}).project;
  annotations=addText(annotations,{content:'USE THIS',x:40,y:60,width:100,height:35,fontSize:18,color:'#1d2330'}).project;
  project=updateReferenceAnnotations(project,project.references[0].id,annotations.layers.slice(1));
  const numbered=addText(project,{content:'1',x:120,y:90,width:30,height:35,fontSize:25,color:'#ff0000'});project=numbered.project;
  project=linkReferences(project,numbered.layerId,project.references.map(ref=>ref.id));project=updateLabelComment(project,numbered.layerId,'Apply the two references to all selected areas; keep the camera unchanged.');
  project=attachObjectRegion(project,numbered.layerId,{version:1,assetId:project.original.assetId,rasterLayerId:baseLayer.layerId,sourceWidth:480,sourceHeight:320,mask:{width:4,height:4,counts:[0,1,2,1,8,1,2,1]},group:{areaCount:4}});
  project=addDrawing(project,{mode:'pencil',color:'#f15d4e',size:4,points:[[120,70],[200,60],[300,80]]}).project;
  project=addDrawing(project,{mode:'highlight',color:'#ffff00',size:25,points:[[130,120],[200,130]]}).project;
  project.prompt='Use every original detection area and its exact annotated references.';return project;
}
async function load(project){await page.locator('#projectInput').setInputFiles({name:'Result actions QA.asun',mimeType:'application/json',buffer:Buffer.from(serializeProject(project))});await page.waitForFunction(count=>document.querySelectorAll('.layer-row').length===count&&!document.body.classList.contains('busy'),project.layers.length);}
async function save(){await page.waitForFunction(()=>!document.body.classList.contains('busy'));const pending=page.waitForEvent('download');await page.locator('#saveProject').click();const entry=await pending,stream=await entry.createReadStream(),chunks=[];for await(const chunk of stream)chunks.push(chunk);await page.waitForTimeout(725);return JSON.parse(Buffer.concat(chunks).toString());}
async function prompt(value){await page.locator('#prompt').fill(value);await page.locator('#prompt').dispatchEvent('change');}
async function closeResult(){await page.locator('[data-image-result-close]').first().click();await page.locator('#desktopImageResultDialog').waitFor({state:'hidden'});}
async function openResult(){await page.locator('#imageGenerationResult').click();await page.locator('#desktopImageResultDialog').waitFor({state:'visible'});}
async function generate(){const count=requests.length;await page.waitForFunction(()=>!document.querySelector('#generate').disabled);await page.locator('#generate').click();await page.waitForFunction(()=>/ready in Job queue/.test(document.querySelector('#imageGenerationStatus').textContent));assert.equal(await page.locator('#desktopImageResultDialog').isVisible(),false);await openResult();assert.equal(requests.length,count+1);return requests.at(-1);}
async function clickAction(action){await page.locator(`[data-image-result-${action}]`).click();await page.locator('#desktopImageResultDialog').waitFor({state:'hidden'});await page.waitForFunction(()=>!document.body.classList.contains('busy'));}
async function reachable(selector){await page.locator(selector).scrollIntoViewIfNeeded();const b=await page.locator(selector).evaluate(e=>{const r=e.getBoundingClientRect(),hit=document.elementFromPoint(r.x+r.width/2,r.y+r.height/2);return {ok:hit===e||e.contains(hit),x:r.x,y:r.y,right:r.right,bottom:r.bottom,w:innerWidth,h:innerHeight};});assert.ok(b.ok&&b.x>=0&&b.y>=0&&b.right<=b.w+1&&b.bottom<=b.h+1,selector+' reachable '+JSON.stringify(b));}

test('Redo restores the exact generation-time source, references, masks and settings and waits for Generate',{timeout:60000},async()=>{
  const original=await richProject();await load(original);await page.locator('#imageQuality').selectOption('max');const submitted=await generate();await closeResult();
  await prompt('Later unsaved changes must not become the saved generation setup.');await page.locator('#model').selectOption(otherModel);await page.locator('#imageQuality').selectOption('low');const later=await save();
  await openResult();await clickAction('redo');const restored=await save();assert.deepEqual(restored,submitted.project,'All native fields restore from the request-time snapshot, including annotated references and disconnected masks.');assert.deepEqual(submitted.project,original);
  assert.equal(await page.locator('#model').inputValue(),model);assert.equal(await page.locator('#imageQuality').inputValue(),'max');assert.equal(requests.length,1,'Redo restores setup but does not issue a paid request.');
  await page.locator('#undo').click();assert.deepEqual(await save(),later,'The complete previous editor state is recoverable with Undo.');await page.locator('#redo').click();assert.deepEqual(await save(),restored);
  await prompt(restored.prompt+' Add warm window lights.');await generate();assert.equal(requests.length,2);assert.notEqual(requests[0].requestId,requests[1].requestId);assert.match(requests[1].project.prompt,/Add warm window lights/);assert.deepEqual(requests[1].project.references,restored.references);assert.deepEqual(requests[1].project.layers,restored.layers);
});

test('Edit output starts a new editable raster canvas and Undo restores all preceding work',{timeout:60000},async()=>{
  await load(await richProject());await generate();await closeResult();await prompt('Preserve this later working draft.');const before=await save();await openResult();await clickAction('edit');
  const edited=await save();assert.deepEqual([edited.width,edited.height],[960,640]);assert.equal(edited.layers.length,1);assert.equal(edited.layers[0].kind,'raster');assert.equal(edited.assets[edited.original.assetId].source,output);assert.equal(edited.prompt,'');assert.equal(edited.references.length,0);assert.equal(edited.layers.some(layer=>layer.objectRegion),false,'Old detection masks do not apply to changed generated pixels.');
  assert.equal(await page.locator('#imageEditWorkspaceBar').isVisible(),true);assert.equal(await page.locator('#imageEditAutoDetect').isEnabled(),true);assert.equal(await page.locator('#imageEditBrushSize').isVisible(),true);
  await page.locator('#imageEditBack').click();await page.locator('.toolrail [data-tool="highlight"]').click();assert.equal(await page.locator('#brushOptions').isVisible(),true);await page.locator('.toolrail [data-tool="move"]').click();
  await page.screenshot({path:path.join(qa,'edited-generated-output.png')});assert.equal(requests.length,1);await page.locator('#undo').click();assert.deepEqual(await save(),before);
});

test('source load errors leave the editor untouched and retain the result for another attempt',{timeout:60000},async()=>{
  await load(await richProject());await generate();await closeResult();await prompt('New unsaved draft must survive failure.');const before=await save();
  for(const failure of ['missing','corrupt']){sourceFailure=failure;await openResult();await page.locator('[data-image-result-redo]').click();await page.waitForFunction(()=>Boolean(document.querySelector('[data-image-result-status]')?.textContent.trim()));assert.equal(await page.locator('#desktopImageResultDialog').isVisible(),true);await closeResult();assert.deepEqual(await save(),before,'Invalid or missing saved setups never partially replace the canvas.');assert.equal(requests.length,1);}
  sourceFailure='';await openResult();await clickAction('redo');assert.deepEqual(await save(),requests[0].project);assert.equal(requests.length,1);
});

test('legacy results clearly report missing editable setup while their output can still be edited',{timeout:60000},async()=>{
  await load(await richProject());await generate();await closeResult();const id=requests[0].requestId;records.get(id).sourceProjectAvailable=false;
  await page.locator('#imageGenerationRefresh').click();await page.waitForFunction(()=>!document.querySelector('#imageGenerationRefresh').disabled);await openResult();
  const redo=page.locator('[data-image-result-redo]');if(await redo.isEnabled()){await redo.click();await page.waitForFunction(()=>/saved|older|unavailable/i.test(document.querySelector('[data-image-result-status]')?.textContent||''));}
  else assert.match((await redo.getAttribute('title'))+' '+await page.locator('#desktopImageResultDialog').innerText(),/older|saved editable setup|unavailable/i);
  assert.equal(sourceReads.length,0);await clickAction('edit');const edited=await save();assert.equal(edited.assets[edited.original.assetId].source,output);assert.equal(requests.length,1);
});

test('closing a pending setup restore cancels it and protects edits made after returning',{timeout:60000},async()=>{
  await load(await richProject());await generate();await closeResult();await prompt('Draft before cancellation.');const before=await save();sourceDelay=1500;
  await openResult();await page.locator('[data-image-result-redo]').click();for(let i=0;i<100&&!sourceReads.length;i++)await new Promise(resolve=>setTimeout(resolve,10));assert.equal(sourceReads.length,1);
  await page.keyboard.press('Escape');await page.locator('#desktopImageResultDialog').waitFor({state:'hidden'});await prompt('Keep these edits after cancellation.');await page.waitForTimeout(1800);
  const after=await save();assert.deepEqual({...after,prompt:before.prompt},before,'The delayed response cannot overwrite the editor after the user closes the preview.');assert.equal(after.prompt,'Keep these edits after cancellation.');assert.equal(requests.length,1);
  sourceDelay=0;await openResult();await clickAction('redo');assert.deepEqual(await save(),requests[0].project);
});

test('an open previous result remains bound to its original setup when another generation completes',{timeout:60000},async()=>{
  await load(await richProject());await page.locator('#imageQuality').selectOption('max');await generate();await closeResult();await prompt('Second setup with a different requested look.');await page.locator('#imageQuality').selectOption('low');holdCompletion=true;
  await page.locator('#generate').click();await page.waitForFunction(()=>document.querySelector('#generate').getAttribute('aria-busy')==='false');await openResult();holdCompletion=false;await page.waitForFunction(()=>/ready in Job queue/.test(document.querySelector('#imageGenerationStatus').textContent));
  assert.equal(requests.length,2);await clickAction('redo');assert.deepEqual(await save(),requests[0].project);assert.equal(await page.locator('#imageQuality').inputValue(),'max');assert.deepEqual(sourceReads,[requests[0].requestId]);assert.equal(requests.length,2);
});

test('result actions remain readable and reachable on compact light and dark desktop layouts',{timeout:60000},async()=>{
  await load(await richProject());await generate();
  for(const width of [1440,1024])for(const theme of ['dark','light']){await page.setViewportSize({width,height:768});await page.evaluate(theme=>document.documentElement.dataset.theme=theme,theme);for(const selector of ['[data-image-result-edit]','[data-image-result-redo]','[data-image-result-download]'])await reachable(selector);const overflow=await page.locator('#desktopImageResultDialog').evaluate(e=>({scroll:e.scrollWidth,width:e.clientWidth}));assert.ok(overflow.scroll<=overflow.width+1);await page.screenshot({path:path.join(qa,`result-actions-${theme}-${width}.png`)});}
  assert.equal(requests.length,1);
});

test('editing a sketch output preserves both independent drafts and Redo returns to the saved sketch',{timeout:60000},async()=>{
  const main=await richProject();await load(main);await page.locator('#drawSketchReference').click();await page.locator('#sketchWorkspaceBar').waitFor({state:'visible'});await page.locator('#sketchDraw').click();
  const board=await page.locator('#board').boundingBox();await page.mouse.move(board.x+board.width*.2,board.y+board.height*.3);await page.mouse.down();for(const [x,y]of [[.6,.3],[.6,.7],[.2,.7],[.2,.3]])await page.mouse.move(board.x+board.width*x,board.y+board.height*y,{steps:4});await page.mouse.up();
  await prompt('Make this sketch into a stone building.');const sketch=await save();assert.equal(sketch.sketch.version,1);assert.equal(sketch.layers.filter(layer=>layer.kind==='drawing').length,1);
  await generate();await clickAction('edit');const edited=await save();assert.equal(edited.sketch,undefined);assert.equal(edited.assets[edited.original.assetId].source,output);assert.equal(await page.locator('#sketchWorkspaceBar').isVisible(),false);
  await page.locator('#undo').click();assert.deepEqual(await save(),main,'The independent main canvas remains recoverable with Undo.');
  await page.locator('#drawSketchReference').click();await page.locator('#sketchWorkspaceBar').waitFor({state:'visible'});assert.deepEqual(await save(),sketch,'The immediately preceding sketch is retained as an editable independent draft.');
  await prompt('A later sketch change.');const later=await save();await openResult();await clickAction('redo');assert.deepEqual(await save(),sketch);assert.equal(await page.locator('#sketchWorkspaceBar').isVisible(),true);assert.equal(new URL(page.url()).searchParams.get('workspace'),'sketch');
  await page.locator('#undo').click();assert.deepEqual(await save(),later,'Restoring a sketch setup is undoable within its correct workspace.');assert.equal(requests.length,1);
});

test('History links actually reopen exact setups or editable output without submitting generation',{timeout:60000},async()=>{
  await load(await richProject());await page.locator('#imageQuality').selectOption('max');const request=await generate();
  await page.goto(`${base}/?generation=${request.requestId}&kind=image&action=redo`);await page.waitForFunction(text=>document.documentElement.dataset.ready==='true'&&!document.body.classList.contains('busy')&&document.querySelector('#prompt')?.value===text,request.project.prompt);
  assert.deepEqual(await save(),request.project);assert.equal(await page.locator('#model').inputValue(),model);assert.equal(await page.locator('#imageQuality').inputValue(),'max');assert.equal(requests.length,1);
  await page.goto(`${base}/?generation=${request.requestId}&kind=image&action=edit`);await page.waitForFunction(()=>document.documentElement.dataset.ready==='true'&&!document.body.classList.contains('busy')&&document.querySelectorAll('.layer-row').length===1&&document.querySelector('#canvas')?.width===960);
  const edited=await save();assert.deepEqual([edited.width,edited.height],[960,640]);assert.equal(edited.assets[edited.original.assetId].source,output);assert.equal(edited.prompt,'');assert.equal(edited.layers.length,1);assert.equal(requests.length,1,'Following either History action is never a generation request.');
});
