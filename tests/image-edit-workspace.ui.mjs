import {test,before,after,beforeEach,afterEach} from 'node:test';
import assert from 'node:assert/strict';
import {mkdir,writeFile} from 'node:fs/promises';
import path from 'node:path';
import {chromium} from 'playwright';
import {createServer} from '../server.mjs';
import {prepareImageRequest} from '../desktop-image-request.mjs';
import {newProject,addRaster,addReference,serializeProject} from '../public/core.mjs';
import {regionContainsPoint,regionMaskInfo} from '../public/object-regions.mjs';

const qa=path.resolve('qa','image-edit-workspace'),model='gpt-image-2.5-sunburst';
const report={suite:'Dedicated Edit image workspace',paidCalls:0,cases:[]};
let server,browser,context,page,base,errors,requests,detectorCalls,records,sources,output;
before(async()=>{await mkdir(qa,{recursive:true});server=createServer({detection:{status:async()=>({available:false}),dispose(){}},sheets:{dispose(){}},images:{dispose(){}}});await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));base=`http://127.0.0.1:${server.address().port}`;browser=await chromium.launch({headless:true});});
after(async()=>{await writeFile(path.join(qa,'report.json'),JSON.stringify(report,null,2));await browser?.close();if(server)await new Promise(resolve=>server.close(resolve));});
beforeEach(async()=>{
  errors=[];requests=[];detectorCalls=[];records=new Map();sources=new Map();
  context=await browser.newContext({viewport:{width:1440,height:960},acceptDownloads:true});
  await context.addInitScript(()=>localStorage.setItem('asun-image-appearance','dark'));
  page=await context.newPage();page.on('pageerror',error=>errors.push(error.message));
  output=await fixture('Generated removal result',640,480,'#a2bcad');
  await context.route('**/*',async route=>{
    const request=route.request(),url=new URL(request.url());
    if(url.origin!==base){errors.push('External request blocked: '+url.origin);return route.abort();}
    const json=(data,status=200)=>route.fulfill({status,contentType:'application/json',body:JSON.stringify(data)});
    if(url.pathname==='/api/generation-queue/status')return json({error:'Legacy mock route'},404);
    if(url.pathname.startsWith('/api/sheets/'))return json({configured:false,authenticated:false,models:[],token:'qa-sheet',message:'Sheet generation is disconnected for editing QA.'});
    if(url.pathname==='/api/images/status')return json({configured:true,authenticated:true,models:[{id:model,label:'GPT Image 2.5 · Sunburst',available:true}],token:'qa-edit',message:'Mock generation ready.'});
    if(url.pathname==='/api/images/generate'){
      assert.equal(request.headers()['x-asun-image-token'],'qa-edit');const body=request.postDataJSON(),prepared=prepareImageRequest(body);
      requests.push({body,prepared});sources.set(body.requestId,structuredClone(body.project));
      const record={id:body.requestId,status:'completed',mode:'image',model:body.model,sourceName:body.project.name,sourceProjectAvailable:true,image:{name:'Removed object.png',source:output,width:640,height:480},settings:{model:body.model,quality:body.quality,size:prepared.size,prompt:prepared.prompt,inputs:[]},availableInputs:[],outputAvailable:true};records.set(record.id,record);return json({id:record.id,status:'running'},202);
    }
    const match=/^\/api\/images\/jobs\/([^/]+)(?:\/(project))?$/.exec(url.pathname);
    if(match){const [,id,source]=match;return source?json({project:sources.get(id)}):json(records.get(id));}
    if(url.pathname==='/api/local-detection/status')return json({available:true,token:'qa-detect',message:'Mock SAM ready.'});
    if(url.pathname==='/api/local-detection'){
      const body=request.postDataJSON();detectorCalls.push(body);
      return json({width:body.width,height:body.height,regions:[{id:'left object',segmentation:rectangle(body.width,body.height,70,90,130,180)},{id:'right object',segmentation:rectangle(body.width,body.height,390,110,140,170)}],model:'mock-local-SAM',device:'CPU',elapsedMs:1});
    }
    if(request.method()==='POST'&&url.pathname.startsWith('/api/')){errors.push('Unexpected POST '+url.pathname);return json({error:'Disabled during isolated QA.'},500);}
    return route.continue();
  });
  await page.goto(base);await page.waitForFunction(()=>document.documentElement.dataset.ready==='true');
  if(await page.locator('#skipStartup').isVisible())await page.locator('#skipStartup').click();
  await page.waitForFunction(()=>document.querySelector('#model')?.value==='gpt-image-2.5-sunburst');
});
afterEach(async info=>{try{if(info.error)await page.screenshot({path:path.join(qa,'failure-'+info.name.replace(/\W+/g,'-')+'.png')});report.cases.push({name:info.name,status:info.error?'failed':'passed',error:info.error?.message,mockedGenerations:requests.length,mockedDetections:detectorCalls.length});assert.deepEqual(errors,[]);}finally{await context?.close();}});

