import {test,before,after,beforeEach,afterEach} from 'node:test';
import assert from 'node:assert/strict';
import {mkdir} from 'node:fs/promises';
import path from 'node:path';
import {chromium} from 'playwright';
import {createServer} from '../server.mjs';

const qa=path.resolve('qa/output-inspection-surfaces'),id='11111111-1111-4111-8111-111111111111';
let server,browser,context,page,base,errors,posts;
before(async()=>{await mkdir(qa,{recursive:true});server=createServer({detection:{status:async()=>({available:false}),dispose(){}},sheets:{dispose(){}},images:{dispose(){}}});await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));base=`http://127.0.0.1:${server.address().port}`;browser=await chromium.launch({headless:true});});
after(async()=>{await browser?.close();if(server)await new Promise(resolve=>server.close(resolve));});
beforeEach(async()=>{errors=[];posts=[];context=await browser.newContext({viewport:{width:1280,height:900}});page=await context.newPage();page.on('pageerror',error=>errors.push(error.message));await context.route('**/*',route=>{const request=route.request();if(request.method()==='POST'){posts.push(request.url());return route.abort();}if(new URL(request.url()).origin!==base)return route.abort();return route.continue();});});
afterEach(async()=>{assert.deepEqual(errors,[]);assert.deepEqual(posts,[],'Inspection never starts a generation.');await context.close();});

test('sheet inspection uses original pixels, preserves its parent on Escape and saves the captured result',async()=>{
  await context.route(base+'/qa-inspection',route=>route.fulfill({contentType:'text/html',body:'<!doctype html><html><head><link rel="stylesheet" href="/sheet-creator.css"></head><body><main>Existing editor</main></body></html>'}));await page.goto(base+'/qa-inspection');
  await page.evaluate(async id=>{
    const {mountSheetCreator}=await import('/sheet-creator.mjs'),{newProject,addRaster}=await import('/core.mjs');
    const makeImage=(color,name)=>{const canvas=document.createElement('canvas');canvas.width=2000;canvas.height=1000;const ctx=canvas.getContext('2d');ctx.fillStyle=color;ctx.fillRect(0,0,2000,1000);return{source:canvas.toDataURL('image/png'),width:2000,height:1000,name};};
    const image=makeImage('#66999a','First generated sheet.png');let current=addRaster(newProject(2000,1000,'Original setup'),{...image,mimeType:'image/png'},{fitDocument:true}).project;
    const result={id,status:'completed',sourceProjectAvailable:true,image,sourceName:'Original setup'},state={result,direct:true,models:[]},downloads=[],listeners=[];
    window.__test={read:()=>current,downloads,update(){state.result={...result,id:'22222222-2222-4222-8222-222222222222',image:makeImage('#aa6633','Second generated sheet.png')};listeners.forEach(fn=>fn());}};
    window.__surface=mountSheetCreator({editor:{peek:()=>current,apply(project){current=project;},subscribe(){return()=>{};}},bridge:{state:()=>state,subscribe(fn){listeners.push(fn);return()=>{};}},download:async(blob,name)=>downloads.push({name,type:blob.type,size:blob.size})});window.__surface.open();
  },id);
  const before=await page.evaluate(()=>JSON.stringify(window.__test.read()));
  await page.locator('[data-sheet-action="result-inspect"]').scrollIntoViewIfNeeded();await page.screenshot({path:path.join(qa,'sheet-enlarge-button.png')});
  await page.locator('[data-sheet-result-image]').click();await page.locator('[data-output-inspector][data-ready="true"]').waitFor();
  assert.deepEqual(await page.locator('[data-inspector-image]').evaluate(image=>[image.naturalWidth,image.naturalHeight]),[2000,1000]);
  await page.keyboard.press('Escape');assert.equal(await page.locator('[data-output-inspector]').count(),0);assert.equal(await page.locator('#asunSheetCreator').isVisible(),true);
  await page.locator('[data-sheet-action="result-inspect"]').click();await page.locator('[data-output-inspector][data-ready="true"]').waitFor();await page.evaluate(()=>window.__test.update());
  await page.locator('[data-inspector-save]').click();await page.waitForFunction(()=>window.__test.downloads.length===1);assert.equal(await page.evaluate(()=>window.__test.downloads[0].name),'First generated sheet.png');
  await page.screenshot({path:path.join(qa,'sheet-full-resolution-inspection.png')});
  await page.locator('[data-inspector-back]').click();assert.equal(await page.locator('#asunSheetCreator').isVisible(),true);assert.equal(await page.evaluate(()=>JSON.stringify(window.__test.read())),before);
  await page.locator('[data-sheet-action="result-inspect"]').click();await page.locator('[data-output-inspector][data-ready="true"]').waitFor();await page.evaluate(()=>window.__surface.close());assert.equal(await page.locator('[data-output-inspector]').count(),0);
});

