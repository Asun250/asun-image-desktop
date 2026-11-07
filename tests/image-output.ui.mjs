import {test,before,after,beforeEach,afterEach} from 'node:test';
import assert from 'node:assert/strict';
import {mkdir,writeFile} from 'node:fs/promises';
import {chromium} from 'playwright';
import {createServer} from '../server.mjs';
import {prepareImageRequest} from '../desktop-image-request.mjs';
import {newProject,addReference,addRaster,addText,attachObjectRegion,serializeProject,parseProject,saveVariant,restoreVariant} from '../public/core.mjs';
import {IMAGE_ASPECT_PREFERENCE_KEY} from '../public/image-output-preferences.mjs';

const qa='qa/aspect-ratio',model='gpt-image-2.5-sunburst',older='gpt-image-1.5';
let browser,server,base,context,page,requests,errors,records,portrait,landscape,mismatch;
const report=[];
before(async()=>{await mkdir(qa,{recursive:true});server=createServer({detection:{status:async()=>({available:false}),dispose(){}},sheets:{dispose(){}},images:{dispose(){}}});await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));base=`http://127.0.0.1:${server.address().port}`;browser=await chromium.launch({headless:true});});
after(async()=>{await writeFile(qa+'/report.json',JSON.stringify({paidCalls:0,checks:report},null,2));await browser.close();await new Promise(resolve=>server.close(resolve));});
beforeEach(async()=>{
  requests=[];errors=[];records=new Map();mismatch=false;context=await browser.newContext({viewport:{width:1440,height:1000},acceptDownloads:true});page=await context.newPage();page.on('pageerror',error=>errors.push(error.message));page.on('dialog',dialog=>dialog.accept());
  await context.route('**/*',async route=>{const request=route.request(),url=new URL(request.url());if(url.origin!==base)return route.abort();if(!url.pathname.startsWith('/api/'))return route.continue();
    if(url.pathname==='/api/images/generate'){
      const body=request.postDataJSON();requests.push(body);const prepared=prepareImageRequest(body),source=mismatch?landscape:portrait,width=mismatch?384:216,height=mismatch?216:384;
      const outputCheck={matches:!mismatch,message:mismatch?'Output size mismatch: requested 864 × 1536, but the provider returned 384 × 216. The original output is saved unchanged; it was not cropped or stretched.':'QA fixture output; not a live provider result.'};
      const record={id:body.requestId,status:'completed',kind:'image',mode:'image',model:body.model,sourceName:body.project.name,sourceProjectAvailable:false,image:{source,width,height,name:'QA output.png'},outputCheck,settings:{model:body.model,quality:body.quality,size:prepared.size,prompt:prepared.prompt,inputs:[]}};records.set(record.id,record);return route.fulfill({json:record});
    }
    if(url.pathname==='/api/generation-queue/status')return route.fulfill({json:{items:[...records.values()].map(({image,...record})=>record)}});
    if(url.pathname.startsWith('/api/images/jobs/'))return route.fulfill({json:records.get(url.pathname.split('/').at(-1))});
    return route.fulfill({json:{configured:true,authenticated:true,available:false,token:'qa-output',models:[{id:model,available:true,label:'GPT Image 2.5 · Sunburst'},{id:older,available:true,label:'GPT Image 1.5'}],items:[]}});
  });
  await page.goto(base);await page.waitForFunction(()=>document.documentElement.dataset.ready==='true');if(await page.locator('#skipStartup').isVisible())await page.locator('#skipStartup').click();await page.waitForFunction(model=>document.querySelector('#model')?.value===model,model);
  [portrait,landscape]=await page.evaluate(()=>[[216,384],[384,216]].map(([width,height])=>{const canvas=document.createElement('canvas');canvas.width=width;canvas.height=height;const c=canvas.getContext('2d');c.fillStyle='#294c65';c.fillRect(0,0,width,height);c.fillStyle='#deb57b';c.fillRect(width*.25,height*.2,width*.5,height*.6);return canvas.toDataURL();}));
});
afterEach(async info=>{try{report.push({name:info.name,passed:!info.error,requests:requests.length});if(info.error)await page.screenshot({path:qa+'/failure.png'});assert.deepEqual(errors,[]);}finally{await context.close();}});
function references(){let p=newProject(1600,1000,'Portrait reference workflow');p=addReference(p,{name:'Portrait Blender.png',source:portrait,width:216,height:384});p=addReference(p,{name:'Appearance landscape.png',source:landscape,width:384,height:216});p.prompt='Keep the portrait Blender composition. Use the second image for materials only.';return p;}
async function load(project){await page.locator('#projectInput').setInputFiles({name:'Output test.asun',mimeType:'application/json',buffer:Buffer.from(serializeProject(project))});await page.waitForFunction(({name,prompt,layers})=>document.querySelector('#projectName')?.textContent===name&&document.querySelector('#prompt')?.value===prompt&&document.querySelectorAll('.layer-row').length===layers&&!document.body.classList.contains('busy'),{name:project.name,prompt:project.prompt,layers:project.layers.length});}
async function save(){const pending=page.waitForEvent('download');await page.locator('#saveProject').click();const stream=await(await pending).createReadStream(),chunks=[];for await(const part of stream)chunks.push(part);return parseProject(Buffer.concat(chunks).toString());}
async function generate(){await page.waitForFunction(()=>!document.querySelector('#generate').disabled);await page.locator('#generate').click();await page.waitForFunction(()=>!document.querySelector('#generate').disabled);assert.equal(requests.length,1);return requests[0];}

