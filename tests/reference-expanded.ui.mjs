import {test,before,after,beforeEach,afterEach} from 'node:test';
import assert from 'node:assert/strict';
import {readFile,mkdir,writeFile} from 'node:fs/promises';
import path from 'node:path';
import {chromium} from 'playwright';
import {createServer} from '../server.mjs';

const qa=path.resolve('qa','reference-expanded'),report={suite:'Expanded reference photo editor',cases:[]};
let server,browser,context,page,base,errors,original,labelId;
before(async()=>{await mkdir(qa,{recursive:true});server=createServer();await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));base=`http://127.0.0.1:${server.address().port}`;browser=await chromium.launch({headless:true});});
after(async()=>{await writeFile(path.join(qa,'report.json'),JSON.stringify(report,null,2));await browser?.close();if(server)await new Promise(resolve=>server.close(resolve));});
beforeEach(async()=>{
  errors=[];context=await browser.newContext({viewport:{width:1280,height:800},acceptDownloads:true});await context.addInitScript(()=>localStorage.setItem('asun-image-appearance','dark'));
  page=await context.newPage();page.on('pageerror',error=>errors.push(error.message));page.on('request',request=>{if(![base,'data:','blob:'].some(prefix=>request.url().startsWith(prefix)))errors.push('Remote request: '+request.url());});
  await page.route('**/api/local-detection/status',route=>route.fulfill({json:{available:false,message:'Reference editor QA; inference is not needed'}}));
  await page.goto(base);await page.waitForFunction(()=>document.documentElement.dataset.ready==='true');
  const sources=await Promise.all([1,2].map(referenceSource));
  original=await page.evaluate(async sources=>{const c=await import('/core.mjs');let p=c.addRaster(c.newProject(720,480,'Reference expansion QA'),{name:'Alpine scene.png',source:sources[0],width:720,height:480}).project;for(const [i,source]of sources.entries())p=c.addReference(p,{name:i?'Evening mountain.png':'Alpine reference.png',source,width:720,height:480});const a=c.addText(p,{content:'1',x:40,y:40,width:30,height:45,fontSize:24,color:'#ff0000'});p=c.linkReferences(a.project,a.layerId,p.references.map(r=>r.id));return JSON.parse(c.serializeProject(p));},sources);
  labelId=original.layers.find(layer=>layer.kind==='text').id;
  await page.locator('#projectInput').setInputFiles({name:'Reference expansion QA.asun',mimeType:'application/json',buffer:Buffer.from(JSON.stringify(original))});await idle();await page.waitForFunction(()=>document.querySelectorAll('.layer-row').length===2);
  await page.locator(`.layer-row[data-id="${labelId}"]`).click();await open();
});
afterEach(async info=>{try{if(info.error)await page.screenshot({path:path.join(qa,'failure-'+info.name.replace(/\W+/g,'-')+'.png')});assert.deepEqual(errors,[]);report.cases.push({name:info.name,status:info.error?'failed':'passed',error:info.error?.message});}finally{await context?.close();}});
async function frames(){await page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));}
async function referenceSource(index){
  try{return 'data:image/png;base64,'+(await readFile(path.resolve('qa','reference-studio','fixtures',`landscape-0${index}.png`))).toString('base64');}
  catch(error){if(error.code!=='ENOENT')throw error;}
  // A clean checkout can run this suite without first running reference-studio QA.
  return page.evaluate(index=>{const canvas=document.createElement('canvas');canvas.width=720;canvas.height=480;const ctx=canvas.getContext('2d');ctx.fillStyle=index===1?'#abcfd8':'#d5bb97';ctx.fillRect(0,0,720,480);const polygon=(points,color)=>{ctx.fillStyle=color;ctx.beginPath();points.forEach(([x,y],i)=>i?ctx.lineTo(x,y):ctx.moveTo(x,y));ctx.closePath();ctx.fill();};polygon([[0,320],[170,160],[260,255],[390,80],[540,260],[650,190],[720,310],[720,480],[0,480]],'#687e87');polygon([[390,80],[435,133],[410,125],[392,150],[365,130],[340,143]],'#fff4db');polygon([[0,390],[160,340],[310,380],[480,320],[720,365],[720,480],[0,480]],'#789979');return canvas.toDataURL('image/png');},index);
}
async function idle(){await page.waitForFunction(()=>!document.body.classList.contains('busy'));}
async function open(){await page.locator('#linkReference').click();await page.locator('#referenceDialog').waitFor({state:'visible'});await page.waitForFunction(()=>document.querySelector('#referenceEditorHost').dataset.refReady==='true');await frames();}
async function expand(){await page.locator('#refExpandPhoto').click();await page.waitForFunction(()=>document.querySelector('#referenceDialog').classList.contains('reference-photo-expanded'));await frames();}
async function back(){await page.locator('#refBackToReferences').click();await page.waitForFunction(()=>!document.querySelector('#referenceDialog').classList.contains('reference-photo-expanded'));await frames();}
async function tool(name){await page.locator(`[data-ref-tool=${name}]`).click();await frames();}
async function control(id,value){await page.locator('#'+id).evaluate((input,value)=>{input.value=String(value);input.dispatchEvent(new Event('input',{bubbles:true}));input.dispatchEvent(new Event('change',{bubbles:true}));},value);}
async function point(x,y){const r=await page.locator('#refCanvasBoard').boundingBox();return {x:r.x+x*r.width/720,y:r.y+y*r.height/480};}
async function text(value,x=200,y=130,commit=true){await tool('text');const p=await point(x,y);await page.mouse.click(p.x,p.y);await page.locator('#refTextEditor').fill(value);if(commit){await page.locator('#refTextEditor').press('Enter');await page.locator('#refTextEditor').waitFor({state:'hidden'});}}
async function view(){return page.locator('#refCanvasBoard').evaluate(element=>({transform:element.style.transform,fit:document.querySelector('#refFit').getAttribute('aria-pressed'),zoom:document.querySelector('#refZoomPercent').textContent}));}
async function saveLinks(){await page.locator('#saveReferenceLink').click();await page.locator('#referenceDialog').waitFor({state:'hidden'});await idle();}
async function saveProject(){const pending=page.waitForEvent('download');await page.locator('#saveProject').click();const download=await pending,stream=await download.createReadStream(),chunks=[];for await(const chunk of stream)chunks.push(chunk);const buffer=Buffer.concat(chunks);await page.waitForTimeout(725);return {name:download.suggestedFilename(),buffer,data:JSON.parse(buffer.toString())};}
async function reopen(saved){await page.locator('#projectInput').setInputFiles({name:saved.name,mimeType:'application/json',buffer:saved.buffer});await idle();await page.locator(`.layer-row[data-id="${labelId}"]`).click();await open();}
async function geometry(){return page.locator('#refCanvasStage').boundingBox();}
async function reachable(selector){const loc=page.locator(selector);await loc.scrollIntoViewIfNeeded();const data=await loc.evaluate(element=>{const r=element.getBoundingClientRect(),hit=document.elementFromPoint(r.x+r.width/2,r.y+r.height/2);return {r:{left:r.left,right:r.right,top:r.top,bottom:r.bottom},hit:element===hit||element.contains(hit),width:innerWidth,height:innerHeight};});assert.ok(data.hit&&data.r.left>=0&&data.r.right<=data.width&&data.r.top>=0&&data.r.bottom<=data.height,'Reachable '+selector+': '+JSON.stringify(data));}