test('history inspection loads full output bytes rather than list thumbnail and closes safely with its parent',async()=>{
  const png=await page.evaluate(()=>{const canvas=document.createElement('canvas');canvas.width=2048;canvas.height=1024;const ctx=canvas.getContext('2d');ctx.fillStyle='#47898b';ctx.fillRect(0,0,2048,1024);return canvas.toDataURL('image/png');});
  const record={id,status:'completed',mode:'image',sourceName:'Original high-resolution scene',sourceProjectAvailable:true,outputAvailable:true,output:{name:'Exact history output.png',width:2048,height:1024},settings:{model:'gpt-image-2.5-sunburst',quality:'max',size:'2048x1024',prompt:'Original saved prompt',inputs:[]}};
  await context.route(base+'/api/**',route=>{const url=new URL(route.request().url()),match=/^\/api\/(images|sheets)\/(.*)$/.exec(url.pathname);if(!match)return route.continue();const kind=match[1],action=match[2],json=value=>route.fulfill({contentType:'application/json',body:JSON.stringify(value)});
    if(action==='status')return json({token:'qa-token'});if(action==='history')return json({items:kind==='images'?[record]:[]});if(action===`jobs/${id}`)return json(record);if(action===`jobs/${id}/output`)return route.fulfill({contentType:'image/png',body:Buffer.from(png.split(',')[1],'base64')});return json({error:'Unexpected request'});});
  await page.goto(base+'/generation-history.html');await page.locator(`.generation-history-card[data-job-id="${id}"]`).click();await page.waitForFunction(()=>!document.querySelector('#generationHistoryInspect').disabled);
  await page.screenshot({path:path.join(qa,'history-enlarge-button.png')});
  const fullSource=await page.locator('#generationHistoryOutput').getAttribute('src');assert.match(fullSource,/^blob:/);
  await page.locator('#generationHistoryOutput').click();await page.locator('[data-output-inspector][data-ready="true"]').waitFor();assert.equal(await page.locator('[data-inspector-image]').getAttribute('src'),fullSource);assert.deepEqual(await page.locator('[data-inspector-image]').evaluate(image=>[image.naturalWidth,image.naturalHeight]),[2048,1024]);
  const downloadPromise=page.waitForEvent('download');await page.locator('[data-inspector-save]').click();assert.equal((await downloadPromise).suggestedFilename(),'Exact history output.png');
  await page.screenshot({path:path.join(qa,'history-full-resolution-inspection.png')});
  await page.keyboard.press('Escape');assert.equal(await page.locator('[data-output-inspector]').count(),0);assert.equal(await page.locator('#generationHistoryDetail').evaluate(dialog=>dialog.open),true);
  await page.locator('#generationHistoryInspect').click();await page.locator('[data-output-inspector][data-ready="true"]').waitFor();await page.evaluate(()=>document.querySelector('#generationHistoryDetail').close());await page.waitForFunction(()=>!document.querySelector('[data-output-inspector]'));assert.equal(await page.locator('#generationHistoryOutput').getAttribute('src'),null);
});
