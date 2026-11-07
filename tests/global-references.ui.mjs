import {test,before,after,beforeEach,afterEach} from 'node:test';
import assert from 'node:assert/strict';
import {mkdir,readFile,writeFile,access} from 'node:fs/promises';
import path from 'node:path';
import {chromium} from 'playwright';
import {createServer} from '../server.mjs';
import {prepareImageRequest} from '../desktop-image-request.mjs';

const qa=path.resolve('qa','global-references'),model='gpt-image-2.5-sunburst';
const baseline=process.env.ASUN_GLOBAL_REFS_BASELINE_DIR;
let server,browser,context,page,base,requests,errors;
const evidence=[];
before(async()=>{
  if(process.env.ASUN_GLOBAL_REFS_BASELINE && !baseline)throw new Error('Set ASUN_GLOBAL_REFS_BASELINE_DIR to a public-source directory containing editor.mjs and index.html, or unset ASUN_GLOBAL_REFS_BASELINE.');
  if(baseline)for(const file of ['editor.mjs','index.html'])await access(path.join(baseline,file)).catch(()=>{throw new Error(`ASUN_GLOBAL_REFS_BASELINE_DIR must contain ${file}.`);});
  await mkdir(qa,{recursive:true});
  server=createServer({detection:{token:'global-refs-qa',status:async()=>({available:false}),dispose(){}},sheets:{dispose(){}},images:{dispose(){}}});
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));base=`http://127.0.0.1:${server.address().port}`;
  browser=await chromium.launch({headless:true});
});
after(async()=>{await writeFile(path.join(qa,baseline?'baseline-report.json':'report.json'),JSON.stringify({paidCalls:0,baseline,evidence},null,2));await browser?.close();if(server)await new Promise(resolve=>server.close(resolve));});
beforeEach(async()=>{
  requests=[];errors=[];context=await browser.newContext({viewport:{width:1440,height:1000},acceptDownloads:true});
  await context.addInitScript(()=>localStorage.setItem('asun-image-appearance','dark'));
  await context.route('**/*',async route=>{
    const url=new URL(route.request().url()),json=(value,status=200)=>route.fulfill({status,contentType:'application/json',body:JSON.stringify(value)});
    if(url.origin!==base)return route.abort();
    if(baseline&&url.pathname==='/editor.mjs')return route.fulfill({contentType:'text/javascript',body:await readFile(path.join(baseline,'editor.mjs'),'utf8')});
    if(baseline&&url.pathname==='/')return route.fulfill({contentType:'text/html',body:await readFile(path.join(baseline,'index.html'),'utf8')});
    if(url.pathname==='/api/generation-queue/status')return json({error:'No real generation queue in UI test'},404);
    if(url.pathname==='/api/images/status')return json({configured:true,authenticated:true,models:[{id:model,label:'GPT Image 2.5 · Sunburst',available:true}],token:'qa-global-refs',message:'Isolated fake provider.'});
    if(url.pathname==='/api/images/generate'){
      assert.equal(route.request().method(),'POST');const body=route.request().postDataJSON();
      const prepared=prepareImageRequest(body);requests.push({body,prepared});return json({id:body.requestId,status:'running'});
    }
    if(url.pathname.startsWith('/api/images/jobs/'))return json({id:url.pathname.split('/').at(-1),status:'running'});
    if(url.pathname.startsWith('/api/sheets/'))return json({configured:false,authenticated:false,models:[],token:'qa-sheet',message:'No sheet provider in this test.'});
    return route.continue();
  });
  page=await context.newPage();page.on('pageerror',error=>errors.push(error.message));page.on('dialog',dialog=>dialog.accept());
  await page.goto(base);if(await page.locator('#skipStartup').isVisible())await page.locator('#skipStartup').click();
  await page.waitForFunction(()=>document.documentElement.dataset.ready==='true');
  await page.waitForFunction(model=>document.querySelector('#model')?.value===model,model);
});
afterEach(async info=>{
  try{if(info.error)await page.screenshot({path:path.join(qa,(baseline?'baseline-':'')+'failure-'+info.name.replace(/\W+/g,'-')+'.png')});evidence.push({name:info.name,passed:!info.error,error:info.error?.message,requests:requests.map(({body,prepared})=>({referenceCount:body.project.references.length,layerCount:body.project.layers.length,logicalInputCount:prepared.inputPacking?.logicalInputCount??prepared.images.length,physicalInputCount:prepared.images.length,model:prepared.model,quality:prepared.quality}))});assert.deepEqual(errors,[]);}
  finally{await context?.close();}
});
async function photos(count,offset=0){return page.evaluate(({count,offset})=>Array.from({length:count},(_,index)=>{const n=index+offset,c=document.createElement('canvas');c.width=120;c.height=80;const x=c.getContext('2d');x.fillStyle=`hsl(${n*31%360} 70% 50%)`;x.fillRect(0,0,120,80);x.fillStyle='#fff';x.font='20px sans-serif';x.fillText(String(n+1),12,45);return{name:`Global reference ${String(n+1).padStart(2,'0')}.png`,source:c.toDataURL('image/png')};}),{count,offset});}
const files=items=>items.map(item=>({name:item.name,mimeType:'image/png',buffer:Buffer.from(item.source.split(',')[1],'base64')}));
async function addUsingButton(items,selector='#addReference'){
  assert.equal(await page.locator(selector).isEnabled(),true,'Add photos must remain usable after every earlier import.');
  const chooser=page.waitForEvent('filechooser');await page.locator(selector).click();const selected=await chooser;
  assert.equal(selected.isMultiple(),true,'The visible Add photos button supports selecting many files.');await selected.setFiles(files(items));
  await page.waitForFunction(()=>!document.body.classList.contains('busy'));
}
async function count(expected){await page.waitForFunction(expected=>document.querySelectorAll('#referenceList .reference-card').length===expected&&!document.body.classList.contains('busy'),expected);}
async function generate(expected){
  await page.locator('#prompt').fill('Combine every supplied photo into one finished scene. Use all references; no numbered regions are needed.');await page.locator('#prompt').dispatchEvent('change');
  await page.locator('#imageQuality').selectOption('max');await page.waitForFunction(()=>!document.querySelector('#generate').disabled);
  await page.locator('#generate').click();for(let n=0;n<300&&!requests.length;n++)await page.waitForTimeout(50);
  assert.equal(requests.length,1);const {body,prepared}=requests[0];
  assert.equal(body.project.original,null);assert.deepEqual(body.project.layers,[],'Global references do not require or create a numbered region, detection or a canvas layer.');
  assert.deepEqual(body.project.references.map(ref=>ref.source),expected.map(ref=>ref.source),'All original reference bytes reach server preflight in their chosen order.');
  assert.equal(prepared.model,model);assert.equal(prepared.quality,'max');
  const refRoles=prepared.inputRoles.flatMap(role=>role.role==='reference input board'?role.tiles||[]:[role]);
  assert.equal(prepared.inputPacking?.logicalInputCount??prepared.images.length,expected.length);
  assert.ok(prepared.images.length<=16,'Provider file limit is respected by labeled packing, not lost references.');
  assert.doesNotMatch(prepared.prompt,/Use the attached references for this numbered area/);
  return {body,prepared,refRoles};
}
test('real Add photos picker remains usable for a second global image and Sunburst receives both without regions',async()=>{
  const items=await photos(2);await addUsingButton(items.slice(0,1));await count(1);
  await addUsingButton(items.slice(1));await count(2);assert.equal(await page.locator('#addReference').isEnabled(),true);
  const {prepared}=await generate(items);assert.equal(prepared.images.length,2);assert.equal(prepared.inputPacking,undefined);
  assert.deepEqual(prepared.inputRoles.map(role=>role.scope),['global prompt','global prompt']);
  await page.screenshot({path:path.join(qa,'two-global-references.png')});
});

