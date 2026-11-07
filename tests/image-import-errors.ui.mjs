import {test,before,after,beforeEach,afterEach} from 'node:test';
import assert from 'node:assert/strict';
import {mkdir,writeFile} from 'node:fs/promises';
import path from 'node:path';
import {chromium} from 'playwright';
import {createServer} from '../server.mjs';

const qa=path.resolve('qa/image-import-errors'),report={paidCalls:0,cases:[]};
let server,browser,context,page,base,errors,mutations,expectedMutations,webImports,photo;
before(async()=>{await mkdir(qa,{recursive:true});server=createServer({detection:{status:async()=>({available:false}),dispose(){}},sheets:{dispose(){}},images:{dispose(){}}});await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));base=`http://127.0.0.1:${server.address().port}`;browser=await chromium.launch({headless:true});});
after(async()=>{await writeFile(path.join(qa,'report.json'),JSON.stringify(report,null,2));await browser?.close();await new Promise(resolve=>server.close(resolve));});
beforeEach(async()=>{
  errors=[];mutations=[];expectedMutations=[];webImports=[];context=await browser.newContext({viewport:{width:1440,height:1000},acceptDownloads:true});page=await context.newPage();page.on('pageerror',error=>errors.push(error.message));
  await context.route('**/*',async route=>{const request=route.request(),url=new URL(request.url());if(url.origin!==base){errors.push('External request: '+url.origin);return route.abort();}if(!url.pathname.startsWith('/api/'))return route.continue();if(request.method()!=='GET')mutations.push(url.pathname);if(url.pathname==='/api/sheet-photo-import'){webImports.push(request.postDataJSON());return route.fulfill({json:{source:photo,name:'Recovered web.png',width:320,height:240,mime:'image/png'}});}if(url.pathname==='/api/generation-queue/status')return route.fulfill({json:{items:[],counts:{queued:0,running:0},concurrency:1}});return route.fulfill({json:{configured:false,authenticated:false,available:false,token:'import-qa',models:[],items:[],message:'Image-import QA; providers disabled.'}});});
  await page.goto(base);await page.waitForFunction(()=>document.documentElement.dataset.ready==='true');if(await page.locator('#skipStartup').isVisible())await page.locator('#skipStartup').click();
  photo=await page.evaluate(()=>{const canvas=document.createElement('canvas');canvas.width=320;canvas.height=240;const c=canvas.getContext('2d');c.fillStyle='#e8e0ce';c.fillRect(0,0,320,240);c.fillStyle='#418891';c.fillRect(60,35,200,170);return canvas.toDataURL('image/png');});
});
afterEach(async info=>{try{if(info.error)await page.screenshot({path:path.join(qa,'failure-'+info.name.replace(/\W+/g,'-')+'.png')});report.cases.push({name:info.name,passed:!info.error,error:info.error?.message});assert.deepEqual(errors,[]);assert.deepEqual(mutations,expectedMutations,'Only the specifically stubbed web-image import may post; generation never runs.');}finally{await context?.close();}});
const valid=(name='Valid.png')=>({name,type:'image/png',base64:photo.split(',')[1]});
const folder=(api='webkitGetAsEntry')=>({name:'Blender blockout',folder:true,api});
async function idle(){await page.waitForFunction(()=>!document.body.classList.contains('busy'));}
async function load(){await page.locator('#imageInput').setInputFiles({name:'Original.png',mimeType:'image/png',buffer:Buffer.from(photo.split(',')[1],'base64')});await page.waitForFunction(()=>document.querySelectorAll('.layer-row').length===1&&!document.body.classList.contains('busy'));}
async function save(){await idle();const pending=page.waitForEvent('download');await page.locator('#saveProject').click();const download=await pending,stream=await download.createReadStream(),chunks=[];for await(const chunk of stream)chunks.push(chunk);await page.waitForTimeout(725);return JSON.parse(Buffer.concat(chunks).toString());}
async function drop(selector,files){return page.locator(selector).evaluate((target,files)=>{
  const transfer=new DataTransfer(),items=[];for(const file of files){const bytes=file.base64?Uint8Array.from(atob(file.base64),char=>char.charCodeAt(0)):new Uint8Array(file.size||0),item=transfer.items.add(new File([bytes],file.name,{type:file.type||''}));if(file.folder)Object.defineProperty(item,file.api,{value:()=>({isDirectory:true,isFile:false,name:file.name})});items.push(item);}
  // Chromium creates new item wrappers on each items[index] access. Preserve
  // these mocked entry readers while retaining a real DataTransfer/FileList.
  Object.defineProperty(transfer,'items',{value:items});
  const event=new DragEvent('drop',{bubbles:true,cancelable:true,dataTransfer:transfer});target.dispatchEvent(event);return{prevented:event.defaultPrevented,count:transfer.files.length};
},files);}
async function dropRecoverable(selector,kind){return page.locator(selector).evaluate((target,{kind,source})=>{
  const transfer=new DataTransfer(),placeholder=new File([],'Blender blockout'),actual=new File([Uint8Array.from(atob(source.split(',')[1]),char=>char.charCodeAt(0))],'Blender blockout',{type:'image/png'}),item=transfer.items.add(placeholder);
  if(kind==='item')Object.defineProperty(item,'getAsFile',{value:()=>actual});
  if(kind==='entry')Object.defineProperty(item,'webkitGetAsEntry',{value:()=>({isFile:true,isDirectory:false,name:actual.name,file:resolve=>setTimeout(()=>resolve(actual),0)})});
  if(kind==='html')transfer.setData('text/html',`<img src="${source}" alt="Blender blockout">`);
  if(kind==='url')transfer.setData('text/uri-list','https://images.example.test/blockout.png');
  // The shell/browser may expose an empty FileList placeholder while its item
  // reader, file entry, or HTML image contains the actual image bytes.
  Object.defineProperty(transfer,'items',{value:[item]});
  const event=new DragEvent('drop',{bubbles:true,cancelable:true,dataTransfer:transfer});target.dispatchEvent(event);return{prevented:event.defaultPrevented,placeholderBytes:transfer.files[0].size};
},{kind,source:photo});}
async function errorAt(selector,pattern){await page.waitForFunction(({selector,pattern})=>new RegExp(pattern,'i').test(document.querySelector(selector)?.textContent||''),{selector,pattern});await idle();return page.locator(selector).innerText();}
async function point(x,y){const rect=await page.locator('#board').boundingBox();return{x:rect.x+x*rect.width/320,y:rect.y+y*rect.height/240};}
async function draw(){await page.locator('[data-tool=pencil]').first().click();const start=await point(70,80),end=await point(180,110);await page.mouse.move(start.x,start.y);await page.mouse.down();await page.mouse.move(end.x,end.y,{steps:6});await page.mouse.up();await page.waitForFunction(()=>document.querySelectorAll('.layer-row').length===2);}
async function label(){await page.locator('#addText').click();const p=await point(120,80);await page.mouse.click(p.x,p.y);await page.locator('#textEditor').fill('1');await page.locator('#textEditor').press('Enter');await page.locator('#textEditor').waitFor({state:'hidden'});}
async function openSheet(){await page.locator('#characterItemSheet').click();await page.locator('#asunSheetCreator').waitFor({state:'visible'});}
async function closeSheet(){await page.locator('[data-sheet-action=close]').click();await page.locator('#asunSheetCreator').waitFor({state:'hidden'});}