test('expanded reference retains draft notes, annotations and history through Back, save and reopen',{timeout:60000},async()=>{
  await page.locator('#referenceNotes').fill('Keep the snow on the selected peaks.');await page.locator('#labelComment').fill('Use these mountain details for area 1.');
  const normal=await geometry();await expand();const enlarged=await geometry();assert.ok(enlarged.width>normal.width*1.2&&enlarged.height>normal.height*1.5,JSON.stringify({normal,enlarged}));
  for(const name of ['move','text','pencil','highlight','pan'])await reachable(`[data-ref-tool=${name}]`);for(const id of ['refBackToReferences','refZoomIn','refZoomOut','refZoomPercent','refFit','refColorWheel','refUndo','refRedo','refDelete'])await reachable('#'+id);
  await text('Snow detail',280,110,false);await back();assert.equal(await page.locator('#referenceNotes').inputValue(),'Keep the snow on the selected peaks.');assert.equal(await page.locator('#labelComment').inputValue(),'Use these mountain details for area 1.');assert.equal(await page.locator('#refUndo').isDisabled(),false);
  await expand();await page.locator('#refUndo').click();assert.equal(await page.locator('#refRedo').isDisabled(),false);await page.locator('#refRedo').click();await frames();await page.screenshot({path:path.join(qa,'expanded-photo-editing.png')});await back();await saveLinks();const saved=await saveProject();
  assert.equal(saved.data.references[0].annotations[0].text.content,'Snow detail');assert.equal(saved.data.references[0].notes,'Keep the snow on the selected peaks.');assert.equal(saved.data.layers.find(l=>l.id===labelId).referenceComment,'Use these mountain details for area 1.');assert.equal(saved.data.references[0].source,original.references[0].source);assert.deepEqual(saved.data.assets,original.assets);
  await reopen(saved);assert.equal(await page.locator('#referenceNotes').inputValue(),'Keep the snow on the selected peaks.');await expand();await tool('move');const p=await point(285,120);await page.mouse.click(p.x,p.y);await page.locator('#refEdit').click();assert.equal(await page.locator('#refTextEditor').inputValue(),'Snow detail');await page.locator('#refTextEditor').press('Escape');await back();
});