test('twenty references can be selected together and more dropped into the bottom tray without touching the canvas',async()=>{
  const items=await photos(22);await addUsingButton(items.slice(0,20));await count(20);
  const drop=await page.locator('.reference-section').evaluate((zone,items)=>{const transfer=new DataTransfer();for(const item of items){const bytes=Uint8Array.from(atob(item.source.split(',')[1]),c=>c.charCodeAt(0));transfer.items.add(new File([bytes],item.name,{type:'image/png'}));}const over=new DragEvent('dragover',{bubbles:true,cancelable:true,dataTransfer:transfer});zone.dispatchEvent(over);const event=new DragEvent('drop',{bubbles:true,cancelable:true,dataTransfer:transfer});zone.dispatchEvent(event);return{over:over.defaultPrevented,drop:event.defaultPrevented};},items.slice(20));
  assert.deepEqual(drop,{over:true,drop:true},'The References tray accepts file drops.');await count(22);
  assert.equal(await page.locator('.layer-row').count(),0);assert.equal(await page.locator('#addReference').isEnabled(),true);
  assert.equal(await page.locator('#viewAllReferences').isVisible(),true);await page.locator('#viewAllReferences').click();await page.locator('#composerReferencesDialog').waitFor({state:'visible'});
  assert.equal(await page.locator('#composerReferencesDialog img').count(),22,'The expanded page exposes every added reference.');
  await page.screenshot({path:path.join(qa,'twenty-two-global-references.png')});
  await page.keyboard.press('Escape');await page.locator('#composerReferencesDialog').waitFor({state:'hidden'});
  const {prepared}=await generate(items);assert.equal(prepared.inputPacking.logicalInputCount,22);assert.ok(prepared.inputPacking.boardCount>0);
  const allIds=new Set(JSON.stringify(prepared.inputRoles).match(/[0-9a-f]{8}-[0-9a-f-]{27}/g)||[]);for(const ref of requests[0].body.project.references)assert.ok(allIds.has(ref.id),'Every selected reference retains a role in the packed request.');
  for(const width of [1280,1050]){
    await page.setViewportSize({width,height:820});assert.equal(await page.locator('#referenceCount').isVisible(),true);assert.equal(await page.locator('#viewAllReferences').isVisible(),true);
    const boxes=await page.evaluate(()=>['.reference-section','.prompt-section','.model-section','.generate-section'].map(selector=>{const b=document.querySelector(selector).getBoundingClientRect();return{x:b.x,right:b.right,width:b.width};}));
    for(let n=0;n<boxes.length-1;n++)assert.ok(boxes[n].right<=boxes[n+1].x+1,`${width}px composer sections do not overlap.`);
    assert.ok(boxes.at(-1).right<=width,`${width}px Generate stays on screen.`);
    const controls=await page.evaluate(()=>['#referenceCount','#viewAllReferences','#addReference','#pasteComposerReferences'].map(selector=>{const b=document.querySelector(selector).getBoundingClientRect(),p=document.querySelector('.reference-section').getBoundingClientRect();return{selector,inside:b.x>=p.x-1&&b.right<=p.right+1};}));
    assert.ok(controls.every(control=>control.inside),`${width}px reference controls fit their section: ${JSON.stringify(controls)}`);
  }
  await page.screenshot({path:path.join(qa,'references-tray-1050.png')});
});

