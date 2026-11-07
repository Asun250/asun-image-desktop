import {test,before,after,beforeEach,afterEach} from 'node:test';
import assert from 'node:assert/strict';
import {mkdir,writeFile} from 'node:fs/promises';
import path from 'node:path';
import {chromium} from 'playwright';
import {createServer} from '../server.mjs';
import {newProject,addRaster,addText,addReference,linkReferences,serializeProject} from '../public/core.mjs';

const qa=path.resolve('qa','output-inspection'),model='gpt-image-2.5-sunburst';
const report={suite:'Full-resolution generated output inspection',paidCalls:0,cases:[]};
let server,browser,context,page,base,errors,requests,records,output,nextOutput,holdCompletion;
before(async()=>{await mkdir(qa,{recursive:true});server=createServer({detection:{status:async()=>({available:false}),dispose(){}},sheets:{dispose(){}},images:{dispose(){}}});await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));base=`http://127.0.0.1:${server.address().port}`;browser=await chromium.launch({headless:true});});
after(async()=>{await writeFile(path.join(qa,'report.json'),JSON.stringify(report,null,2));await browser?.close();if(server)await new Promise(resolve=>server.close(resolve));});
beforeEach(async()=>{
  errors=[];requests=[];records=new Map();holdCompletion=false;
  context=await browser.newContext({viewport:{width:1440,height:1000},acceptDownloads:true});
  await context.addInitScript(()=>localStorage.setItem('asun-image-appearance','dark'));
  page=await context.newPage();page.on('pageerror',error=>errors.push(error.message));
  output=await fixture('#46a9bc',1024,1536,'Generated preview A');nextOutput=await fixture('#ec9855',1024,1536,'Generated preview B');
  await context.route('**/*',async route=>{
    const request=route.request(),url=new URL(request.url());
    if(url.origin!==base){errors.push('External request blocked: '+url.origin);return route.abort();}
    const json=(data,status=200)=>route.fulfill({status,contentType:'application/json',body:JSON.stringify(data)});
    if(url.pathname==='/api/generation-queue/status')return json({items:[...records.values()].map(record=>{const {image,...summary}=record;return holdCompletion&&record.id===requests.at(-1)?.requestId?{...summary,status:'running',outputAvailable:false}:summary;})});
    if(url.pathname.startsWith('/api/sheets/'))return json({configured:false,authenticated:false,models:[],token:'qa-sheet',message:'Sheet provider not used by this test.'});
    if(url.pathname==='/api/images/status')return json({configured:true,authenticated:true,models:[{id:model,label:'GPT Image 2.5 · Sunburst',available:true}],token:'qa-inspection',message:'Simulated provider.'});
    if(url.pathname==='/api/images/generate'){
      assert.equal(request.method(),'POST');assert.equal(request.headers()['x-asun-image-token'],'qa-inspection');
      const body=request.postDataJSON();requests.push(body);
      const record={id:body.requestId,status:'completed',mode:'image',model:body.model,sourceName:body.project.name,sourceProjectAvailable:true,image:{name:`Generated preview ${requests.length}.png`,source:requests.length===1?output:nextOutput,width:1024,height:1536},settings:{model:body.model,quality:body.quality,size:'1024x1536',prompt:body.project.prompt,inputs:[]},availableInputs:[],outputAvailable:true};records.set(record.id,record);return json({id:record.id,status:'running'},202);
    }
    const match=/^\/api\/images\/jobs\/([^/]+)$/.exec(url.pathname);
    if(match){assert.equal(request.headers()['x-asun-image-token'],'qa-inspection');const record=records.get(match[1]);return json(holdCompletion&&match[1]===requests.at(-1)?.requestId?{id:match[1],status:'running'}:record);}
    if(url.pathname==='/api/local-detection/status')return json({available:false,message:'Manual selection remains available.'});
    if(request.method()==='POST'&&url.pathname.startsWith('/api/')){errors.push('Unexpected API POST: '+url.pathname);return json({error:'Not allowed in UI verification.'},500);}
    return route.continue();
  });
  await page.goto(base);await page.waitForFunction(()=>document.documentElement.dataset.ready==='true');
  if(await page.locator('#skipStartup').isVisible())await page.locator('#skipStartup').click();
  await page.waitForFunction(()=>document.querySelector('#model')?.value==='gpt-image-2.5-sunburst');
});
afterEach(async info=>{try{if(info.error)await page.screenshot({path:path.join(qa,'failure-'+info.name.replace(/\W+/g,'-')+'.png')});assert.deepEqual(errors,[]);report.cases.push({name:info.name,status:info.error?'failed':'passed',error:info.error?.message,generationRequests:requests.length});}finally{await context?.close();}});
async function fixture(color,width=480,height=320,label='Editable original'){
  return page.evaluate(({color,width,height,label})=>{const c=document.createElement('canvas');c.width=width;c.height=height;const x=c.getContext('2d');const g=x.createLinearGradient(0,0,width,height);g.addColorStop(0,'#112133');g.addColorStop(1,color);x.fillStyle=g;x.fillRect(0,0,width,height);x.strokeStyle='#ffffff40';x.lineWidth=1;for(let i=0;i<width;i+=32){x.beginPath();x.moveTo(i,0);x.lineTo(i,height);x.stroke();}for(let i=0;i<height;i+=32){x.beginPath();x.moveTo(0,i);x.lineTo(width,i);x.stroke();}x.fillStyle='#f0c284';x.fillRect(width*.2,height*.3,width*.6,height*.35);x.fillStyle='#173448';for(let row=0;row<7;row++)for(let col=0;col<10;col++)x.fillRect(width*(.22+.056*col),height*(.32+.045*row),width*.032,height*.028);x.fillStyle='#fff';x.font=`${Math.max(12,Math.round(width*.027))}px Arial`;x.fillText(label,width*.06,height*.13);x.font=`${Math.max(10,Math.round(width*.018))}px Arial`;x.fillText(`${width} × ${height} original pixels · UI test fixture`,width*.06,height*.86);return c.toDataURL();},{color,width,height,label});
}
async function setup(){
  const source=await fixture('#93765b'),reference=await fixture('#5f9e64',240,180,'Reference');
  let project=addRaster(newProject(480,320,'Inspection preserves your working edit'),{name:'Original.png',source,width:480,height:320}).project;
  project=addReference(project,{name:'Reference.png',source:reference,width:240,height:180});const label=addText(project,{content:'1',x:90,y:70,width:30,height:30,fontSize:22});project=linkReferences(label.project,label.layerId,project.references.map(ref=>ref.id));project.prompt='Apply the reference and preserve the composition.';project.imageOutput={version:1,aspect:'2:3'};
  await page.locator('#projectInput').setInputFiles({name:'Inspection QA.asun',mimeType:'application/json',buffer:Buffer.from(serializeProject(project))});await page.waitForFunction(()=>!document.body.classList.contains('busy')&&document.querySelectorAll('.layer-row').length===2);return project;
}
async function generate(){await page.waitForFunction(()=>!document.querySelector('#generate').disabled);await page.locator('#generate').click();await page.locator('#imageGenerationResult').waitFor({state:'visible'});assert.equal(await page.locator('#desktopImageResultDialog').isVisible(),false);await page.locator('#imageGenerationResult').click();await page.waitForFunction(()=>document.querySelector('#desktopImageResultDialog').open);return requests.at(-1);}
async function switchWorkflow(id){await page.locator(`[data-workflow-tab="${id}"]`).click();await page.waitForFunction(id=>document.querySelector(`[data-workflow-tab="${id}"]`)?.getAttribute('aria-selected')==='true',id);}
async function openInspector(){await page.locator('[data-image-result-inspect]').click();await page.waitForFunction(()=>document.querySelector('[data-output-inspector]')?.dataset.ready==='true');}
async function closeResult(){await page.locator('[data-image-result-close]').first().click();await page.locator('#desktopImageResultDialog').waitFor({state:'hidden'});}
async function savedProject(){const pending=page.waitForEvent('download');await page.locator('#saveProject').click();const file=await pending,stream=await file.createReadStream(),chunks=[];for await(const chunk of stream)chunks.push(chunk);await page.waitForTimeout(725);return JSON.parse(Buffer.concat(chunks).toString());}
async function imageState(){return page.locator('[data-inspector-image]').evaluate(e=>{const r=e.getBoundingClientRect();return {width:e.naturalWidth,height:e.naturalHeight,x:r.x,y:r.y,renderedWidth:r.width,renderedHeight:r.height,source:e.currentSrc,transform:e.style.transform};});}
async function scale(){return Number(await page.locator('[data-output-inspector]').getAttribute('data-scale'));}
async function reachable(selector){const b=await page.locator(selector).evaluate(e=>{const r=e.getBoundingClientRect(),hit=document.elementFromPoint(r.x+r.width/2,r.y+r.height/2);return {ok:hit===e||e.contains(hit),x:r.x,y:r.y,right:r.right,bottom:r.bottom,w:innerWidth,h:innerHeight};});assert.ok(b.ok&&b.x>=0&&b.y>=0&&b.right<=b.w+1&&b.bottom<=b.h+1,selector+' reachable '+JSON.stringify(b));}

