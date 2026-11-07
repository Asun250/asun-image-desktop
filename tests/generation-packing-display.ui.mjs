import {test,before,after} from 'node:test';
import assert from 'node:assert/strict';
import {chromium} from 'playwright';
import {createServer} from '../server.mjs';
import {generationInputPackingDisplay} from '../public/generation-details.mjs';

let server,browser,base;
before(async()=>{
  server=createServer({images:{dispose(){}},sheets:{dispose(){}},detection:{dispose(){}}});
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));base=`http://127.0.0.1:${server.address().port}`;
  browser=await chromium.launch({headless:true});
});
after(async()=>{await browser?.close();if(server)await new Promise(resolve=>server.close(resolve));});

test('packing summary reports recorded grouping and never invents it for ordinary or malformed settings',()=>{
  assert.equal(generationInputPackingDisplay(),null);
  for(const value of [{version:1,logicalInputCount:16,physicalInputCount:16,boardCount:0},{version:1,logicalInputCount:20,physicalInputCount:17,boardCount:2},{version:1,logicalInputCount:20,physicalInputCount:16,boardCount:NaN}])assert.equal(generationInputPackingDisplay(value),null);
  const display=generationInputPackingDisplay({version:1,logicalInputCount:20,physicalInputCount:16,boardCount:4});
  assert.equal(display.summary,'All 20 inputs included in 16 images using 4 labeled reference boards.');
  assert.match(display.detail,/may appear smaller/);assert.match(display.detail,/original reference photos remain/);
});

test('generation details show packed input counts, board contents and exact settings, with ordinary legacy display unchanged',async t=>{
  const context=await browser.newContext({viewport:{width:700,height:900}});t.after(()=>context.close());
  const page=await context.newPage(),errors=[],requests=[];page.on('pageerror',error=>errors.push(error.message));
  await context.route('**/*',async route=>{
    const request=route.request(),url=new URL(request.url());requests.push({url:request.url(),method:request.method()});
    if(url.origin!==base||request.method()!=='GET'){errors.push('Unexpected request');return route.abort();}
    if(url.pathname==='/packing-display')return route.fulfill({contentType:'text/html',body:'<!doctype html><html><head><link rel="stylesheet" href="generation-details.css"></head><body><main id="details"></main></body></html>'});
    return route.continue();
  });
  await page.goto(base+'/packing-display');
  const record={id:'11111111-1111-4111-8111-111111111111',mode:'image',status:'completed',sourceProjectAvailable:true,availableInputs:[],settings:{model:'gpt-image-2.5-sunburst',quality:'max',size:'1536x1024',prompt:'Keep the Blender blockout camera.',inputPacking:{version:1,logicalInputCount:20,physicalInputCount:16,boardCount:4},inputs:[{index:1,name:'Reference board 1.png',role:'labeled reference board',width:2048,height:1024,roles:[{image:1,role:'labeled reference board',tiles:[{sourceInput:3,label:'Input 3',roles:[{role:'original reference photo',filename:'Gold material.png'}]},{sourceInput:4,label:'Input 4',roles:[{role:'area selection mask',label:'Bird 2'}]}]}]}]}};
  await page.evaluate(async record=>{const {renderGenerationDetails}=await import('./generation-details.mjs');await renderGenerationDetails(document.getElementById('details'),record).ready;},record);
  assert.match(await page.locator('[data-input-packing]').textContent(),/All 20 inputs included in 16 images using 4 labeled reference boards/);
  assert.match(await page.locator('[data-input-packing]').textContent(),/may appear smaller/);
  await page.locator('[data-board-contents]>summary').click();
  assert.match(await page.locator('[data-board-contents]').textContent(),/Input 3 — Gold material.png/);
  assert.match(await page.locator('[data-board-contents]').textContent(),/Input 4 — area selection mask/);
  assert.equal(await page.locator('.generation-detail-prompt').inputValue(),record.settings.prompt);
  const rows=await page.locator('.generation-detail-metadata').textContent();assert.match(rows,/gpt-image-2.5-sunburst/);assert.match(rows,/Quality requestedmax/);
  await page.setViewportSize({width:390,height:844});assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1));
  await page.evaluate(async()=>{const {renderGenerationDetails}=await import('./generation-details.mjs');await renderGenerationDetails(document.getElementById('details'),{status:'completed'}).ready;});
  assert.equal(await page.locator('[data-input-packing]').count(),0);assert.equal(await page.locator('[data-board-contents]').count(),0);assert.match(await page.locator('.generation-detail-legacy').textContent(),/older result/);
  assert.deepEqual(errors,[]);assert.ok(requests.every(request=>request.method==='GET'));
});