function rectangle(width,height,x,y,w,h){const counts=[];let old=0,count=0;for(let row=0;row<height;row++)for(let col=0;col<width;col++){const v=Number(col>=x&&col<x+w&&row>=y&&row<y+h);if(v===old)count++;else{counts.push(count);old=v;count=1;}}counts.push(count);return {width,height,counts};}
async function fixture(label='Original photograph',width=600,height=400,color='#c27b42'){
  return page.evaluate(({label,width,height,color})=>{const canvas=document.createElement('canvas');canvas.width=width;canvas.height=height;const ctx=canvas.getContext('2d');ctx.fillStyle='#e8e1d4';ctx.fillRect(0,0,width,height);ctx.fillStyle=color;ctx.fillRect(70,90,130,180);ctx.fillStyle='#4a7682';ctx.fillRect(390,110,140,170);ctx.fillStyle='#293947';ctx.font='16px Arial';ctx.fillText(label,24,height-25);return canvas.toDataURL();},{label,width,height,color});
}
async function sampleProject({references=false}={}){
  const source=await fixture(),added=addRaster(newProject(600,400,'Object removal QA'),{name:'Original objects.png',source,width:600,height:400});let project=added.project;
  if(references){project=addReference(project,{name:'Unrelated pink material.png',source:await fixture('Unrelated reference',600,400,'#ee00aa'),width:600,height:400});project.references[0].notes='UNRELATED REFERENCE NOTE';project.prompt='UNRELATED PROMPT: replace every object with pink flowers.';}
  return project;
}
async function load(project){await page.locator('#projectInput').setInputFiles({name:'Edit image QA.asun',mimeType:'application/json',buffer:Buffer.from(serializeProject(project))});await page.waitForFunction(count=>document.querySelectorAll('.layer-row').length===count&&!document.body.classList.contains('busy'),project.layers.length);}
async function save(){await page.waitForFunction(()=>!document.body.classList.contains('busy'));const pending=page.waitForEvent('download');await page.locator('#saveProject').click();const download=await pending,stream=await download.createReadStream(),chunks=[];for await(const chunk of stream)chunks.push(chunk);await page.waitForTimeout(725);return JSON.parse(Buffer.concat(chunks).toString());}
async function enter(){await page.locator('#editTab').click();await page.locator('#imageEditWorkspaceBar').waitFor({state:'visible'});assert.equal(new URL(page.url()).searchParams.get('workspace'),'edit');await page.locator('#fit').click();}
async function control(selector,value){await page.locator(selector).evaluate((input,value)=>{input.value=String(value);input.dispatchEvent(new Event('input',{bubbles:true}));},value);}
async function point(x,y){const b=await page.locator('#board').boundingBox(),size=await page.locator('#canvas').evaluate(canvas=>({width:canvas.width,height:canvas.height}));return {x:b.x+x*b.width/size.width,y:b.y+y*b.height/size.height};}
async function stroke(points){const first=await point(...points[0]);await page.mouse.move(first.x,first.y);await page.mouse.down();for(const next of points.slice(1)){const p=await point(...next);await page.mouse.move(p.x,p.y,{steps:5});}await page.mouse.up();await page.waitForTimeout(100);}
async function alpha(x,y){return page.locator('#canvas').evaluate((canvas,{x,y})=>canvas.getContext('2d').getImageData(x,y,1,1).data[3],{x,y});}
async function waitAlpha(x,y,value){await page.waitForFunction(({x,y,value})=>document.querySelector('#canvas').getContext('2d').getImageData(x,y,1,1).data[3]===value,{x,y,value});}
async function reachable(selector){await page.locator(selector).scrollIntoViewIfNeeded();const value=await page.locator(selector).evaluate(el=>{const b=el.getBoundingClientRect(),target=document.elementFromPoint(b.x+b.width/2,b.y+b.height/2);return {visible:target===el||el.contains(target),left:b.left,top:b.top,right:b.right,bottom:b.bottom,w:innerWidth,h:innerHeight};});assert(value.visible&&value.left>=0&&value.top>=0&&value.right<=value.w+1&&value.bottom<=value.h+1,selector+' reachable '+JSON.stringify(value));}
async function activeTool(){if(await page.locator('#imageEditPaint').getAttribute('aria-pressed')==='true')return 'select';if(await page.locator('#imageEditSubtract').getAttribute('aria-pressed')==='true')return 'subtract';return page.locator('.toolrail [data-tool].active').getAttribute('data-tool');}

