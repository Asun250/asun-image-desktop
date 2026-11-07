import {test,before,after,beforeEach,afterEach} from 'node:test';
import assert from 'node:assert/strict';
import {mkdir,writeFile} from 'node:fs/promises';
import path from 'node:path';
import {chromium} from 'playwright';
import {createServer} from '../server.mjs';

const qa=path.resolve('qa','sketch-workspace'),report={suite:'Editable Draw / sketch reference workspace',paidCalls:0,cases:[]};
let server,browser,context,page,base,errors,detectCalls,detectorAvailable;
before(async()=>{
  await mkdir(qa,{recursive:true});
  server=createServer({detection:{status:async()=>({available:false}),dispose(){}},sheets:{dispose(){}},images:{dispose(){}}});
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));base=`http://127.0.0.1:${server.address().port}`;
  browser=await chromium.launch({headless:true});
});
after(async()=>{await writeFile(path.join(qa,'report.json'),JSON.stringify(report,null,2));await browser?.close();if(server)await new Promise(resolve=>server.close(resolve));});
beforeEach(async()=>{
  errors=[];detectCalls=[];detectorAvailable=false;
  context=await browser.newContext({viewport:{width:1440,height:1000},acceptDownloads:true});
  await context.addInitScript(()=>localStorage.setItem('asun-image-appearance','dark'));
  await context.grantPermissions(['clipboard-read','clipboard-write'],{origin:base});
  await context.route('**/*',async route=>{
    const url=new URL(route.request().url());
    if(url.origin!==base){errors.push('Unexpected external request: '+url.origin);return route.abort();}
    if(/^\/api\/(images|sheets)\//.test(url.pathname)){
      if(route.request().method()==='POST')errors.push('Unexpected generation POST: '+url.pathname);
      return route.fulfill({json:{configured:false,authenticated:false,models:[],message:'Generation is disabled for sketch UI verification.'}});
    }
    if(url.pathname==='/api/local-detection/status')return route.fulfill({json:{available:detectorAvailable,token:'sketch-qa',message:'Local detection is unavailable. Use marked area manually.'}});
    if(url.pathname==='/api/local-detection'){detectCalls.push(route.request().postDataJSON());return route.fulfill({status:503,json:{error:'No real model inference is allowed in this UI suite.'}});}
    return route.continue();
  });
  page=await context.newPage();page.on('pageerror',error=>errors.push(error.message));
  await page.goto(base);await ready();
});
afterEach(async info=>{try{if(info.error)await page.screenshot({path:path.join(qa,'failure-'+info.name.replace(/\W+/g,'-')+'.png')});assert.deepEqual(errors,[]);report.cases.push({name:info.name,status:info.error?'failed':'passed',error:info.error?.message,detectorPosts:detectCalls.length});}finally{await context?.close();}});
async function ready(){await page.waitForFunction(()=>document.documentElement.dataset.ready==='true'&&!document.body.classList.contains('busy'));}
async function idle(){await page.waitForFunction(()=>!document.body.classList.contains('busy'));await frames();}
async function frames(){await page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));}
async function save(){const pending=page.waitForEvent('download');await page.locator('#saveProject').click();const download=await pending,stream=await download.createReadStream(),chunks=[];for await(const chunk of stream)chunks.push(chunk);const buffer=Buffer.concat(chunks);await page.waitForTimeout(725);return {name:download.suggestedFilename(),buffer,data:JSON.parse(buffer.toString())};}
async function load(data){await page.locator('#projectInput').setInputFiles({name:'Sketch QA.asun',mimeType:'application/json',buffer:Buffer.from(JSON.stringify(data))});await idle();await page.waitForFunction(count=>document.querySelectorAll('.layer-row').length===count,data.layers.filter(l=>l.id!==data.sketch?.surfaceLayerId).length);}
async function enter(){await page.locator('#drawSketchReference').click();await page.locator('#sketchWorkspaceBar').waitFor({state:'visible'});await idle();}
async function back(){await page.locator('#sketchBack').click();await page.locator('#sketchWorkspaceBar').waitFor({state:'hidden'});await idle();}
async function control(id,value){await page.locator('#'+id).evaluate((input,value)=>{input.value=String(value);input.dispatchEvent(new Event('input',{bubbles:true}));input.dispatchEvent(new Event('change',{bubbles:true}));},value);}
async function point(x,y,reference=false){const rect=await page.locator(reference?'#refCanvasBoard':'#board').boundingBox();const size=reference?{width:360,height:240}:await page.locator('#canvas').evaluate(c=>({width:c.width,height:c.height}));return {x:rect.x+x*rect.width/size.width,y:rect.y+y*rect.height/size.height};}
async function stroke(points,{mode='pencil',color='#222222',size=9,reference=false}={}){
  await page.locator(reference?`#referenceDialog [data-ref-tool=${mode}]`:`.toolrail [data-tool=${mode}]`).click();
  await control(reference?'refBrushSize':'brushSize',size);await control(reference?'refColor':'brushColor',color);
  const start=await point(...points[0],reference);await page.mouse.move(start.x,start.y);await page.mouse.down();
  for(const pair of points.slice(1)){const p=await point(...pair,reference);await page.mouse.move(p.x,p.y,{steps:3});}await page.mouse.up();await frames();
}
async function fixture(color='#7b9db1'){
  return page.evaluate(color=>{const c=document.createElement('canvas');c.width=360;c.height=240;const x=c.getContext('2d');x.fillStyle='#e9f2f5';x.fillRect(0,0,360,240);x.fillStyle=color;x.beginPath();x.moveTo(20,205);x.lineTo(100,60);x.lineTo(160,130);x.lineTo(250,40);x.lineTo(340,205);x.fill();x.fillStyle='#ffffff';x.fillRect(20,220,320,8);return c.toDataURL();},color);
}
async function nativeFixture({image=false}={}){const source=await fixture();return page.evaluate(async({source,image})=>{
  const core=await import('/core.mjs');let p=core.newProject(1600,1000,'Unsaved original scene');
  if(image)p=core.addRaster(p,{name:'Original unchanged.png',source,width:360,height:240},{fitDocument:false}).project;
  for(const points of [[[100,720],[380,520],[600,700],[950,350],[1300,720]],[[450,600],[450,470],[590,470],[590,600],[450,600]],[[440,470],[520,410],[600,470]],[[700,720],[730,790],[730,910],[700,940]],[[720,810],[670,870],[650,835]]])p=core.addDrawing(p,{points,color:'#283942',size:9}).project;
  p.prompt='Preserve this unsaved main project and its camera placement.';return JSON.parse(core.serializeProject(p));
},{source,image});}
async function reachable(selector){await page.locator(selector).scrollIntoViewIfNeeded();const result=await page.locator(selector).evaluate(e=>{const r=e.getBoundingClientRect(),hit=document.elementFromPoint(r.x+r.width/2,r.y+r.height/2);return {hit:hit===e||e.contains(hit),x:r.x,y:r.y,right:r.right,bottom:r.bottom,width:innerWidth,height:innerHeight};});assert.ok(result.hit&&result.x>=0&&result.y>=0&&result.right<=result.width+1&&result.bottom<=result.height+1,selector+' is reachable: '+JSON.stringify(result));}

