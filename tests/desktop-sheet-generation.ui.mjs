import {test,before,after,beforeEach,afterEach} from 'node:test';
import assert from 'node:assert/strict';
import {mkdir,writeFile} from 'node:fs/promises';
import path from 'node:path';
import {chromium} from 'playwright';
import {createServer} from '../server.mjs';
import {buildSheetPrompt,sheetAngles} from '../public/sheet-preset.mjs';

// These tests replace only the local provider boundary. No paid API calls occur.
const qa=path.resolve('qa','desktop-sheet-generation');
const model='gpt-image-2.5-sunburst';
let server,browser,context,page,base,errors,requests,polls,mode,providerReady,completedSource,uploadDelay;
const evidence=[];
before(async()=>{
  await mkdir(qa,{recursive:true});
  server=createServer({detection:{token:'sheet-test',status:async()=>({available:false}),dispose(){}},sheets:{dispose(){}},images:{dispose(){}}});
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  base=`http://127.0.0.1:${server.address().port}`;
  browser=await chromium.launch({headless:true});
});
after(async()=>{
  await writeFile(path.join(qa,'report.json'),JSON.stringify({kind:'mocked-provider-ui-verification',paidCalls:0,evidence},null,2));
  await browser?.close();if(server)await new Promise(resolve=>server.close(resolve));
});
beforeEach(async()=>{
  errors=[];requests=[];polls=0;mode='running';providerReady=true;completedSource='';uploadDelay=0;
  context=await browser.newContext({viewport:{width:1440,height:1000},acceptDownloads:true});
  await context.route('**/*',async route=>{
    const url=new URL(route.request().url());
    if(url.origin!==base){await route.abort();return;}
    const json=(body,status=200)=>route.fulfill({status,contentType:'application/json',body:JSON.stringify(body)});
    if(url.pathname==='/api/generation-queue/status')return json({error:'Legacy mock route'},404);
    if(url.pathname==='/api/images/status')return json({configured:false,authenticated:false,models:[],token:'qa-image-token',message:'Image generation disconnected in sheet UI tests.'});
    if(url.pathname==='/api/sheets/status')return json({configured:providerReady,authenticated:providerReady,models:providerReady?[{id:model,label:'GPT Image 2.5',available:true}]:[],token:'qa-token',message:providerReady?'Connected to a test image provider.':'Image generation is not connected. Configure the local image provider, then check again.'});
    if(url.pathname==='/api/sheets/generate'){
      assert.equal(route.request().method(),'POST');
      assert.equal(route.request().headers()['x-asun-sheet-token'],'qa-token');
      const body=route.request().postDataJSON();requests.push(body);
      if(uploadDelay)await new Promise(resolve=>setTimeout(resolve,uploadDelay));
      return json({id:body.requestId,status:'running'});
    }
    if(url.pathname.startsWith('/api/sheets/jobs/')){
      polls++;const id=url.pathname.split('/').at(-1);
      return json(mode==='failed'?{id,status:'failed',message:'Test provider declined this request. Your photos are safe.'}:mode==='completed'?{id,status:'completed',image:{source:completedSource,width:960,height:640,name:'Seven angle sheet.png'}}:{id,status:'running'});
    }
    await route.continue();
  });
  page=await context.newPage();page.on('pageerror',error=>errors.push(error.message));
  await page.goto(base);await page.waitForFunction(()=>document.documentElement.dataset.ready==='true');
  if(await page.locator('#skipStartup').isVisible())await page.locator('#skipStartup').click();
  completedSource=await fixture('#658baf',960,640,true);
});
afterEach(async info=>{
  try{
    if(info.error)await page.screenshot({path:path.join(qa,'failure-'+info.name.replace(/\W+/g,'-')+'.png')});
    assert.deepEqual(errors,[],'The browser raises no uncaught errors.');
    evidence.push({name:info.name,passed:!info.error,requests:requests.length,polls});
  }finally{await context?.close();}
});
async function fixture(color,width=360,height=480,sheet=false){
  return page.evaluate(({color,width,height,sheet})=>{
    const canvas=document.createElement('canvas');canvas.width=width;canvas.height=height;
    const ctx=canvas.getContext('2d');ctx.fillStyle=sheet?'#fff':'#ddd8d0';ctx.fillRect(0,0,width,height);
    if(sheet){
      const labels=['Front left','Front','Front right','Left','Top','Right','Rear'];
      labels.forEach((label,index)=>{const x=80+(index%4)*220,y=70+Math.floor(index/4)*290;ctx.fillStyle=color;ctx.fillRect(x,y,95+index*5,150);ctx.fillStyle='#172a3b';ctx.font='19px Arial';ctx.fillText(label,x,y+180);});
      ctx.fillStyle='#555';ctx.font='15px Arial';ctx.fillText('QA fixture: simulated provider output',20,height-20);
    }else{ctx.fillStyle=color;ctx.fillRect(width*.25,height*.12,width*.5,height*.76);}
    return canvas.toDataURL('image/png');
  },{color,width,height,sheet});
}
function file(source,name){return {name,mimeType:'image/png',buffer:Buffer.from(source.split(',')[1],'base64')};}
async function importMain(){
  const source=await fixture('#d2813f');
  await page.locator('#imageInput').setInputFiles(file(source,'Original canvas.png'));
  await page.waitForFunction(()=>document.querySelectorAll('.layer-row').length===1&&!document.body.classList.contains('busy'));
  return source;
}
async function openSheet(){
  assert.equal(await page.locator('#characterItemSheet').isVisible(),true,'The desktop has a direct sheet button.');
  await page.locator('#characterItemSheet').click();
  await page.locator('#asunSheetCreator').waitFor({state:'visible'});
  await page.waitForFunction(()=>document.querySelector('[data-sheet-model]')?.options.length>0);
}
async function ready(){
  await page.waitForFunction(()=>!document.querySelector('[data-sheet-action="generate"]')?.disabled);
}
async function download(pending){
  const entry=await pending,stream=await entry.createReadStream(),chunks=[];
  for await(const chunk of stream)chunks.push(chunk);
  return {name:entry.suggestedFilename(),buffer:Buffer.concat(chunks)};
}
async function savedProject(){
  const pending=page.waitForEvent('download');await page.locator('#saveProject').click();
  const saved=await download(pending);await page.waitForTimeout(725);return JSON.parse(saved.buffer.toString());
}
async function finishJob(){
  mode='completed';
  await page.locator('[data-sheet-result-image]').waitFor({state:'visible'});
  await page.waitForFunction(()=>document.querySelector('#asunSheetCreator').getAttribute('aria-busy')!=='true');
  assert.equal(await page.locator('[data-sheet-status]').evaluate(el=>el.classList.contains('is-error')),false);
}
function primary(project){
  const id=project.sheetPreset.sourceId||project.original?.assetId;
  return project.assets[id]||project.references.find(ref=>ref.id===id);
}