test('a folder dropped on an empty canvas is identified as a folder and leaves the draft empty',async()=>{
  const before=await save();assert.equal((await drop('#stage',[folder()])).prevented,true);const message=await errorAt('#toast','is a folder');assert.match(message,/Blender blockout/);assert.doesNotMatch(message,/under 50 MB/);assert.equal(await page.locator('#dropHint').isVisible(),false);assert.deepEqual(await save(),before);assert.equal(await page.locator('#undo').isDisabled(),true);await page.screenshot({path:path.join(qa,'folder-not-file-size.png')});
});

test('mixed valid-image and directory drops reject the whole batch and preserve prior edits and Undo',async()=>{
  await load();await page.locator('#prompt').fill('Keep the original scene and this instruction.');await page.locator('#prompt').dispatchEvent('change');const beforeDrawing=await save();await draw();const before=await save(),history=await page.locator('#historyList').innerText();
  await drop('#stage',[valid('Would otherwise import.png'),folder('getAsEntry')]);await errorAt('#toast','is a folder');assert.deepEqual(await save(),before);assert.equal(await page.locator('#historyList').innerText(),history);assert.equal(await page.locator('.layer-row').count(),2);
  await page.locator('#undo').click();await page.waitForFunction(()=>document.querySelectorAll('.layer-row').length===1);assert.deepEqual(await save(),beforeDrawing,'Undo still restores the user’s previous edit, not a partially imported batch.');
});