test('Enlarge uses original pixels and provides actual-size, wheel zoom, drag pan and fit',{timeout:60000},async()=>{
  await setup();await generate();await openInspector();const initial=await imageState(),fit=await scale();assert.deepEqual([initial.width,initial.height],[1024,1536]);assert.equal(initial.source,output);assert.ok(fit>0&&fit<1);
  assert.match((await page.locator('[data-inspector-dimensions]').innerText()).replace(/,/g,''),/1024.*1536/);
  await page.locator('[data-inspector-actual]').click();assert.equal(await scale(),1);let state=await imageState();assert.equal(state.renderedWidth,1024);assert.equal(state.renderedHeight,1536);
  await page.locator('[data-inspector-zoom-in]').click();assert.ok(await scale()>1);await page.locator('[data-inspector-zoom-out]').click();assert.equal(await scale(),1);
  const stage=await page.locator('[data-inspector-stage]').boundingBox(),x=stage.x+stage.width*.5,y=stage.y+stage.height*.5;await page.mouse.move(x,y);await page.mouse.wheel(0,-200);await page.waitForTimeout(100);assert.ok(await scale()>1,'Wheel enlarges the original image.');
  state=await imageState();await page.mouse.move(x,y);await page.mouse.down();await page.mouse.move(x+70,y+55,{steps:5});await page.mouse.up();const panned=await imageState();assert.ok(Math.abs(panned.x-state.x)>30&&Math.abs(panned.y-state.y)>20,'Dragging pans enlarged pixels.');
  await page.locator('[data-inspector-fit]').click();assert.ok(Math.abs(await scale()-fit)<.0001);const fitted=await imageState();assert.ok(fitted.renderedHeight<=stage.height+1&&fitted.renderedWidth<=stage.width+1);assert.equal(requests.length,1);
});