test('reference-only portrait framing is visible, saved, submitted and undoable without changing model or quality',async()=>{
  const original=references();original.imageOutput={version:1,aspect:'source'};await load(original);assert.equal(await page.locator('#imageOutputAspect').inputValue(),'source');assert.match(await page.locator('#imageOutputSummary').innerText(),/864 × 1536.*First global reference/);
  await page.locator('#imageQuality').selectOption('max');await page.locator('#imageOutputAspect').selectOption('9:16');assert.match(await page.locator('#imageOutputSummary').innerText(),/864 × 1536.*Chosen aspect ratio/);
  await page.locator('#undo').click();assert.equal(await page.locator('#imageOutputAspect').inputValue(),'source');await page.locator('#redo').click();assert.equal(await page.locator('#imageOutputAspect').inputValue(),'9:16');
  const saved=await save();assert.deepEqual(saved.imageOutput,{version:1,aspect:'9:16'});assert.deepEqual(saved.references,original.references);assert.equal(saved.width,1600);assert.equal(saved.height,1000);
  const body=await generate(),prepared=prepareImageRequest(body);assert.equal(body.project.imageOutput.aspect,'9:16');assert.equal(prepared.size,'864x1536');assert.equal(body.model,model);assert.equal(body.quality,'max');assert.equal(body.project.references[0].source,portrait);assert.equal(body.project.references[1].source,landscape);
  await page.screenshot({path:qa+'/portrait-output-controls.png'});
});

test('unsupported exact shape is reported before generation, and a supported portrait choice is explicit',async()=>{
  await load(references());await page.locator('#model').selectOption(older);assert.equal(await page.locator('#generate').isDisabled(),true);assert.match(await page.locator('#imageQualityMessage').innerText(),/1024 × 1536 \(2:3\)/);assert.equal(requests.length,0);
  const options=await page.locator('#imageOutputAspect option').evaluateAll(items=>items.map(item=>({value:item.value,disabled:item.disabled,text:item.textContent})));
  assert.deepEqual(options.filter(item=>!item.disabled).map(item=>item.value),['2:3','3:2','1:1']);assert(options.some(item=>item.value==='9:16'&&item.disabled&&item.text.includes('unsupported')));assert(!options.some(item=>item.value==='16:9'));assert.equal(await page.locator('#imageOutputAspect').inputValue(),'9:16');
  await page.locator('#imageOutputAspect').selectOption('2:3');await page.waitForFunction(()=>!document.querySelector('#generate').disabled);const body=await generate();assert.equal(prepareImageRequest(body).size,'1024x1536');assert.equal(body.model,older);
});