test('zoom and pan keep native drawing coordinates and survive tool changes undo and Back',{timeout:60000},async()=>{
  await expand();await page.locator('#refZoomPercent').click();await page.locator('#refZoomIn').click();const before=await view();await tool('pan');const stage=await geometry();await page.mouse.move(stage.x+stage.width/2,stage.y+stage.height/2);await page.mouse.down();await page.mouse.move(stage.x+stage.width/2+36,stage.y+stage.height/2+24,{steps:5});await page.mouse.up();const panned=await view();assert.notEqual(panned.transform,before.transform);assert.equal(panned.zoom,before.zoom);assert.equal(panned.fit,'false');
  await tool('pencil');await control('refBrushSize',8);await control('refColor','#ff0000');let a=await point(220,160),b=await point(350,220);await page.mouse.move(a.x,a.y);await page.mouse.down();await page.mouse.move(b.x,b.y,{steps:8});await page.mouse.up();assert.deepEqual(await view(),panned);
  await tool('move');assert.deepEqual(await view(),panned);await page.locator('#refUndo').click();assert.deepEqual(await view(),panned);await page.locator('#refRedo').click();assert.deepEqual(await view(),panned);await back();assert.equal((await view()).zoom,panned.zoom);await expand();assert.equal((await view()).zoom,panned.zoom);await back();await saveLinks();const saved=await saveProject(),layer=saved.data.references[0].annotations[0],first=layer.drawing.points[0],last=layer.drawing.points.at(-1);
  assert.equal(layer.drawing.size,8);assert.ok(Math.abs(first[0]+layer.x-220)<1&&Math.abs(first[1]+layer.y-160)<1);assert.ok(Math.abs(last[0]+layer.x-350)<1&&Math.abs(last[1]+layer.y-220)<1);assert.equal(saved.data.references[0].source,original.references[0].source);
  await reopen(saved);await expand();await page.locator('#refZoomIn').click();await back();await page.locator('#referenceGallery [data-reference-key]').nth(1).click();await frames();assert.equal((await view()).fit,'true');assert.equal(await page.locator('#refUndo').isDisabled(),true);await page.locator('#referenceGallery [data-reference-key]').nth(0).click();await frames();assert.equal((await view()).fit,'true');
});