test('paint and subtract produce exact erasable areas; local erasure is undoable and survives native save/reopen',{timeout:60000},async()=>{
  const original=await sampleProject();await load(original);await enter();await control('#imageEditBrushSize',100);
  const hover=await point(200,180);await page.mouse.move(hover.x,hover.y);await page.mouse.wheel(0,120);await page.waitForTimeout(80);assert.notEqual(await page.locator('#imageEditBrushSize').inputValue(),'100','Wheel adjusts selection brush size without leaving its tool.');await control('#imageEditBrushSize',100);await stroke([[200,180]]);await stroke([[400,180]]);
  assert.equal(await page.locator('#referenceDialog').isVisible(),false);let selected=await save();const label=selected.layers.find(layer=>layer.objectRegion);assert(label);assert.equal(selected.layers.filter(layer=>layer.objectRegion).length,1);assert(regionContainsPoint(label.objectRegion.mask,200,180));assert(regionContainsPoint(label.objectRegion.mask,400,180));assert(!regionContainsPoint(label.objectRegion.mask,300,180));
  await page.locator('#stage').focus();await page.keyboard.press('e');assert.equal(await activeTool(),'subtract');await page.keyboard.press('b');assert.equal(await activeTool(),'select');
  for(const key of ['p','t','c','l']){await page.keyboard.press(key);assert.equal(await activeTool(),'select',`${key} cannot switch to a hidden Edit-page tool`);}
  for(const selector of ['#imageEditDetected','.toolrail [data-tool=move]','.toolrail [data-tool=hand]'])for(const direction of [-120,120]){
    await page.locator(selector).click();const p=await point(300,300);await page.mouse.move(p.x,p.y);await page.mouse.wheel(0,direction);await page.waitForTimeout(70);assert(['select','subtract','detect','move','hand'].includes(await activeTool()),'Wheel cycling stays within Edit-page tools.');
  }
  await page.locator('#stage').focus();await page.keyboard.press('b');await page.locator('#imageEditSelectionOverlay').waitFor({state:'visible'});await page.locator('#compare').click();await page.locator('#imageEditSelectionOverlay').waitFor({state:'hidden'});assert.equal(await page.locator('#originalCanvas').isVisible(),true);await page.locator('#compare').click();await page.locator('#imageEditSelectionOverlay').waitFor({state:'visible'});
  await page.locator('#imageEditSubtract').click();await control('#imageEditBrushSize',30);await stroke([[200,180]]);const refined=await save(),mask=refined.layers.find(layer=>layer.id===label.id).objectRegion.mask;
  assert(!regionContainsPoint(mask,200,180));assert(regionContainsPoint(mask,240,180));assert(regionMaskInfo(mask).area<regionMaskInfo(label.objectRegion.mask).area);
  await page.locator('#imageEditErase').click();await waitAlpha(240,180,0);assert.equal(await alpha(200,180),255);assert.equal(await alpha(400,180),0);assert.equal(await alpha(300,180),255);assert.equal(await alpha(500,350),255);
  const erased=await save();assert.equal(erased.layers.find(layer=>layer.kind==='raster').mask.at(-1).mode,'hide');assert.deepEqual(erased.assets,original.assets);assert.equal(erased.layers.find(layer=>layer.id===label.id).visible,false);assert.equal(requests.length,0);
  await page.locator('#undo').click();assert.deepEqual(await save(),refined);await page.locator('#redo').click();await waitAlpha(240,180,0);await load(erased);await waitAlpha(240,180,0);assert.deepEqual(await save(),erased);await page.screenshot({path:path.join(qa,'local-erased-selection.png')});
});