test('output choice remains separate between workflow tabs and within saved variants',async()=>{
  await load(references());await page.locator('#imageOutputAspect').selectOption('9:16');const first=await page.locator('[data-workflow-tab][aria-selected=true]').getAttribute('data-workflow-tab');
  await page.locator('#newWorkflowTab').click();await page.waitForFunction(()=>document.querySelectorAll('[data-workflow-tab]').length===2);assert.equal(await page.locator('#imageOutputAspect').inputValue(),'9:16');await page.locator('#imageOutputAspect').selectOption('16:9');
  await page.locator(`[data-workflow-tab="${first}"]`).click();await page.waitForFunction(()=>document.querySelector('#imageOutputAspect').value==='9:16');
  let project=await save();project=saveVariant(project,'Portrait');project.imageOutput={version:1,aspect:'16:9'};const restored=restoreVariant(parseProject(serializeProject(project)),project.variants[0].id);assert.equal(restored.imageOutput.aspect,'9:16');
});

test('locked blockout conflicts disable Generate instead of silently reframing',async()=>{
  let project=addRaster(newProject(216,384,'Locked portrait'),{name:'Portrait blockout.png',source:portrait,width:216,height:384}).project;project.prompt='Keep the portrait Blender composition.';project.blockoutReview={version:1,enabled:true,assetId:project.original.assetId,model:'gpt-6-astra',effort:'max',maxAttempts:1,authorizedChanges:''};
  project.imageOutput={version:1,aspect:'16:9'};await load(project);assert.equal(await page.locator('#generate').isDisabled(),true);assert.match(await page.locator('#imageQualityMessage').innerText(),/conflicts with the locked MAIN/);assert.equal(requests.length,0);assert.equal(await page.locator('#imageOutputAspect option[value="16:9"]').isDisabled(),true);
  await page.locator('#imageOutputAspect').selectOption('source');await page.waitForFunction(()=>!document.querySelector('#generate').disabled);assert.match(await page.locator('#imageOutputSummary').innerText(),/864 × 1536.*Blender blockout/);
});

test('Aspect Ratio defaults to 9:16 without dirtying the project and the generation snapshot records it',async()=>{
  assert.equal(await page.getByLabel('Aspect Ratio',{exact:true}).inputValue(),'9:16');assert.match(await page.locator('#imageOutputSummary').innerText(),/864 × 1536 px \(9:16\)/);assert.equal(await page.locator('#imageOutputExperimental').isVisible(),false);
  await load(references());const unchanged=await save();assert.equal(Object.hasOwn(unchanged,'imageOutput'),false,'Rendering the default does not edit the native project.');
  const body=await generate();assert.deepEqual(body.project.imageOutput,{version:1,aspect:'9:16'});assert.equal(prepareImageRequest(body).size,'864x1536');
});

test('the preferred aspect survives reload and new projects while explicit saved choices take priority',async()=>{
  await load(references());await page.locator('#imageOutputAspect').selectOption('16:9');assert.equal(await page.evaluate(key=>localStorage.getItem(key),IMAGE_ASPECT_PREFERENCE_KEY),'16:9');
  await page.reload();await page.waitForFunction(()=>document.documentElement.dataset.ready==='true');if(await page.locator('#skipStartup').isVisible())await page.locator('#skipStartup').click();await page.locator('#newWorkflowTab').click();await page.waitForFunction(()=>document.querySelector('#imageOutputAspect').value==='16:9');
  const blank=await save();assert.equal(Object.hasOwn(blank,'imageOutput'),false);assert.match(await page.locator('#imageOutputSummary').innerText(),/1536 × 864/);
  const saved=references();saved.imageOutput={version:1,aspect:'source'};await load(saved);assert.equal(await page.locator('#imageOutputAspect').inputValue(),'source');assert.match(await page.locator('#imageOutputSummary').innerText(),/864 × 1536.*First global reference/);assert.equal(await page.evaluate(key=>localStorage.getItem(key),IMAGE_ASPECT_PREFERENCE_KEY),'16:9');
  const body=await generate();assert.equal(body.project.imageOutput.aspect,'source');assert.equal(prepareImageRequest(body).size,'864x1536');
});

async function selectedEdit(width,height){
  const source=await page.evaluate(({width,height})=>{const c=document.createElement('canvas');c.width=width;c.height=height;const ctx=c.getContext('2d');ctx.fillStyle='#40708b';ctx.fillRect(0,0,width,height);return c.toDataURL();},{width,height});
  const raster=addRaster(newProject(width,height,'Selected-area canvas'),{name:'Original canvas.png',source,width,height});let p=raster.project;
  const label=addText(p,{content:'1',x:width*.4,y:height*.4,width:40,height:45,fontSize:24,color:'#ff0000'});p=attachObjectRegion(label.project,label.layerId,{version:1,assetId:p.original.assetId,rasterLayerId:raster.layerId,sourceWidth:width,sourceHeight:height,mask:{width:4,height:4,counts:[5,2,9]}});p.prompt='Keep the portrait Blender details; change only the selected area.';p.imageOutput={version:1,aspect:'9:16'};return p;
}