test('empty, unreadable and oversized inputs have distinct messages while extensionless PNG files still import',async()=>{
  await page.locator('#imageInput').setInputFiles({name:'Empty.png',mimeType:'image/png',buffer:Buffer.alloc(0)});const empty=await errorAt('#toast','empty \\(0 bytes\\)');assert.doesNotMatch(empty,/under 50 MB/);assert.equal(await page.locator('.layer-row').count(),0);
  await drop('#stage',[{name:'Too large.png',type:'image/png',size:50*1024*1024+1}]);const oversized=await errorAt('#toast','under 50 MB');assert.match(oversized,/image is .* MB/i);assert.equal(await page.locator('.layer-row').count(),0);
  const unreadable=await page.evaluate(async()=>{try{await(await import('/image-source.mjs')).readOriginalImage({name:'Image descriptor',source:'data:image/png;base64,iVBORw0KGgo='});return '';}catch(error){return error.message;}});assert.match(unreadable,/not a readable image file/);assert.doesNotMatch(unreadable,/under 50 MB/);
  await drop('#stage',[valid('Blender blockout')]);await page.waitForFunction(()=>document.querySelectorAll('.layer-row').length===1&&!document.body.classList.contains('busy'));const saved=await save();assert.equal(saved.assets[saved.original.assetId].source,photo);assert.equal(saved.assets[saved.original.assetId].originalFile.name,'Blender blockout');
});

test('the full References dialog rejects folders without losing its existing photo, comment or draft',async()=>{
  await load();await label();await page.locator('#linkReference').click();await page.locator('#referenceDialog').waitFor({state:'visible'});await page.locator('#referenceFileInput').setInputFiles({name:'Reference.png',mimeType:'image/png',buffer:Buffer.from(photo.split(',')[1],'base64')});await page.waitForFunction(()=>document.querySelector('#referenceName').textContent==='Reference.png'&&!document.body.classList.contains('busy'));await page.locator('#labelComment').fill('Keep this exact reference and comment.');await page.locator('#saveReferenceLink').click();await page.locator('#referenceDialog').waitFor({state:'hidden'});const before=await save();
  await page.locator('#linkReference').click();await page.locator('#referenceDialog').waitFor({state:'visible'});await drop('#referenceDropZone',[valid('Not added.png'),folder()]);await errorAt('#referenceDialogError','is a folder');assert.equal(await page.locator('#referenceName').innerText(),'Reference.png');assert.equal(await page.locator('#labelComment').inputValue(),'Keep this exact reference and comment.');assert.equal(await page.locator('#referenceDropZone').evaluate(element=>element.classList.contains('is-dragover')),false);await page.locator('#cancelReferenceLink').click();await page.locator('#referenceDialog').waitFor({state:'hidden'});assert.deepEqual(await save(),before);
});

test('main image search rejects a directory drop in place and preserves the original canvas',async()=>{
  await load();const before=await save();await page.locator('#searchMainImages').click();await page.locator('#mainImageSearchDialog').waitFor({state:'visible'});await drop('#mainImageSearchDialog',[valid('Not imported.png'),folder()]);await errorAt('#mainImageSearchError','is a folder');assert.equal(await page.locator('#mainImageSearchDialog').isVisible(),true);assert.equal(await page.locator('.layer-row').count(),1);await page.locator('#closeMainImageSearch').click();await page.locator('#mainImageSearchDialog').waitFor({state:'hidden'});assert.deepEqual(await save(),before);
});

