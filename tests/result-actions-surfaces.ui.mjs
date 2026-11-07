import {test,before,after,beforeEach,afterEach} from 'node:test';
import assert from 'node:assert/strict';
import {mkdir} from 'node:fs/promises';
import path from 'node:path';
import {chromium} from 'playwright';
import {createServer} from '../server.mjs';

const qa=path.resolve('qa/result-actions-surfaces'),id='11111111-1111-4111-8111-111111111111',legacyId='22222222-2222-4222-8222-222222222222';
let server,browser,context,page,base,errors,posts;
before(async()=>{await mkdir(qa,{recursive:true});server=createServer({detection:{status:async()=>({available:false}),dispose(){}},sheets:{dispose(){}},images:{dispose(){}}});await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));base=`http://127.0.0.1:${server.address().port}`;browser=await chromium.launch({headless:true});});
after(async()=>{await browser?.close();if(server)await new Promise(resolve=>server.close(resolve));});
beforeEach(async()=>{errors=[];posts=[];context=await browser.newContext({viewport:{width:1280,height:900}});page=await context.newPage();page.on('pageerror',error=>errors.push(error.message));await context.route('**/*',route=>{const request=route.request();if(request.method()==='POST'){posts.push(request.url());return route.abort();}if(new URL(request.url()).origin!==base)return route.abort();return route.continue();});});
afterEach(async()=>{assert.deepEqual(errors,[]);assert.deepEqual(posts,[],'Result actions must not generate an image.');await context.close();});
async function sheet({available=true,fail=false}={}){
  await context.route(base+'/qa-surface',route=>route.fulfill({contentType:'text/html',body:'<!doctype html><html><head><link rel="stylesheet" href="/sheet-creator.css"></head><body><main id="main">Existing editor</main></body></html>'}));await page.goto(base+'/qa-surface');
  await page.evaluate(async({id,available,fail})=>{
    const {mountSheetCreator}=await import('/sheet-creator.mjs'),{newProject,addRaster}=await import('/core.mjs');
    const canvas=document.createElement('canvas');canvas.width=160;canvas.height=120;const ctx=canvas.getContext('2d');ctx.fillStyle='#66999a';ctx.fillRect(0,0,160,120);const image={source:canvas.toDataURL('image/png'),width:160,height:120,name:'Generated sheet.png'};
    let current=addRaster(newProject(160,120,'Original setup'),{...image,mimeType:'image/png'},{fitDocument:true}).project;
    current.prompt='Original requested changes';const events=[],listeners=[];
    const result={id,status:'completed',sourceProjectAvailable:available,image,sourceName:'Original setup',settings:{model:'gpt-image-2.5-sunburst',quality:'max',size:'1024x1024',inputs:[],prompt:'Saved generation prompt'}};
    const bridge={state:()=>({result,direct:true,model:'gpt-image-2.5-sunburst',models:[],quality:'max'}),editOutput:async record=>{events.push({action:'edit',id:record.id,closed:document.querySelector('#asunSheetCreator').hidden});if(fail)throw new Error('Saved output unavailable. Your project has not changed.');},restoreSource:async(record,{beforeApply}={})=>{events.push({action:'redo-loading',open:!document.querySelector('#asunSheetCreator').hidden});await new Promise(resolve=>setTimeout(resolve,80));if(fail)throw new Error('Saved setup unavailable. Your project has not changed.');beforeApply?.();events.push({action:'redo-applied',id:record.id,closed:document.querySelector('#asunSheetCreator').hidden});},useSettings:record=>events.push({action:'settings',id:record.id})};
    window.__test={events,read:()=>current,result};window.__surface=mountSheetCreator({editor:{peek:()=>current,apply(project){current=project;listeners.forEach(fn=>fn());},subscribe(fn){listeners.push(fn);return()=>{};}},bridge,onStatus:(message,error)=>events.push({action:'status',message,error})});window.__surface.open();
  },{id,available,fail});await page.locator('[data-sheet-result-image]').waitFor({state:'visible'});
}
test('sheet result edit closes its surface before entering the output editor and preserves source settings',async()=>{
  await sheet();const before=await page.evaluate(()=>JSON.stringify(window.__test.read()));
  for(const width of [1280,1024]){await page.setViewportSize({width,height:900});await page.locator('[data-sheet-result-edit-actions]').scrollIntoViewIfNeeded();const bounds=await page.locator('[data-sheet-result-edit-actions]').evaluate(element=>({width:element.clientWidth,scroll:element.scrollWidth,buttons:[...element.querySelectorAll('button')].map(button=>({width:button.clientWidth,scroll:button.scrollWidth}))}));assert.ok(bounds.scroll<=bounds.width+1);assert.ok(bounds.buttons.every(button=>button.scroll<=button.width+1));}
  await page.screenshot({path:path.join(qa,'sheet-result-actions.png')});
  await page.locator('[data-sheet-action="result-edit"]').click();await page.locator('#asunSheetCreator').waitFor({state:'hidden'});
  assert.deepEqual(await page.evaluate(()=>window.__test.events.find(entry=>entry.action==='edit')),{action:'edit',id,closed:true});
  assert.equal(await page.evaluate(()=>JSON.stringify(window.__test.read())),before,'Closing for edit must not mutate the original source preset.');
  await page.evaluate(()=>window.__surface.useGenerationSettings(window.__test.result));assert.equal(await page.evaluate(()=>window.__test.events.at(-1).action),'settings');
});
test('sheet redo keeps its surface open during fetch and closes immediately before applying the saved setup',async()=>{
  await sheet();await page.locator('[data-sheet-action="result-redo"]').click();await page.locator('#asunSheetCreator').waitFor({state:'hidden'});
  const events=await page.evaluate(()=>window.__test.events);assert.ok(events.some(entry=>entry.action==='redo-loading'&&entry.open));assert.ok(events.some(entry=>entry.action==='redo-applied'&&entry.closed));
});
test('sheet older results disable redo, and restoration failure preserves visible setup and reports error',async()=>{
  await sheet({available:false});assert.equal(await page.locator('[data-sheet-action="result-redo"]').isDisabled(),true);assert.match(await page.locator('[data-sheet-result-restore-help]').innerText(),/older result.*no saved editable setup/i);assert.equal(await page.locator('[data-sheet-action="result-edit"]').isEnabled(),true);
  await page.evaluate(()=>window.__surface.dispose());await sheet({fail:true});const before=await page.evaluate(()=>JSON.stringify(window.__test.read()));await page.locator('[data-sheet-action="result-redo"]').click();await page.waitForFunction(()=>document.querySelector('[data-sheet-status]').classList.contains('is-error'));
  assert.equal(await page.locator('#asunSheetCreator').isVisible(),true);assert.equal(await page.evaluate(()=>JSON.stringify(window.__test.read())),before);assert.match(await page.locator('[data-sheet-status]').innerText(),/setup unavailable/i);
});
test('history continuation links isolate existing work, bind the exact job and explain legacy results',async()=>{
  const png=await page.evaluate(()=>{const canvas=document.createElement('canvas');canvas.width=160;canvas.height=120;const ctx=canvas.getContext('2d');ctx.fillStyle='#47898b';ctx.fillRect(0,0,160,120);return canvas.toDataURL('image/png');});
  const record=(job,kind)=>({id:job,status:'completed',mode:kind,sourceName:job===id?'Saved source setup':'Older sheet',sourceProjectAvailable:job===id,outputAvailable:true,output:{name:'Output.png',width:160,height:120},image:{source:png,name:'Output.png',width:160,height:120},settings:{model:'gpt-image-2.5-sunburst',quality:'max',size:'1024x1024',prompt:'Original saved prompt',inputs:[]}});
  await context.route(base+'/api/**',route=>{const url=new URL(route.request().url()),match=/^\/api\/(images|sheets)\/(.*)$/.exec(url.pathname);if(!match)return route.continue();const kind=match[1]==='sheets'?'sheet':'image',action=match[2],job=kind==='sheet'?legacyId:id;const json=value=>route.fulfill({contentType:'application/json',body:JSON.stringify(value)});
    if(action==='status')return json({token:'qa-token'});if(action==='history')return json({items:[record(job,kind)]});if(action===`jobs/${job}`)return json(record(job,kind));if(action===`jobs/${job}/output`)return route.fulfill({contentType:'image/png',body:Buffer.from(png.split(',')[1],'base64')});return json({error:'Unexpected request'});});
  await page.goto(base+'/generation-history.html');await page.locator(`.generation-history-card[data-job-id="${id}"]`).click();await page.waitForFunction(()=>document.querySelector('#generationHistoryRedo').hasAttribute('href'));
  for(const [selector,action]of[['#generationHistoryEditOutput','edit'],['#generationHistoryRedo','redo']]){const link=page.locator(selector),url=new URL(await link.getAttribute('href'));assert.equal(url.searchParams.get('generation'),id);assert.equal(url.searchParams.get('kind'),'image');assert.equal(url.searchParams.get('action'),action);assert.equal(await link.getAttribute('target'),'_blank');assert.equal(await link.getAttribute('rel'),'noopener');}
  await page.locator('.history-result-edit-actions').scrollIntoViewIfNeeded();await page.screenshot({path:path.join(qa,'history-result-actions.png')});await page.locator('#generationHistoryClose').click();await page.waitForFunction(()=>!document.querySelector('#generationHistoryRedo').hasAttribute('href'));
  await page.locator(`.generation-history-card[data-job-id="${legacyId}"]`).click();await page.waitForFunction(()=>document.querySelector('#generationHistoryEditOutput').hasAttribute('href'));
  assert.equal(new URL(await page.locator('#generationHistoryEditOutput').getAttribute('href')).searchParams.get('kind'),'sheet');assert.equal(await page.locator('#generationHistoryRedo').getAttribute('aria-disabled'),'true');assert.equal(await page.locator('#generationHistoryRedo').getAttribute('href'),null);assert.match(await page.locator('#generationHistoryRestoreHelp').innerText(),/older result.*no saved editable setup/i);
  await page.screenshot({path:path.join(qa,'history-legacy-result-actions.png')});
});