test('Escape unwinds text draft then color picker then expanded view; cancelling discards the session',{timeout:60000},async()=>{
  await page.locator('#referenceNotes').fill('Discard this note');await page.locator('#labelComment').fill('Discard this comment');await expand();await text('Discard this annotation');await text('Cancel only this draft',400,250,false);await page.locator('#refTextEditor').press('Escape');assert.equal(await page.locator('#refTextEditor').isVisible(),false);assert.equal(await page.locator('#referenceDialog').evaluate(d=>d.classList.contains('reference-photo-expanded')),true);
  await page.locator('#refColorWheel').click();await page.locator('#referenceEditorColorDialog').waitFor({state:'visible'});await page.keyboard.press('Escape');await page.locator('#referenceEditorColorDialog').waitFor({state:'hidden'});assert.equal(await page.locator('#referenceDialog').evaluate(d=>d.classList.contains('reference-photo-expanded')),true);
  await page.locator('#refCanvasStage').focus();await page.keyboard.press('Escape');await frames();assert.equal(await page.locator('#referenceDialog').isVisible(),true);assert.equal(await page.locator('#referenceDialog').evaluate(d=>d.classList.contains('reference-photo-expanded')),false);await page.keyboard.press('Escape');await page.locator('#referenceDialog').waitFor({state:'hidden'});const saved=await saveProject();assert.deepEqual(saved.data,original);
  await open();await expand();await text('Another unsaved annotation');await page.locator('#closeReferenceDialog').click();await page.locator('#referenceDialog').waitFor({state:'hidden'});assert.deepEqual((await saveProject()).data,original);
});

test('expanded tools and Back stay accessible without horizontal overflow in light and dark compact layouts',{timeout:60000},async()=>{
  for(const appearance of ['dark','light']){if(await page.locator('html').getAttribute('data-theme')!==appearance)await page.evaluate(value=>{document.documentElement.dataset.theme=value;},appearance);
    for(const viewport of [{width:1280,height:800},{width:800,height:800},{width:580,height:720}]){await page.setViewportSize(viewport);await frames();await expand();await tool('highlight');
      for(const selector of ['#refBackToReferences','[data-ref-tool=move]','[data-ref-tool=text]','[data-ref-tool=pencil]','[data-ref-tool=highlight]','[data-ref-tool=pan]','#refBrushSize','#refColor','#refColorWheel','#refUndo','#refRedo','#refDelete','#refZoomOut','#refZoomPercent','#refZoomIn','#refFit'])await reachable(selector);
      const dimensions=await page.evaluate(()=>['referenceDialog','referenceLinkForm','referenceEditorHost','referenceAnnotationToolbar','referenceViewToolbar'].map(id=>{const e=document.getElementById(id);return {id,scrollWidth:e.scrollWidth,clientWidth:e.clientWidth};}));for(const d of dimensions)assert.ok(d.scrollWidth<=d.clientWidth+1,JSON.stringify(d));assert.ok((await geometry()).height>=200);await page.screenshot({path:path.join(qa,`${appearance}-expanded-${viewport.width}x${viewport.height}.png`)});await back();await reachable('#refExpandPhoto');await page.screenshot({path:path.join(qa,`${appearance}-normal-${viewport.width}x${viewport.height}.png`)});
    }
  }
});

test('Enter activates view buttons without editing selected text or saving the reference form',{timeout:60000},async()=>{
  await page.locator('#refExpandPhoto').focus();await page.keyboard.press('Enter');await frames();assert.equal(await page.locator('#referenceDialog').evaluate(d=>d.classList.contains('reference-photo-expanded')),true);await text('Keyboard selection');
  await page.locator('#refTextSize').fill('42');await page.locator('#refTextSize').press('Enter');await frames();assert.equal(await page.locator('#referenceDialog').isVisible(),true,'Text size Enter must not save the entire References form');assert.equal(await page.locator('#referenceDialog').evaluate(d=>d.classList.contains('reference-photo-expanded')),true);
  await page.locator('#refZoomIn').focus();const before=await view();await page.keyboard.press('Enter');assert.notEqual((await view()).zoom,before.zoom);assert.equal(await page.locator('#refTextEditor').isVisible(),false,'Enter on a toolbar button must not open selected annotation text');
  await tool('pencil');await page.locator('#refBrushSize').fill('12');await page.locator('#refBrushSize').press('Enter');await frames();assert.equal(await page.locator('#referenceDialog').isVisible(),true,'Brush size Enter must not save the entire References form');
  await page.locator('#refBackToReferences').focus();await page.keyboard.press('Enter');await frames();assert.equal(await page.locator('#referenceDialog').isVisible(),true);assert.equal(await page.locator('#referenceDialog').evaluate(d=>d.classList.contains('reference-photo-expanded')),false);
});