test('selected-area edits keep exact landscape canvas dimensions and leave the preferred portrait ratio unchanged',async()=>{
  await page.locator('#imageOutputAspect').selectOption('9:16');const project=await selectedEdit(1536,1024);await load(project);
  assert.equal(await page.locator('#imageOutputAspect').inputValue(),'canvas');assert.equal(await page.locator('#imageOutputAspect').isDisabled(),true);assert.equal(await page.locator('#imageOutputAspect option').count(),1);assert.match(await page.locator('#imageOutputSummary').innerText(),/1536 × 1024 px \(3:2\).*Edit canvas kept exactly/);assert.equal(await page.locator('#imageOutputExperimental').isVisible(),false);
  const body=await generate(),prepared=prepareImageRequest(body);assert.equal(prepared.size,'1536x1024');assert.deepEqual([body.composition.width,body.composition.height],[1536,1024]);assert.deepEqual([body.areaMasks[0].image.width,body.areaMasks[0].image.height],[1536,1024]);assert.equal(body.project.imageOutput.aspect,'9:16');assert.equal(await page.evaluate(key=>localStorage.getItem(key),IMAGE_ASPECT_PREFERENCE_KEY),'9:16');
  await page.screenshot({path:qa+'/selected-area-keeps-canvas.png'});
});

test('large exact edit canvases show their requested ratio and experimental-size warning before generation',async()=>{
  await load(await selectedEdit(1920,2560));assert.match(await page.locator('#imageOutputSummary').innerText(),/1920 × 2560 px \(3:4\).*Edit canvas kept exactly/);assert.equal(await page.locator('#imageOutputExperimental').isVisible(),true);assert.match(await page.locator('#imageOutputExperimental').innerText(),/Experimental.*3,686,400/);assert.equal(await page.locator('#generate').isDisabled(),false);assert.equal(requests.length,0);
  await page.setViewportSize({width:1024,height:768});const warning=await page.locator('#imageOutputExperimental').boundingBox(),composer=await page.locator('.composer').boundingBox();assert(warning.y>=composer.y&&warning.y+warning.height<=composer.y+composer.height&&warning.x+warning.width<=1024,'The warning remains visible inside the composer.');await page.locator('.composer').screenshot({path:qa+'/experimental-size-before-generation.png'});
});

test('an unsupported exact edit canvas blocks generation without offering a silent resize',async()=>{
  await load(await selectedEdit(941,1672));assert.equal(await page.locator('#imageOutputAspect').inputValue(),'canvas');assert.equal(await page.locator('#imageOutputAspect').isDisabled(),true);assert.equal(await page.locator('#generate').isDisabled(),true);assert.match(await page.locator('#imageQualityMessage').innerText(),/canvas|dimensions|multiple|exact/i);assert.equal(requests.length,0);
});

test('a mismatched returned image gets an explicit warning and downloads unchanged',async()=>{
  await load(references());mismatch=true;await generate();await page.locator('#imageGenerationResult').click();await page.locator('#desktopImageResultDialog').waitFor({state:'visible'});
  assert.match(await page.locator('#desktopImageResultTitle').innerText(),/dimensions/);assert.match(await page.locator('[data-image-result-status]').innerText(),/384 × 216/);assert.match(await page.locator('[data-image-result-info]').innerText(),/384 × 216/);
  const pending=page.waitForEvent('download');await page.locator('[data-image-result-download]').click();const stream=await(await pending).createReadStream(),chunks=[];for await(const part of stream)chunks.push(part);const bytes=Buffer.concat(chunks);assert.equal(bytes.readUInt32BE(16),384);assert.equal(bytes.readUInt32BE(20),216);assert.equal(bytes.toString('base64'),landscape.split(',')[1]);
  await page.screenshot({path:qa+'/output-mismatch-warning.png'});
});