test('sheet subject and detail drop zones both reject directories without partial imports',async()=>{
  await load();await openSheet();await page.locator('[data-sheet-notes]').fill('Only the building.');await closeSheet();const before=await save();await openSheet();
  for(const role of ['subjects','details']){await drop(`[data-sheet-drop="${role}"]`,[valid('Must not add '+role+'.png'),folder(role==='subjects'?'getAsEntry':'webkitGetAsEntry')]);await errorAt('[data-sheet-status]','is a folder');assert.equal(await page.locator('[data-sheet-photo]').count(),1);assert.equal(await page.locator('[data-sheet-reference]').count(),0);assert.equal(await page.locator('[data-sheet-notes]').inputValue(),'Only the building.');}
  await closeSheet();assert.deepEqual(await save(),before);
});

for(const kind of ['item','entry','html','url'])test(`canvas drop recovers the real image from ${kind} data when FileList contains a zero-byte placeholder`,async()=>{
  if(kind==='url')expectedMutations=['/api/sheet-photo-import'];assert.deepEqual(await dropRecoverable('#stage',kind),{prevented:true,placeholderBytes:0});await page.waitForFunction(()=>document.querySelectorAll('.layer-row').length===1&&!document.body.classList.contains('busy'));const saved=await save();assert.equal(saved.assets[saved.original.assetId].source,photo);assert.equal(await page.locator('#mainImageSearchDialog').isVisible(),false);assert.deepEqual(webImports,kind==='url'?[{url:'https://images.example.test/blockout.png'}]:[]);if(kind==='item'||kind==='url')await page.screenshot({path:path.join(qa,`${kind}-placeholder-recovered.png`)});
});

test('References accepts readable item bytes despite an empty shell file placeholder',async()=>{
  await load();await label();await page.locator('#linkReference').click();await page.locator('#referenceDialog').waitFor({state:'visible'});await dropRecoverable('#referenceDropZone','item');await page.waitForFunction(()=>document.querySelector('#referenceName').textContent==='Blender blockout'&&!document.body.classList.contains('busy'));await page.locator('#labelComment').fill('Use the dropped reference.');await page.locator('#saveReferenceLink').click();await page.locator('#referenceDialog').waitFor({state:'hidden'});const saved=await save();const original=saved.assets[saved.original.assetId];assert.equal(original.source,photo);assert.equal(saved.references.length,1);assert.equal(saved.references[0].source,photo);
});

test('main image search accepts embedded HTML image bytes despite an empty browser file placeholder',async()=>{
  await page.locator('#searchMainImages').click();await page.locator('#mainImageSearchDialog').waitFor({state:'visible'});await dropRecoverable('#mainImageSearchDialog','html');await page.waitForFunction(()=>document.querySelectorAll('.layer-row').length===1&&!document.body.classList.contains('busy'));await page.locator('#mainImageSearchDialog').waitFor({state:'hidden'});const saved=await save();assert.equal(saved.assets[saved.original.assetId].source,photo);
});

test('sheet subject and detail drop zones recover readable file entries from zero-byte placeholders',async()=>{
  await openSheet();await dropRecoverable('[data-sheet-drop="subjects"]','entry');await page.waitForFunction(()=>document.querySelectorAll('[data-sheet-photo]').length===1&&!document.querySelector('#asunSheetCreator').classList.contains('is-busy'));await dropRecoverable('[data-sheet-drop="details"]','entry');await page.waitForFunction(()=>document.querySelectorAll('[data-sheet-reference]').length===1&&!document.querySelector('#asunSheetCreator').classList.contains('is-busy'));await closeSheet();const saved=await save();assert.equal(saved.assets[saved.original.assetId].source,photo);assert.equal(saved.references.length,1);assert.equal(saved.references[0].source,photo);
});