test('an invalid reference import keeps the picker usable and does not discard existing photos',async()=>{
  const items=await photos(2);await addUsingButton(items.slice(0,1));await count(1);
  const chooser=page.waitForEvent('filechooser');await page.locator('#addReference').click();await(await chooser).setFiles({name:'Broken.png',mimeType:'image/png',buffer:Buffer.from('not an image')});
  await page.waitForFunction(()=>!document.body.classList.contains('busy'));await count(1);assert.equal(await page.locator('#addReference').isEnabled(),true);
  await addUsingButton(items.slice(1));await count(2);await generate(items);
});

test('the full gallery removes and adds photos and all originals survive saving and reopening the native project',async()=>{
  const items=await photos(22);await addUsingButton(items.slice(0,20));await count(20);await page.locator('#viewAllReferences').click();
  await page.locator('#composerReferencesDialog').waitFor({state:'visible'});
  await page.locator('#composerReferenceGallery .composer-reference-photo').nth(19).getByRole('button',{name:/Remove generation reference/}).click();await count(19);
  assert.equal(await page.locator('#composerReferenceGallery .composer-reference-photo').count(),19);
  await addUsingButton(items.slice(20),'#addComposerReferencePhotos');await count(21);assert.equal(await page.locator('#composerReferenceGallery img').count(),21);
  await page.locator('#doneComposerReferences').click();await page.locator('#composerReferencesDialog').waitFor({state:'hidden'});
  const pending=page.waitForEvent('download');await page.locator('#saveProject').click();const entry=await pending,stream=await entry.createReadStream(),chunks=[];for await(const chunk of stream)chunks.push(chunk);const bytes=Buffer.concat(chunks),project=JSON.parse(bytes.toString());
  const expected=[...items.slice(0,19),...items.slice(20)];assert.deepEqual(project.references.map(ref=>ref.source),expected.map(ref=>ref.source));assert.deepEqual(project.layers,[]);
  await page.waitForFunction(()=>!document.body.classList.contains('busy'));await page.locator('#newWorkflowTab').click();await count(0);
  await page.locator('#projectInput').setInputFiles({name:'Global references.asun',mimeType:'application/json',buffer:bytes});await count(21);
  await page.locator('#viewAllReferences').click();assert.equal(await page.locator('#composerReferenceGallery img').count(),21);await page.locator('#doneComposerReferences').click();
  await generate(expected);
});

test('tray keyboard paste and both explicit paste buttons append photos only to generation references',async()=>{
  const items=await photos(6);
  const prevented=await page.locator('.reference-section').evaluate((zone,items)=>{const transfer=new DataTransfer();for(const item of items){const bytes=Uint8Array.from(atob(item.source.split(',')[1]),c=>c.charCodeAt(0));transfer.items.add(new File([bytes],item.name,{type:'image/png'}));}const event=new ClipboardEvent('paste',{bubbles:true,cancelable:true,clipboardData:transfer});zone.dispatchEvent(event);return event.defaultPrevented;},items.slice(0,2));
  assert.equal(prevented,true);await count(2);assert.equal(await page.locator('.layer-row').count(),0);
  async function clipboardPhotos(selected){await page.evaluate(items=>{Object.defineProperty(navigator,'clipboard',{configurable:true,value:{read:async()=>items.map(item=>({types:['image/png'],getType:async()=>new Blob([Uint8Array.from(atob(item.source.split(',')[1]),c=>c.charCodeAt(0))],{type:'image/png'})}))}});},selected);}
  await clipboardPhotos(items.slice(2,4));await page.locator('#pasteComposerReferences').click();await count(4);
  await page.locator('#viewAllReferences').click();await clipboardPhotos(items.slice(4));await page.locator('#pasteComposerReferencePhotos').click();await count(6);
  assert.equal(await page.locator('#composerReferenceGallery img').count(),6);await page.locator('#doneComposerReferences').click();assert.equal(await page.locator('.layer-row').count(),0);
  await generate(items);
});
