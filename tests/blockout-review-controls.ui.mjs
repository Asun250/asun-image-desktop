import {test,before,after,beforeEach,afterEach} from 'node:test';
import assert from 'node:assert/strict';
import {mkdir,writeFile} from 'node:fs/promises';
import {chromium} from 'playwright';
import {createServer} from '../server.mjs';
import {prepareImageRequest} from '../desktop-image-request.mjs';
const qa='qa/blockout-review-controls';
let server,browser,context,page,base,requests,errors,source;
before(async()=>{await mkdir(qa,{recursive:true});server=createServer({detection:{status:async()=>({available:false}),dispose(){}},sheets:{dispose(){}},images:{dispose(){}}});await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));base=`http://127.0.0.1:${server.address().port}`;browser=await chromium.launch({headless:true});});
after(async()=>{await browser?.close();await new Promise(resolve=>server.close(resolve));});
beforeEach(async()=>{
  requests=[];errors=[];context=await browser.newContext({viewport:{width:1440,height:1000},acceptDownloads:true});page=await context.newPage();page.on('pageerror',error=>errors.push(error.message));
  await context.route('**/*',async route=>{const request=route.request(),url=new URL(request.url());if(url.origin!==base)return route.abort();if(!url.pathname.startsWith('/api/'))return route.continue();
    if(url.pathname==='/api/images/generate'){const body=request.postDataJSON();requests.push(body);return route.fulfill({json:{id:body.requestId,status:'queued',kind:'image',sourceName:body.project.name}});}
    if(url.pathname==='/api/generation-queue/status')return route.fulfill({json:{items:requests.map(body=>({id:body.requestId,status:'queued',kind:'image',sourceName:body.project.name})),counts:{queued:requests.length,running:0},concurrency:1}});
    return route.fulfill({json:{configured:true,authenticated:true,available:false,token:'qa-review',models:[{id:'gpt-image-2.5-sunburst',available:true,label:'GPT Image 2.5 · Sunburst'}],reviewModel:{id:'gpt-6-astra',effort:'max',available:true},items:[]}});
  });
  await page.goto(base);await page.waitForFunction(()=>document.documentElement.dataset.ready==='true');if(await page.locator('#skipStartup').isVisible())await page.locator('#skipStartup').click();
  source=await page.evaluate(()=>{const c=document.createElement('canvas');c.width=960;c.height=540;const x=c.getContext('2d');x.fillStyle='#d7dfe4';x.fillRect(0,0,960,540);x.fillStyle='#677f95';x.fillRect(200,120,300,300);x.fillStyle='#7f687a';x.fillRect(590,230,130,190);x.fillStyle='#232b34';x.font='22px Arial';x.fillText('QA blockout · same camera and placement',30,500);return c.toDataURL('image/png');});
});
afterEach(async info=>{try{if(info.error)await page.screenshot({path:qa+'/failure.png'});assert.deepEqual(errors,[]);}finally{await context.close();}});
async function load(){await page.locator('#imageInput').setInputFiles({name:'Blender blockout.png',mimeType:'image/png',buffer:Buffer.from(source.split(',')[1],'base64')});await page.waitForFunction(()=>document.querySelectorAll('.layer-row').length===1&&!document.body.classList.contains('busy'));}
async function save(){const pending=page.waitForEvent('download');await page.locator('#saveProject').click();const stream=await(await pending).createReadStream(),chunks=[];for await(const chunk of stream)chunks.push(chunk);return JSON.parse(Buffer.concat(chunks).toString());}

test('review control requires an explicit original and keeps its settings across save/reload and queued edits',async()=>{
  await load();assert.equal(await page.locator('#blockoutReview').innerText(),'Blockout review · Off');await page.locator('#blockoutReview').click();
  const dialog=page.locator('#blockoutReviewDialog');assert.equal(await dialog.locator('[name=source]').inputValue(),'');
  await dialog.getByRole('button',{name:'Save review settings'}).click();assert.equal(await dialog.isVisible(),true);
  const sourceId=await dialog.locator('[name=source] option').nth(1).getAttribute('value');await dialog.locator('[name=source]').selectOption(sourceId);await dialog.locator('[name=exceptions]').fill('Remove only the small cube.');
  assert.match(await dialog.locator('.blockout-review-source-info').innerText(),/1536 × 864/);
  await page.screenshot({path:qa+'/review-settings.png'});await dialog.getByRole('button',{name:'Save review settings'}).click();assert.match(await page.locator('#blockoutReview').innerText(),/Astra Max/);
  await page.locator('#prompt').fill('Photoreal concrete buildings. Preserve the blockout camera.');await page.locator('#prompt').dispatchEvent('change');
  const project=await save();assert.equal(project.blockoutReview.assetId,sourceId);assert.equal(project.blockoutReview.maxAttempts,3);assert.equal(project.blockoutReview.authorizedChanges,'Remove only the small cube.');
  await page.locator('#generate').click();await page.waitForFunction(()=>!document.querySelector('#generate').disabled);
  assert.equal(requests.length,1);const prepared=prepareImageRequest(requests[0]);assert.equal(prepared.review.source.sha256,prepared.images[prepared.review.sourceIndex-1].sha256);assert.equal(prepared.size,'1536x864');
  await page.locator('#prompt').fill('A later instruction');assert.match(prepared.prompt,/Photoreal concrete/);assert.doesNotMatch(prepared.prompt,/A later instruction/);
  await page.reload();await page.waitForFunction(()=>document.documentElement.dataset.ready==='true');if(await page.locator('#skipStartup').isVisible())await page.locator('#skipStartup').click();assert.match(await page.locator('#blockoutReview').innerText(),/Astra Max/);
  await writeFile(qa+'/verification.json',JSON.stringify({paidCalls:0,request:{model:prepared.model,quality:prepared.quality,size:prepared.size,reviewer:prepared.review.model,effort:prepared.review.effort,maxAttempts:prepared.review.maxAttempts},explicitSource:true,restored:true},null,2));
});

test('turning review off preserves source, references and ordinary generation defaults',async()=>{
  await load();await page.locator('#blockoutReview').click();const dialog=page.locator('#blockoutReviewDialog');await dialog.locator('[name=enabled]').uncheck();await dialog.getByRole('button',{name:'Save review settings'}).click();
  await page.locator('#prompt').fill('A realistic scene');await page.locator('#prompt').dispatchEvent('change');const saved=await save();assert.equal(saved.blockoutReview.enabled,false);assert.equal(saved.assets[saved.original.assetId].source,source);
  await page.locator('#generate').click();await page.waitForFunction(()=>!document.querySelector('#generate').disabled);
  const prepared=prepareImageRequest(requests[0]);assert.equal(prepared.review,undefined);assert.equal(prepared.quality,'high');assert.equal(prepared.size,'1536x1024');
});