test('separate sketch workspace preserves the unsaved main project and retains its own editable draft',{timeout:60000},async()=>{
  const original=await nativeFixture({image:true});await load(original);await enter();
  assert.equal(new URL(page.url()).searchParams.get('workspace'),'sketch');
  const blank=(await save()).data;assert.equal(blank.sketch.version,1);assert.equal(blank.layers.filter(l=>l.kind==='drawing').length,0,'A photo project is not silently imported into the independent sketch.');
  await page.locator('.toolrail [data-tool=move]').click();const empty=await point(500,400);await page.mouse.click(empty.x,empty.y);assert.equal(await page.locator('#deleteLayer').isDisabled(),true,'The white drawing page cannot be selected or deleted by clicking it.');
  await page.locator('#resizeCanvas').click();await page.locator('#widthField').fill('1800');await page.locator('#heightField').fill('1100');await page.locator('#confirmDialog').click();await idle();const resized=(await save()).data,surface=resized.layers.find(l=>l.id===resized.sketch.surfaceLayerId);
  assert.equal(resized.width,1800);assert.equal(resized.height,1100);assert.equal(surface.width,1800);assert.equal(surface.height,1100);assert.equal(resized.assets[surface.assetId].width,1800);assert.equal(resized.assets[surface.assetId].height,1100);
  await page.locator('#undo').click();assert.deepEqual((await save()).data,blank,'Canvas resize is undoable without flattening or losing the sketch surface.');
  await page.locator('#sketchDraw').click();await stroke([[500,400],[700,400],[700,600],[500,600],[500,400]]);const sketch=await save();
  assert.equal(sketch.data.layers.filter(l=>l.kind==='drawing').length,1);assert.equal(sketch.data.sketch.background,'#ffffff');
  await back();assert.deepEqual((await save()).data,original,'Back restores every native field of the original main project.');
  assert.notEqual(new URL(page.url()).searchParams.get('workspace'),'sketch');await enter();assert.deepEqual((await save()).data,sketch.data,'Opening the sketch again restores its editable draft.');
  await page.locator('#undo').click();assert.equal((await save()).data.layers.filter(l=>l.kind==='drawing').length,0,'Sketch undo history survives Back.');
  await page.locator('#redo').click();assert.deepEqual((await save()).data,sketch.data);await back();assert.deepEqual((await save()).data,original);
});