test('Back and Escape return to the same ready result without altering editor data',{timeout:60000},async()=>{
  const project=await setup();await generate();
  for(const action of ['back','escape','back']){await openInspector();await page.locator('[data-inspector-actual]').click();if(action==='back')await page.locator('[data-inspector-back]').click();else await page.keyboard.press('Escape');await page.locator('[data-output-inspector]').waitFor({state:'detached'});assert.equal(await page.locator('#desktopImageResultDialog').isVisible(),true);assert.equal(await page.locator('[data-image-result]').getAttribute('src'),output);assert.equal(await page.locator('[data-image-result-inspect]').evaluate(e=>document.activeElement===e),true);}
  await closeResult();assert.deepEqual(await savedProject(),project);assert.equal(requests.length,1);
});

test('Save preserves original bytes and the inspected result stays bound while a newer job completes',{timeout:60000},async()=>{
  await setup();await generate();const firstTab=await page.locator('[data-workflow-tab][aria-selected="true"]').getAttribute('data-workflow-tab');await closeResult();await page.locator('#prompt').fill('A second image with different details.');await page.locator('#prompt').dispatchEvent('change');holdCompletion=true;await page.locator('#generate').click();await page.waitForFunction(()=>document.querySelector('#generate').getAttribute('aria-busy')==='false');
  // Each queued generation now owns its workflow tab. Inspect the first job
  // through its own tab while the second job continues in the background.
  const secondTab=await page.locator('[data-workflow-tab][aria-selected="true"]').getAttribute('data-workflow-tab');assert.notEqual(secondTab,firstTab);await switchWorkflow(firstTab);await page.locator('#imageGenerationResult').waitFor({state:'visible'});await page.locator('#imageGenerationResult').click();await openInspector();holdCompletion=false;await page.waitForFunction(id=>document.querySelector(`[data-workflow-tab="${id}"]`)?.closest('.workflow-tab')?.dataset.status==='ready',secondTab);assert.equal(requests.length,2);assert.equal((await imageState()).source,output);
  const pending=page.waitForEvent('download');await page.locator('[data-inspector-save]').click();const file=await pending,stream=await file.createReadStream(),chunks=[];for await(const chunk of stream)chunks.push(chunk);assert.equal(file.suggestedFilename(),'Generated preview 1.png');assert.deepEqual(Buffer.concat(chunks),Buffer.from(output.split(',')[1],'base64'),'Inspection exports original pixels without re-rendering or downsampling.');assert.equal(await page.locator('[data-output-inspector]').isVisible(),true);
  await page.locator('[data-inspector-back]').click();await closeResult();await switchWorkflow(secondTab);await page.locator('#imageGenerationResult').waitFor({state:'visible'});await page.locator('#imageGenerationResult').click();await openInspector();assert.equal((await imageState()).source,nextOutput);assert.equal(requests.length,2);
});