test('auto detect selects objects on the Edit page without opening References and exposes the original reference editor on demand',{timeout:60000},async()=>{
  await load(await sampleProject());await enter();await page.locator('#imageEditAutoDetect').click();await page.waitForFunction(()=>document.querySelector('#detectionStatus').dataset.state==='ready');
  const first=await point(120,170);await page.mouse.click(first.x,first.y);await page.waitForFunction(()=>document.querySelector('#imageEditAreaCount').textContent==='1');assert.equal(await page.locator('#referenceDialog').isVisible(),false);
  const second=await point(460,170);await page.mouse.click(second.x,second.y);await page.waitForFunction(()=>document.querySelector('#imageEditAreaCount').textContent==='2');assert.equal(await page.locator('#referenceDialog').isVisible(),false);assert.equal(detectorCalls.length,1);
  await page.locator('#imageEditReferences').click();await page.locator('#referenceDialog').waitFor({state:'visible'});
  for(const selector of ['#referenceWebQuery','#chooseReferencePhoto','#pasteReferencePhoto','#referenceChoice','#labelComment','#saveReferenceLink'])assert.equal(await page.locator(selector).isVisible(),true,selector);
  const image=await fixture('Added reference');await page.locator('#referenceFileInput').setInputFiles({name:'New appearance.png',mimeType:'image/png',buffer:Buffer.from(image.split(',')[1],'base64')});await page.waitForFunction(()=>document.querySelector('#referenceEditorHost').dataset.refReady==='true');
  assert.match(await page.locator('#referenceEditorHost').innerText(),/Pencil/);assert.match(await page.locator('#referenceEditorHost').innerText(),/Highlight/);await page.locator('#labelComment').fill('Use this for the selected object only.');await page.locator('#saveReferenceLink').click();await page.locator('#referenceDialog').waitFor({state:'hidden'});
  const project=await save();assert.equal(project.references.length,1);assert.equal(project.layers.filter(layer=>layer.referenceIds?.length===1).length,1);assert.equal(requests.length,0);await page.screenshot({path:path.join(qa,'detected-objects-edit-page.png')});
});