test('existing pencil-only scene carries into sketch while originals remain editable and unchanged',{timeout:60000},async()=>{
  const original=await nativeFixture();await load(original);await enter();const sketch=(await save()).data;
  assert.ok(sketch.sketch);assert.equal(sketch.layers.filter(l=>l.kind==='drawing').length,original.layers.length);
  for(const layer of original.layers)assert.deepEqual(sketch.layers.find(l=>l.id===layer.id),layer,'Existing pencil strokes retain their identity, points and edit controls.');
  const surface=sketch.layers.find(l=>l.id===sketch.sketch.surfaceLayerId);assert.equal(surface.kind,'raster');assert.equal(surface.x,0);assert.equal(surface.y,0);assert.equal(surface.width,1600);assert.equal(surface.height,1000);
  assert.equal(await page.locator('#autoDetect').isEnabled(),true);await page.screenshot({path:path.join(qa,'draw-sketch-existing-scene.png')});
  await back();assert.deepEqual((await save()).data,original);
});

test('two sketched subjects share the complete reference editor through explicit manual selection, save and reopen',{timeout:90000},async()=>{
  await load(await nativeFixture());await enter();const before=(await save()).data;
  await page.locator('#sketchHighlight').click();await stroke([[470,510],[575,575]],{mode:'highlight',color:'#ffff00',size:100});await stroke([[710,780],[710,920]],{mode:'highlight',color:'#ffff00',size:85});
  assert.match(await page.locator('#detectMarkedArea').innerText(),/2/);await page.locator('#detectMarkedArea').click();await page.locator('#guidedDetectionDialog').waitFor({state:'visible'});
  await page.waitForFunction(()=>document.querySelector('#guidedGroupList').querySelectorAll('[data-mark-id]').length===2&&document.querySelector('#guidedDetectionPreview').getAttribute('aria-busy')==='false');
  assert.equal(detectCalls.length,0);assert.equal(await page.locator('#confirmGuidedDetection').isEnabled(),false);await page.locator('#useMarkedArea').click();
  for(const row of await page.locator('#guidedGroupList [data-mark-id]').all())assert.match(await row.innerText(),/manual.*not AI detected/i);
  await page.locator('#confirmGuidedDetection').click();await page.locator('#referenceDialog').waitFor({state:'visible'});assert.match(await page.locator('#referenceAreaLabel').innerText(),/all 2 areas/i);
  for(const selector of ['#referenceWebQuery','#searchReferenceWeb','#chooseReferencePhoto','#pasteReferencePhoto','#referenceChoice','#labelComment'])await reachable(selector);
  const sources=[await fixture('#3c819c'),await fixture('#c2895a')];await page.locator('#referenceFileInput').setInputFiles(sources.map((source,index)=>({name:`Mountain material ${index+1}.png`,mimeType:'image/png',buffer:Buffer.from(source.split(',')[1],'base64')})));
  await page.waitForFunction(()=>document.querySelectorAll('#referenceGallery [data-reference-key]').length===2&&document.querySelector('#referenceEditorHost').dataset.refReady==='true');
  await page.locator('#referenceGallery [data-reference-key]').first().click();await page.locator('#referenceNotes').fill('Use the stone texture, keep the sketch shape.');await page.locator('#labelComment').fill('Apply this material to both highlighted subjects. Keep the layout exactly as drawn.');
  await page.locator('#refExpandPhoto').click();await page.waitForFunction(()=>document.querySelector('#referenceDialog').classList.contains('reference-photo-expanded'));
  for(const mode of ['move','text','pencil','highlight','pan'])await reachable(`#referenceDialog [data-ref-tool=${mode}]`);
  await stroke([[40,90],[140,90],[140,180],[40,180],[40,90]],{mode:'pencil',color:'#ff0000',size:5,reference:true});await stroke([[210,110],[290,160]],{mode:'highlight',color:'#ffff00',size:20,reference:true});
  await page.locator('#referenceDialog [data-ref-tool=text]').click();const p=await point(150,30,true);await page.mouse.click(p.x,p.y);await page.locator('#refTextEditor').fill('Use this texture');await page.locator('#refTextEditor').press('Enter');await page.screenshot({path:path.join(qa,'sketch-full-reference-editor.png')});
  await page.locator('#refBackToReferences').click();await page.locator('#saveReferenceLink').click();await page.locator('#referenceDialog').waitFor({state:'hidden'});const saved=await save(),group=saved.data.layers.find(l=>l.objectRegion);
  assert.equal(group.objectRegion.group.areaCount,2);assert.equal(group.referenceIds.length,2);assert.match(group.referenceComment,/both highlighted subjects/);assert.equal(saved.data.references.length,2);assert.equal(saved.data.references[0].source,sources[0]);assert.equal(saved.data.references[0].annotations.length,3);assert.equal(saved.data.references[0].annotations.filter(l=>l.kind==='drawing').length,2);
  for(const layer of before.layers.filter(l=>l.kind==='drawing'))assert.deepEqual(saved.data.layers.find(l=>l.id===layer.id),layer,'Sketch artwork remains editable and is not hidden with selection highlights.');
  await page.waitForFunction(()=>{const img=document.querySelector('.edit-summary-source-preview img');if(!img?.complete||!img.naturalWidth)return false;const c=document.createElement('canvas');c.width=img.naturalWidth;c.height=img.naturalHeight;const x=c.getContext('2d');x.drawImage(img,0,0);const bytes=x.getImageData(0,0,c.width,c.height).data;let dark=0;for(let i=0;i<bytes.length;i+=4)if(bytes[i+3]>0&&Math.max(bytes[i],bytes[i+1],bytes[i+2])<180)dark++;return dark>10;},null,{timeout:10000});
  await page.screenshot({path:path.join(qa,'sketch-two-subjects-with-references.png')});await load(saved.data);assert.deepEqual((await save()).data,saved.data,'Native save and reopen retain the sketch, selection masks, references and annotations.');
  await page.locator('.toolrail [data-tool=move]').click();await page.locator(`.layer-row[data-id="${group.id}"]`).click();await page.locator('#linkReference').click();await page.locator('#referenceDialog').waitFor({state:'visible'});assert.match(await page.locator('#referenceAreaLabel').innerText(),/all 2 areas/i);assert.equal(await page.locator('#referenceGallery [data-reference-key]').count(),2);assert.equal(await page.locator('#labelComment').inputValue(),group.referenceComment);await page.locator('#cancelReferenceLink').click();
});