test('unreadable outputs report failure and close cleanly without mutating the ready result',{timeout:60000},async()=>{
  await setup();await generate();await page.evaluate(async()=>{const {openGeneratedImageInspector}=await import('/generated-image-inspector.mjs');window.qaInspector=openGeneratedImageInspector({name:'Unreadable.png',source:'data:image/png;base64,broken',width:100,height:100},{returnFocus:document.querySelector('[data-image-result-inspect]')});});
  await page.waitForFunction(()=>/could|unable|failed|unavailable|load|read/i.test(document.querySelector('[data-inspector-status]')?.textContent||'')&&!/loading/i.test(document.querySelector('[data-inspector-status]')?.textContent||''));assert.equal(await page.locator('[data-inspector-actual]').isDisabled(),true);await page.keyboard.press('Escape');await page.locator('[data-output-inspector]').waitFor({state:'detached'});assert.equal(await page.locator('#desktopImageResultDialog').isVisible(),true);assert.equal(await page.locator('[data-image-result]').getAttribute('src'),output);await openInspector();assert.equal((await imageState()).source,output);assert.equal(requests.length,1);
});

test('inspection controls remain visible in light and dark compact desktop sizes',{timeout:60000},async()=>{
  await setup();await generate();
  for(const width of [1440,1024])for(const theme of ['dark','light']){await page.setViewportSize({width,height:768});await page.evaluate(theme=>document.documentElement.dataset.theme=theme,theme);await page.locator('[data-image-result-inspect]').scrollIntoViewIfNeeded();await page.screenshot({path:path.join(qa,`ready-preview-${theme}-${width}.png`)});await openInspector();for(const selector of ['[data-inspector-back]','[data-inspector-fit]','[data-inspector-actual]','[data-inspector-zoom-in]','[data-inspector-zoom-out]','[data-inspector-save]'])await reachable(selector);const overflow=await page.locator('[data-output-inspector]').evaluate(e=>({scroll:e.scrollWidth,width:e.clientWidth}));assert.ok(overflow.scroll<=overflow.width+1);await page.screenshot({path:path.join(qa,`inspection-${theme}-${width}.png`)});await page.locator('[data-inspector-back]').click();}
  assert.equal(requests.length,1);
});

test('pinch and keyboard zoom stay inside inspection and fit responds to window resizing',{timeout:60000},async()=>{
  await setup();await generate();await openInspector();await page.locator('[data-inspector-stage]').focus();await page.keyboard.press('1');assert.equal(await scale(),1);await page.keyboard.press('+');assert.equal(await scale(),1.25);await page.keyboard.press('-');assert.equal(await scale(),1);await page.keyboard.press('0');const before=await scale();
  const stage=await page.locator('[data-inspector-stage]').boundingBox(),x=stage.x+stage.width/2,y=stage.y+stage.height/2,cdp=await context.newCDPSession(page);
  await cdp.send('Input.dispatchTouchEvent',{type:'touchStart',touchPoints:[{x:x-50,y,id:1},{x:x+50,y,id:2}]});await cdp.send('Input.dispatchTouchEvent',{type:'touchMove',touchPoints:[{x:x-100,y,id:1},{x:x+100,y,id:2}]});await cdp.send('Input.dispatchTouchEvent',{type:'touchEnd',touchPoints:[]});await cdp.detach();assert.ok(await scale()>before*1.5,'Two-finger pinch enlarges the source pixels.');assert.equal(await page.locator('[data-inspector-stage]').getAttribute('data-dragging'),'false');
  await page.locator('[data-inspector-fit]').click();await page.setViewportSize({width:1024,height:640});await page.waitForTimeout(100);assert.ok(await scale()<before,'Fit recalculates when less screen height is available.');await page.keyboard.press('Escape');await page.locator('[data-output-inspector]').waitFor({state:'detached'});assert.equal(await page.locator('#desktopImageResultDialog').isVisible(),true);assert.equal(requests.length,1);
});