test('direct desktop sheet button requests seven white-background views and returns the image in place',async()=>{
  uploadDelay=1000;
  const original=await importMain();
  await page.locator('#prompt').fill('Keep this unrelated scene instruction.');await page.locator('#prompt').dispatchEvent('change');
  const before=await savedProject();
  await openSheet();await ready();
  assert.equal(await page.locator('[data-sheet-views="7"]').getAttribute('aria-pressed'),'true');
  assert.equal(await page.locator('[data-sheet-layout] .sheet-layout-tile').count(),7);
  assert.match(await page.locator('[data-sheet-prompt]').textContent(),/exactly 7 distinct camera angles/);
  assert.match(await page.locator('[data-sheet-prompt]').textContent(),/WHITE \(#FFFFFF\)/);
  assert.equal(await page.locator('[data-sheet-model]').inputValue(),model);
  await page.locator('[data-sheet-subject="character"]').click();
  await page.locator('#asunSheetCreator').evaluate(el=>{el.scrollTop=0;});
  await page.screenshot({path:path.join(qa,'desktop-sheet-settings-light.png')});
  await page.locator('[data-sheet-action="generate"]').click();
  await page.waitForFunction(()=>document.querySelector('#asunSheetCreator').getAttribute('aria-busy')==='true');
  assert.equal(await page.locator('[data-sheet-action="generate"] .sheet-spinner').isVisible(),true);
  await page.waitForTimeout(150);assert.equal(requests.length,1);
  await ready();assert.equal(await page.locator('[data-sheet-model]').isEnabled(),true,'A queued sheet releases its settings.');
  assert.equal(requests[0].model,model);assert.equal(requests[0].project.sheetPreset.views,7);
  assert.equal(primary(requests[0].project).source,original);
  assert.equal(new Set(sheetAngles(requests[0].project.sheetPreset)).size,7);
  assert.match(buildSheetPrompt(requests[0].project),/complete figure, including hands, shoes and feet/);
  await page.screenshot({path:path.join(qa,'desktop-sheet-generating.png')});
  await finishJob();
  assert.equal(await page.locator('[data-sheet-result-image]').getAttribute('src'),completedSource);
  await page.locator('[data-sheet-result-image]').scrollIntoViewIfNeeded();
  await page.screenshot({path:path.join(qa,'desktop-sheet-output-light.png')});
  const pending=page.waitForEvent('download');await page.locator('[data-sheet-action="result-download"]').click();
  const result=await download(pending);assert.match(result.name,/\.png$/);assert.deepEqual(result.buffer,Buffer.from(completedSource.split(',')[1],'base64'));
  await page.locator('[data-sheet-action="result-reference"]').click();
  await page.waitForFunction(()=>document.querySelector('#asunSheetCreator').getAttribute('aria-busy')==='false');
  await page.screenshot({path:path.join(qa,'desktop-sheet-result-light.png')});
  await page.locator('[data-sheet-action="close"]').click();
  const after=await savedProject();
  assert.deepEqual(after.original,before.original);assert.deepEqual(after.layers,before.layers);assert.deepEqual(after.assets,before.assets);assert.equal(after.prompt,before.prompt);
  assert.equal(after.references.length,before.references.length+1);assert.equal(after.references.at(-1).source,completedSource);
  assert.equal(requests.length,1,'Downloading and adding the result do not generate again.');
});

test('an existing reference can be the sheet subject without replacing the original canvas',async()=>{
  const original=await importMain(),reference=await fixture('#3f8b82',320,320);
  await page.locator('#referenceInput').setInputFiles(file(reference,'Reference subject.png'));
  await page.waitForFunction(()=>document.querySelectorAll('#referenceList .reference-card').length===1&&!document.body.classList.contains('busy'));
  const before=await savedProject();await openSheet();await ready();
  const option=await page.locator('[data-sheet-primary] option').filter({hasText:'Reference subject.png'}).getAttribute('value');
  assert.ok(option);await page.locator('[data-sheet-primary]').selectOption(option);
  await page.locator('[data-sheet-action="generate"]').click();await page.waitForTimeout(150);
  assert.equal(requests.length,1);assert.equal(primary(requests[0].project).source,reference);assert.equal(requests[0].project.assets[requests[0].project.original.assetId].source,original);
  await finishJob();await page.locator('[data-sheet-action="close"]').click();
  const after=await savedProject();assert.deepEqual(after.original,before.original);assert.deepEqual(after.layers,before.layers);assert.deepEqual(after.assets,before.assets);assert.deepEqual(after.references,before.references);
  assert.equal(after.sheetPreset.sourceId,option);
});

test('adding a sheet subject keeps the current composition and can explicitly become the main reference',async()=>{
  await importMain();const before=await savedProject();await openSheet();
  const selected=await fixture('#80508f',280,360);
  assert.equal(await page.locator('[data-sheet-action="upload"]').isVisible(),true);
  await page.locator('[data-sheet-source-input]').setInputFiles(file(selected,'New sheet subject.png'));
  await page.waitForFunction(()=>document.querySelector('#asunSheetCreator').getAttribute('aria-busy')==='false'&&[...document.querySelectorAll('.sheet-source-card')].some(card=>card.textContent.includes('New sheet subject.png')));
  const priorMain=await page.locator('[data-sheet-primary]').inputValue();assert.equal(priorMain,before.original.assetId);
  const added=await page.locator('[data-sheet-primary] option').filter({hasText:'New sheet subject.png'}).getAttribute('value');assert.ok(added);
  await page.locator('[data-sheet-primary]').selectOption(added);
  await ready();await page.locator('[data-sheet-action="generate"]').click();await page.waitForTimeout(150);
  assert.equal(primary(requests[0].project).source,selected);assert.ok(requests[0].project.sheetPreset.subjectIds.includes(priorMain),'Choosing a main reference retains the previous subject photo.');await finishJob();
  await page.locator('[data-sheet-action="close"]').click();const after=await savedProject();
  assert.deepEqual(after.original,before.original);assert.deepEqual(after.layers,before.layers);assert.deepEqual(after.assets,before.assets);assert.equal(after.references.length,1);assert.equal(after.references[0].source,selected);
});

test('a project with references but no canvas original can generate from its chosen reference',async()=>{
  const reference=await fixture('#438997',260,360);
  await page.locator('#referenceInput').setInputFiles(file(reference,'Only reference.png'));
  await page.waitForFunction(()=>document.querySelectorAll('#referenceList .reference-card').length===1&&!document.body.classList.contains('busy'));
  await openSheet();
  const option=await page.locator('[data-sheet-primary] option').filter({hasText:'Only reference.png'}).getAttribute('value');
  assert.ok(option);await page.locator('[data-sheet-primary]').selectOption(option);await ready();
  await page.locator('[data-sheet-action="generate"]').click();await page.waitForTimeout(150);
  assert.equal(requests.length,1);assert.equal(primary(requests[0].project).source,reference);assert.equal(requests[0].project.original,null);assert.deepEqual(requests[0].project.layers,[]);
  await finishJob();await page.locator('[data-sheet-action="close"]').click();const after=await savedProject();
  assert.equal(after.original,null);assert.deepEqual(after.layers,[]);assert.equal(after.references.length,1);assert.equal(after.references[0].source,reference);
});

test('provider failure is visible and a new generation requires another explicit click',async()=>{
  await importMain();await openSheet();await ready();mode='failed';
  await page.locator('[data-sheet-action="generate"]').click();
  await page.waitForFunction(()=>document.querySelector('[data-sheet-status]').classList.contains('is-error'));
  assert.match(await page.locator('[data-sheet-status]').innerText(),/Test provider declined/);
  await page.waitForTimeout(1750);assert.equal(requests.length,1);assert.equal(await page.locator('[data-sheet-result-image]').isVisible(),false);
  await ready();mode='completed';await page.locator('[data-sheet-action="generate"]').click();
  await finishJob();assert.equal(requests.length,2);assert.notEqual(requests[0].requestId,requests[1].requestId);
});

test('a pending sheet job can be checked after reload without submitting another generation',async()=>{
  await importMain();await openSheet();await ready();
  await page.locator('[data-sheet-action="generate"]').click();await page.waitForTimeout(150);
  assert.equal(requests.length,1);const requestId=requests[0].requestId;
  providerReady=false;
  await page.reload();await page.waitForFunction(()=>document.documentElement.dataset.ready==='true');
  if(await page.locator('#skipStartup').isVisible())await page.locator('#skipStartup').click();
  assert.equal(await page.locator('.layer-row').count(),0,'Recovery does not require the prior source project to be reopened.');
  await openSheet();assert.equal(await page.locator('[data-sheet-action="generate"]').isDisabled(),true);
  await finishJob();
  assert.equal(requests.length,1,'Checking a persisted job does not submit another paid generation.');
  assert.equal(await page.locator('[data-sheet-result-image]').getAttribute('data-job'),requestId);
});

test('disconnected generation stays honest and never returns a layout guide as a generated image',async()=>{
  providerReady=false;await importMain();await openSheet();
  await page.waitForFunction(()=>document.querySelector('[data-sheet-connection-message]')?.textContent.includes('not connected'));
  assert.equal(await page.locator('[data-sheet-action="generate"]').isVisible(),true);
  assert.equal(await page.locator('[data-sheet-action="generate"]').isDisabled(),true);
  assert.equal(await page.locator('[data-sheet-action="download"]').isEnabled(),true);
  assert.equal(await page.locator('[data-sheet-result-image]').isVisible(),false);assert.equal(requests.length,0);
});

test('sheet controls stay readable and contained in dark and compact desktop layouts',async()=>{
  await importMain();await page.locator('#themeToggle').click();
  for(const [width,height] of [[1440,900],[1024,768]]){
    await page.setViewportSize({width,height});
    const header=await page.locator('.header').evaluate(el=>{
      const bounds=el.getBoundingClientRect();
      const buttons=[...el.querySelectorAll('button')].filter(button=>button.getClientRects().length).map(button=>({id:button.id,...button.getBoundingClientRect().toJSON()}));
      return {left:bounds.left,right:bounds.right,buttons};
    });
    await page.screenshot({path:path.join(qa,`desktop-main-button-${width}.png`)});
    for(const button of header.buttons)assert.ok(button.left>=header.left-1&&button.right<=header.right+1,`Header button ${button.id} stays on screen at ${width}px: ${JSON.stringify(button)}`);
    const sheet=header.buttons.find(button=>button.id==='characterItemSheet');
    // The Draw / sketch entry intentionally allows this label to wrap in the
    // compact header. Check its usable target and actual text, not a 100px width.
    assert.ok(sheet&&sheet.width>=44&&sheet.height>=36,'The direct sheet action has a usable click target.');
    const label=await page.locator('#characterItemSheet').evaluate(button=>{
      const bounds=button.getBoundingClientRect(),range=document.createRange();range.selectNodeContents(button);
      return {text:button.innerText,fontSize:parseFloat(getComputedStyle(button).fontSize),fits:button.scrollWidth<=button.clientWidth+1&&button.scrollHeight<=button.clientHeight+1,lines:[...range.getClientRects()].map(line=>({left:line.left,right:line.right,top:line.top,bottom:line.bottom})),bounds:bounds.toJSON()};
    });
    assert.match(label.text.replace(/\s+/g,' '),/Character\s*\/\s*item sheet/i,'The complete sheet label stays visible.');
    assert.ok(label.fontSize>=11&&label.fits&&label.lines.length>0,'The sheet label stays readable without clipping.');
    for(const line of label.lines)assert.ok(line.left>=label.bounds.left-1&&line.right<=label.bounds.right+1&&line.top>=label.bounds.top-1&&line.bottom<=label.bounds.bottom+1,`The sheet label fits inside its button at ${width}px.`);
    for(const other of header.buttons.filter(button=>button.id!=='characterItemSheet'))assert.ok(Math.min(sheet.right,other.right)-Math.max(sheet.left,other.left)<=1||Math.min(sheet.bottom,other.bottom)-Math.max(sheet.top,other.top)<=1,`Sheet button does not overlap ${other.id} at ${width}px.`);
  }
  await openSheet();await ready();
  for(const [width,height] of [[1440,900],[1024,768]]){
    await page.setViewportSize({width,height});
    await page.locator('[data-sheet-model]').scrollIntoViewIfNeeded();
    const layout=await page.locator('#asunSheetCreator').evaluate(el=>({scroll:el.scrollWidth,width:el.clientWidth,model:el.querySelector('[data-sheet-model]').getBoundingClientRect().toJSON()}));
    assert.ok(layout.scroll<=layout.width+1,`No horizontal overflow at ${width}px`);
    assert.ok(layout.model.width>=180,'Model selector remains usable.');
    await page.locator('[data-sheet-action="generate"]').scrollIntoViewIfNeeded();
    assert.equal(await page.locator('[data-sheet-action="generate"]').isVisible(),true);
    await page.screenshot({path:path.join(qa,`desktop-sheet-dark-${width}.png`)});
    await page.locator('#asunSheetCreator').evaluate(el=>{el.scrollTop=0;});
    await page.screenshot({path:path.join(qa,`desktop-sheet-settings-dark-${width}.png`)});
  }
  assert.equal(requests.length,0);
});