test('direct sketch page exposes drawing, selection, size and Back controls in compact light and dark layouts',{timeout:60000},async()=>{
  await page.goto(base+'/?workspace=sketch');await ready();await page.locator('#sketchWorkspaceBar').waitFor({state:'visible'});
  for(const theme of ['dark','light'])for(const viewport of [{width:1440,height:1000},{width:1024,height:768}]){
    await page.setViewportSize(viewport);await page.evaluate(theme=>document.documentElement.dataset.theme=theme,theme);await frames();await page.locator('#sketchDraw').click();
    for(const selector of ['#sketchBack','#sketchDraw','#sketchHighlight','#sketchSelect','#brushSize','#brushColor','#autoDetect'])await reachable(selector);
    const overflow=await page.evaluate(()=>({scroll:document.documentElement.scrollWidth,width:innerWidth}));assert.ok(overflow.scroll<=overflow.width+1,JSON.stringify(overflow));
    await page.screenshot({path:path.join(qa,`sketch-workspace-${theme}-${viewport.width}.png`)});
  }
  await back();for(const selector of ['#drawSketchReference','#characterItemSheet','#openProject','#saveProject','#export','#imageGenerationHistory'])await reachable(selector);
  await page.screenshot({path:path.join(qa,'normal-main-after-sketch-1024.png')});
});