test('Remove and fill sends only the selected removal intent and preserves the setup; editing its output enters this page',{timeout:60000},async()=>{
  const original=await sampleProject({references:true});await load(original);await enter();await control('#imageEditBrushSize',65);await stroke([[130,160],[130,210]]);const before=await save();await page.locator('#imageQuality').selectOption('max');
  await page.locator('#imageEditRemoveFill').click();await page.locator('#imageGenerationResult').waitFor({state:'visible'});assert.equal(await page.locator('#desktopImageResultDialog').isVisible(),false);await page.locator('#imageGenerationResult').click();await page.locator('#desktopImageResultDialog').waitFor({state:'visible'});assert.equal(requests.length,1);const {body,prepared}=requests[0];
  assert.equal(body.model,model);assert.equal(body.quality,'max');assert.equal(body.project.imageEditRequest.action,'remove-fill');assert.deepEqual(body.project.references,before.references,'Saved native setup retains all references for Redo.');assert.equal(body.project.prompt,before.prompt);
  assert.match(prepared.prompt,/Remove the object inside this selection completely/);assert.doesNotMatch(prepared.prompt,/UNRELATED|pink flowers|Unrelated pink material/);assert.deepEqual(prepared.inputRoles.map(role=>role.role),['current composition','canvas annotation guide','area selection mask']);assert.equal(body.areaMasks.length,1);assert.equal(body.referencePreviews.length,0);
  await page.locator('[data-image-result-close]').first().click();assert.deepEqual(await save(),before,'Preview never silently replaces the editor.');await page.locator('#imageGenerationResult').click();await page.locator('[data-image-result-edit]').click();await page.locator('#desktopImageResultDialog').waitFor({state:'hidden'});await page.locator('#imageEditWorkspaceBar').waitFor({state:'visible'});
  const edited=await save();assert.deepEqual([edited.width,edited.height],[640,480]);assert.equal(edited.assets[edited.original.assetId].source,output);assert.equal(edited.layers.length,1);assert.equal(new URL(page.url()).searchParams.get('workspace'),'edit');
  await page.locator('#imageEditBack').click();await page.locator('#imageEditWorkspaceBar').waitFor({state:'hidden'});assert.equal(new URL(page.url()).searchParams.has('workspace'),false);
  await page.locator('#imageGenerationResult').click();await page.locator('[data-image-result-redo]').click();await page.locator('#desktopImageResultDialog').waitFor({state:'hidden'});const restored=await save();assert.deepEqual(restored,before);assert.equal(requests.length,1);await page.screenshot({path:path.join(qa,'restored-removal-setup.png')});
});

test('empty and compact Edit pages expose reachable tools and preserve original canvas when returning',{timeout:60000},async()=>{
  await enter();assert.equal(await page.locator('#imageEditImport').isVisible(),true);assert.equal(await page.locator('#imageEditErase').isEnabled(),false);assert.equal(await page.locator('#imageEditRemoveFill').isEnabled(),false);
  const original=await sampleProject();await load(original);await control('#imageEditBrushSize',60);await stroke([[130,180]]);
  for(const width of [1440,1024])for(const theme of ['dark','light']){
    await page.setViewportSize({width,height:800});await page.evaluate(value=>document.documentElement.dataset.theme=value,theme);await page.locator('#fit').click();
    for(const selector of ['#imageEditBack','#imageEditPaint','#imageEditBrushSize','#imageEditErase','#imageEditRemoveFill','#imageEditReferences'])await reachable(selector);
    assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1),true);await page.locator('#imageEditPaint').scrollIntoViewIfNeeded();await page.screenshot({path:path.join(qa,`edit-page-${theme}-${width}.png`)});
  }
  const before=await save();await page.locator('#imageEditBack').click();assert.deepEqual(await save(),before);await page.locator('#stage').focus();
  for(const [key,tool]of [['p','pencil'],['t','text'],['c','crop'],['l','highlight'],['b','mask'],['e','erase']]){await page.keyboard.press(key);assert.equal(await page.locator('.toolrail [data-tool].active').getAttribute('data-tool'),tool,'Back restores normal editor shortcuts.');}
  await enter();assert.deepEqual(await save(),before);assert.equal(requests.length,0);
});
