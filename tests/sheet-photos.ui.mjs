import {test,before,after,beforeEach,afterEach} from 'node:test';
import assert from 'node:assert/strict';
import {mkdir,writeFile} from 'node:fs/promises';
import {inflateRawSync} from 'node:zlib';
import path from 'node:path';
import {chromium} from 'playwright';
import {createServer} from '../server.mjs';
import {getSheetInputPhotos,getSheetPhoto} from '../public/sheet-preset.mjs';
import {prepareSheetRequest} from '../desktop-sheet-service.mjs';

const qa=path.resolve('qa','desktop-sheet-photos');
let browser,server,base,context,page,errors,requests,imports,fixtures;
const report=[];
before(async()=>{
  await mkdir(qa,{recursive:true});
  server=createServer({detection:{status:async()=>({available:false}),dispose(){}},sheets:{dispose(){}},images:{dispose(){}}});
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));base=`http://127.0.0.1:${server.address().port}`;
  browser=await chromium.launch({headless:true});
});
after(async()=>{
  await writeFile(path.join(qa,'report.json'),JSON.stringify({kind:'mocked-provider-sheet-photo-ui',paidCalls:0,cases:report},null,2));
  await browser?.close();if(server)await new Promise(resolve=>server.close(resolve));
});
beforeEach(async()=>{
  errors=[];requests=[];imports=[];fixtures={};
  context=await browser.newContext({viewport:{width:1440,height:1000},acceptDownloads:true});
  await context.grantPermissions(['clipboard-read','clipboard-write'],{origin:base});
  await context.route('**/*',async route=>{
    const url=new URL(route.request().url());
    const json=body=>route.fulfill({status:200,contentType:'application/json',body:JSON.stringify(body)});
    if(url.origin!==base)return route.fulfill({status:200,contentType:'text/html',body:'<title>Search navigation QA</title>'});
    // This fixture models per-job polling; never read the machine's real queue.
    if(url.pathname==='/api/generation-queue/status')return route.fulfill({status:404,contentType:'application/json',body:JSON.stringify({error:'Use isolated per-job fixture status.'})});
    if(url.pathname==='/api/images/status')return json({configured:false,authenticated:false,models:[],token:'qa-image',message:'Main generation unused in sheet-photo QA.'});
    if(url.pathname==='/api/images/generate'){errors.push('Unexpected main image generation');return route.fulfill({status:403,body:'Blocked by QA'});}
    if(url.pathname==='/api/sheets/status')return json({configured:true,authenticated:true,models:[{id:'gpt-image-2.5-sunburst',label:'GPT Image 2.5 · Sunburst',available:true}],token:'qa-sheet',message:'QA provider connected.'});
    if(url.pathname==='/api/sheets/generate'){const body=route.request().postDataJSON();requests.push(body);return json({id:body.requestId,status:'running'});}
    if(url.pathname.startsWith('/api/sheets/jobs/'))return json({id:url.pathname.split('/').at(-1),status:'completed',image:{source:fixtures.result,width:200,height:140,name:'Simulated sheet.png'}});
    if(url.pathname==='/api/sheet-photo-import'){const input=route.request().postDataJSON();imports.push(input);if(input.url.endsWith('/page'))return route.fulfill({status:400,contentType:'application/json',body:JSON.stringify({error:'This address is a web page, not a photo. Use Copy image, then Paste photos.'})});return json({source:fixtures.web,width:200,height:140,name:'Web image.png',mimeType:'image/png'});}
    await route.continue();
  });
  page=await context.newPage();page.on('pageerror',error=>errors.push(error.message));
  await page.goto(base);await page.waitForFunction(()=>document.documentElement.dataset.ready==='true');
  if(await page.locator('#skipStartup').isVisible())await page.locator('#skipStartup').click();
  for(const [name,color]of [['original','#a77742'],['front','#489983'],['side','#6574ab'],['detail','#e39c39'],['extra','#936996'],['web','#a74370'],['result','#b5c7c3']])fixtures[name]=await makePhoto(color);
});
afterEach(async info=>{
  try{
    if(info.error)await page.screenshot({path:path.join(qa,'failure-'+info.name.replace(/\W+/g,'-')+'.png')});
    assert.deepEqual(errors,[]);for(const request of requests)prepareSheetRequest(request);
    report.push({name:info.name,passed:!info.error,generationRequests:requests.length,remoteImports:imports.length});
  }finally{await context?.close();}
});
async function makePhoto(color){return page.evaluate(color=>{const c=document.createElement('canvas');c.width=200;c.height=140;const x=c.getContext('2d');x.fillStyle='#f3eadb';x.fillRect(0,0,200,140);x.fillStyle=color;x.fillRect(35,20,130,100);return c.toDataURL('image/png');},color);}
const file=(key,name)=>({name,mimeType:'image/png',buffer:Buffer.from(fixtures[key].split(',')[1],'base64')});
async function idle(){await page.waitForFunction(()=>document.querySelector('#asunSheetCreator')?.getAttribute('aria-busy')!=='true'&&!document.body.classList.contains('busy'));}
async function open(){await page.locator('#characterItemSheet').click();await page.locator('#asunSheetCreator').waitFor({state:'visible'});await page.waitForFunction(()=>document.querySelector('[data-sheet-model]')?.value==='gpt-image-2.5-sunburst');}
async function main(){await page.locator('#imageInput').setInputFiles(file('original','Original scene.png'));await page.waitForFunction(()=>document.querySelectorAll('.layer-row').length===1&&!document.body.classList.contains('busy'));}
async function downloaded(pending){const item=await pending,stream=await item.createReadStream(),chunks=[];for await(const chunk of stream)chunks.push(chunk);return{name:item.suggestedFilename(),buffer:Buffer.concat(chunks)};}
async function saveProject(){const pending=page.waitForEvent('download');await page.locator('#saveProject').click();const saved=await downloaded(pending);await page.waitForTimeout(725);return{...saved,project:JSON.parse(saved.buffer.toString())};}
async function closeSheet(){await page.locator('[data-sheet-action="close"]').click();await page.locator('#asunSheetCreator').waitFor({state:'hidden'});}
async function upload(role,files){await page.locator(role==='subjects'?'[data-sheet-source-input]':'[data-sheet-reference-input]').setInputFiles(files);await idle();}
async function drop(role,files){
  await page.locator(`[data-sheet-drop="${role}"]`).evaluate((element,files)=>{const transfer=new DataTransfer();for(const file of files){const raw=atob(file.base64),bytes=Uint8Array.from(raw,character=>character.charCodeAt(0));transfer.items.add(new File([bytes],file.name,{type:'image/png'}));}element.dispatchEvent(new DragEvent('drop',{bubbles:true,cancelable:true,dataTransfer:transfer}));},files.map(item=>({name:item.name,base64:item.buffer.toString('base64')})));await idle();
}
async function clipboardPhoto(key){return page.evaluate(async source=>{const bytes=Uint8Array.from(atob(source.split(',')[1]),character=>character.charCodeAt(0));const blob=new Blob([bytes],{type:'image/png'});await navigator.clipboard.write([new ClipboardItem({'image/png':blob})]);const [item]=await navigator.clipboard.read(),actual=await item.getType('image/png');return 'data:image/png;base64,'+btoa(String.fromCharCode(...new Uint8Array(await actual.arrayBuffer())));},fixtures[key]);}
const photoDialog=()=>page.locator('[data-sheet-photo-editor]');
const editorControl=name=>photoDialog().locator(`[data-ref-id="${name}"]`);
async function editPhoto(name){await page.locator('[data-sheet-photo]').filter({has:page.locator('img')}).filter({hasText:name}).first().click();await photoDialog().waitFor({state:'visible'});await editorControl('refCanvasBoard').waitFor({state:'visible'});}
async function editorPoint(x,y){const rect=await editorControl('refCanvasBoard').boundingBox();return{x:rect.x+x*rect.width/200,y:rect.y+y*rect.height/140};}
async function draw(tool='pencil'){await photoDialog().locator(`[data-ref-tool="${tool}"]`).click();const a=await editorPoint(45,45),b=await editorPoint(150,85);await page.mouse.move(a.x,a.y);await page.mouse.down();await page.mouse.move(b.x,b.y,{steps:8});await page.mouse.up();}
async function text(value,commit=true){await photoDialog().locator('[data-ref-tool="text"]').click();const p=await editorPoint(45,40);await page.mouse.click(p.x,p.y);await editorControl('refTextEditor').fill(value);if(commit){await editorControl('refTextEditor').press('Enter');await editorControl('refTextEditor').waitFor({state:'hidden'});}}
async function savePhoto(){await photoDialog().locator('[data-sheet-photo-save]').first().click();await photoDialog().waitFor({state:'hidden'});await idle();}
async function compareGuide(source,guide){return page.evaluate(async({source,guide})=>{async function pixels(src){const image=new Image();image.src=src;await image.decode();const canvas=document.createElement('canvas');canvas.width=image.naturalWidth;canvas.height=image.naturalHeight;const ctx=canvas.getContext('2d');ctx.drawImage(image,0,0);return{width:canvas.width,height:canvas.height,data:ctx.getImageData(0,0,canvas.width,canvas.height).data};}const a=await pixels(source),b=await pixels(guide);let changed=0;for(let i=0;i<a.data.length;i+=4)if(a.data.slice(i,i+4).some((value,j)=>Math.abs(value-b.data[i+j])>3))changed++;return{width:b.width,height:b.height,changed,total:a.width*a.height};},{source,guide});}
function unzip(zip){
  let end=zip.length-22;while(end>=Math.max(0,zip.length-65557)&&zip.readUInt32LE(end)!==0x06054b50)end--;assert.ok(end>=0);let cursor=zip.readUInt32LE(end+16);const entries=new Map();
  for(let count=zip.readUInt16LE(end+10);count>0;count--){assert.equal(zip.readUInt32LE(cursor),0x02014b50);const method=zip.readUInt16LE(cursor+10),size=zip.readUInt32LE(cursor+24),packed=zip.readUInt32LE(cursor+20),nameLength=zip.readUInt16LE(cursor+28),extraLength=zip.readUInt16LE(cursor+30),commentLength=zip.readUInt16LE(cursor+32),offset=zip.readUInt32LE(cursor+42),name=zip.subarray(cursor+46,cursor+46+nameLength).toString();const start=offset+30+zip.readUInt16LE(offset+26)+zip.readUInt16LE(offset+28),data=zip.subarray(start,start+packed),decoded=method===8?inflateRawSync(data):data;assert.equal(decoded.length,size);entries.set(name,decoded);cursor+=46+nameLength+extraLength+commentLength;}
  return entries;
}

test('batch subject and detail uploads keep every photo in its assigned role without changing the canvas',async()=>{
  await main();const before=(await saveProject()).project;await open();
  assert.equal(await page.locator('[data-sheet-source-input]').getAttribute('multiple'),'');
  await upload('subjects',[file('front','Front subject.png'),file('side','Side subject.png')]);
  await upload('details',[file('detail','Material detail.png'),file('extra','Accessory detail.png')]);
  await closeSheet();const after=(await saveProject()).project;assert.deepEqual(after.original,before.original);assert.deepEqual(after.layers,before.layers);assert.deepEqual(after.assets,before.assets);
  const inputs=getSheetInputPhotos(after);for(const name of ['Front subject.png','Side subject.png'])assert.ok(inputs.some(entry=>['main','subject'].includes(entry.role)&&entry.photo.name===name));
  for(const name of ['Material detail.png','Accessory detail.png'])assert.ok(inputs.some(entry=>entry.role==='reference'&&entry.photo.name===name));
  const all=[...Object.values(after.assets),...after.references];for(const [name,key]of [['Front subject.png','front'],['Side subject.png','side'],['Material detail.png','detail'],['Accessory detail.png','extra']])assert.equal(all.find(photo=>photo.name===name).source,fixtures[key]);
  await open();await page.screenshot({path:path.join(qa,'sheet-multiple-photos-light.png')});
});

test('a corrupt later subject photo cannot partially import the first photo into an empty project',async()=>{
  const before=(await saveProject()).project;
  assert.deepEqual(before.assets,{});assert.deepEqual(before.layers,[]);assert.deepEqual(before.references,[]);assert.equal(before.original,null);
  await open();
  // A real PNG signature with truncated image data exercises decoder failure,
  // rather than just the file picker or MIME filter.
  const corrupt={name:'Broken second photo.png',mimeType:'image/png',buffer:Buffer.from(fixtures.side.split(',')[1],'base64').subarray(0,24)};
  await upload('subjects',[file('front','Valid first photo.png'),corrupt]);
  await page.waitForFunction(()=>document.querySelector('[data-sheet-status]').classList.contains('is-error'));
  assert.match(await page.locator('[data-sheet-status]').textContent(),/Broken second photo\.png:.*No photos from this batch were added/);
  assert.equal(await page.locator('[data-sheet-photo]').count(),0);
  await closeSheet();const after=(await saveProject()).project;
  assert.deepEqual(after.assets,before.assets);assert.deepEqual(after.layers,before.layers);assert.deepEqual(after.references,before.references);assert.deepEqual(after.original,before.original);
  await open();await upload('subjects',[file('front','Valid first photo.png'),file('side','Valid second photo.png')]);
  assert.equal(await page.locator('[data-sheet-role="subject"]').count(),2);
  await closeSheet();const recovered=(await saveProject()).project;
  assert.equal(Object.keys(recovered.assets).length,1);assert.equal(recovered.references.length,1);
  assert.deepEqual(getSheetInputPhotos(recovered).map(({role,photo})=>[role,photo.name]),[['main','Valid first photo.png'],['subject','Valid second photo.png']]);
  assert.equal(requests.length,0);
});

test('batch drop zones and paste buttons add photos only to their chosen subject or detail role',async()=>{
  await main();await open();await drop('subjects',[file('front','Dropped front.png'),file('side','Dropped side.png')]);
  await drop('details',[file('detail','Dropped detail.png'),file('extra','Dropped accessory.png')]);
  const clipboard=await clipboardPhoto('web');await page.locator('[data-sheet-paste="details"]').click();await idle();
  const subjectClipboard=await clipboardPhoto('result');await page.locator('[data-sheet-paste="subjects"]').click();await idle();
  const keyboardClipboard=await clipboardPhoto('original');await page.locator('[data-sheet-drop="details"]').focus();await page.keyboard.press('Control+v');await idle();
  await closeSheet();const saved=(await saveProject()).project,inputs=getSheetInputPhotos(saved);
  assert.ok(inputs.some(entry=>entry.photo.name==='Dropped front.png'&&entry.role!=='reference'));assert.ok(inputs.some(entry=>entry.photo.name==='Dropped side.png'&&entry.role!=='reference'));
  assert.ok(inputs.some(entry=>entry.photo.name==='Dropped detail.png'&&entry.role==='reference'));assert.ok(inputs.some(entry=>entry.photo.name==='Dropped accessory.png'&&entry.role==='reference'));assert.ok(inputs.some(entry=>entry.photo.source===clipboard&&entry.role==='reference'));
  assert.ok(inputs.some(entry=>entry.photo.source===subjectClipboard&&entry.role==='subject'));assert.ok(inputs.some(entry=>entry.photo.source===keyboardClipboard&&entry.role==='reference'));
  assert.equal(saved.layers.length,1);assert.equal(saved.assets[saved.original.assetId].source,fixtures.original);
});

test('enlarged photo annotations and notes save separately, survive native reopen, and cancel safely',async()=>{
  await main();await open();await upload('subjects',[file('front','Annotated subject.png')]);await editPhoto('Annotated subject.png');
  for(const tool of ['move','pencil','highlight','text','pan'])assert.equal(await photoDialog().locator(`[data-ref-tool="${tool}"]`).isVisible(),true);
  await draw('pencil');await draw('highlight');await text('Use only this subject');await photoDialog().locator('[data-sheet-photo-notes]').fill('Use the left figure only. Ignore the background and any labels.');await savePhoto();
  await closeSheet();const saved=await saveProject(),subject=getSheetInputPhotos(saved.project).find(entry=>entry.photo.name==='Annotated subject.png').photo;
  assert.equal(subject.source,fixtures.front);assert.equal(subject.annotations.length,3);assert.match(subject.notes,/left figure only/);assert.equal(subject.annotations.find(layer=>layer.kind==='text').text.content,'Use only this subject');assert.equal(saved.project.layers.length,1);
  await page.locator('#projectInput').setInputFiles({name:saved.name,mimeType:'application/json',buffer:saved.buffer});await page.waitForFunction(()=>!document.body.classList.contains('busy'));await open();await editPhoto('Annotated subject.png');assert.match(await photoDialog().locator('[data-sheet-photo-notes]').inputValue(),/left figure only/);
  await draw('pencil');await photoDialog().locator('[data-sheet-photo-notes]').fill('Discard this note');await photoDialog().locator('[data-sheet-photo-cancel]').click();await photoDialog().waitFor({state:'hidden'});await closeSheet();
  const after=(await saveProject()).project,restored=getSheetPhoto(after,subject.id);assert.deepEqual(restored.annotations,subject.annotations);assert.equal(restored.notes,subject.notes);assert.equal(restored.source,subject.source);
});

test('generation and ZIP export include originals, edited photo guides and explicit subject notes',async()=>{
  await main();await open();await upload('subjects',[file('front','Front target.png'),file('side','Side target.png')]);await upload('details',[file('detail','Costume reference.png')]);
  await editPhoto('Front target.png');await text('This subject');await photoDialog().locator('[data-sheet-photo-notes]').fill('Choose only the central person. Keep the same face.');await savePhoto();
  await editPhoto('Costume reference.png');await draw('highlight');await photoDialog().locator('[data-sheet-photo-notes]').fill('Use the fabric color only.');await savePhoto();
  await page.locator('[data-sheet-drop="details"]').scrollIntoViewIfNeeded();await page.screenshot({path:path.join(qa,'sheet-detail-photos.png')});
  const pending=page.waitForEvent('download');await page.locator('[data-sheet-action="download"]').click();const pack=await downloaded(pending),entries=unzip(pack.buffer),mapping=JSON.parse(entries.get('sheet.json').toString());
  assert.ok(mapping.mainImages.length>=2);assert.equal(mapping.sheetReferences.length,1);assert.ok(mapping.generatedPreviews.length>=2);
  const contents=[...entries.values()];for(const key of ['front','side','detail'])assert.ok(contents.some(buffer=>buffer.equals(Buffer.from(fixtures[key].split(',')[1],'base64'))),`ZIP keeps exact ${key} source bytes.`);
  for(const guide of mapping.generatedPreviews){const baseImage='data:image/png;base64,'+entries.get(guide.originalPath).toString('base64'),preview='data:image/png;base64,'+entries.get(guide.path).toString('base64'),pixels=await compareGuide(baseImage,preview);assert.equal(pixels.width,200);assert.equal(pixels.height,140);assert.ok(pixels.changed>10&&pixels.changed<pixels.total*.8,'The exported guide visibly includes annotation pixels over its own photo.');}
  assert.match(entries.get('request.txt').toString(),/central person/);assert.match(entries.get('request.txt').toString(),/fabric color only/);
  await idle();await page.locator('[data-sheet-action="generate"]').click();await page.locator('[data-sheet-result-image]').waitFor({state:'visible'});await idle();assert.equal(requests.length,1);
  const prepared=prepareSheetRequest(requests[0]);assert.ok(requests[0].annotationPreviews.length>=2);assert.match(prepared.prompt,/central person/);assert.match(prepared.prompt,/fabric color only/);
  for(const key of ['front','side','detail'])assert.ok(prepared.images.some(image=>image.bytes.equals(Buffer.from(fixtures[key].split(',')[1],'base64'))));
  for(const guide of requests[0].annotationPreviews){const original=getSheetPhoto(requests[0].project,guide.id);const pixels=await compareGuide(original.source,guide.image.source);assert.ok(pixels.changed>10&&pixels.changed<pixels.total*.8);const exported=mapping.generatedPreviews.find(photo=>photo.photoId===guide.id);assert.equal(guide.image.source,'data:image/png;base64,'+entries.get(exported.path).toString('base64'));}
  assert.equal(requests[0].project.layers.length,1);assert.equal(requests[0].project.assets[requests[0].project.original.assetId].source,fixtures.original);
});

test('web search works in both sections and unsafe text drops do not execute or import',async()=>{
  await main();await open();
  for(const role of ['subjects','details']){
    await page.locator(`[data-sheet-search="${role}"]`).fill('blue ceramic bird reference');const popupPromise=page.waitForEvent('popup');await page.locator(`[data-sheet-web="${role}"]`).click();const popup=await popupPromise;await popup.waitForLoadState();assert.match(decodeURIComponent(popup.url()),/blue ceramic bird reference|blue\+ceramic\+bird\+reference/);await popup.close();
  }
  await page.locator('[data-sheet-drop="subjects"]').evaluate(element=>{const transfer=new DataTransfer();transfer.setData('text/uri-list','javascript:window.__sheetUnsafe=true');transfer.setData('text/html','<img src=x onerror="window.__sheetUnsafe=true">');element.dispatchEvent(new DragEvent('drop',{bubbles:true,cancelable:true,dataTransfer:transfer}));});await idle();
  assert.equal(imports.length,0);assert.equal(await page.evaluate(()=>window.__sheetUnsafe),undefined);assert.equal(await page.locator('img[src="x"]').count(),0);
  await closeSheet();const saved=(await saveProject()).project;assert.equal(saved.references.length,0);assert.equal(saved.layers.length,1);
});

test('direct web-image drops import safely and page URLs show actionable help without losing photos',async()=>{
  await main();await open();
  async function dropURL(role,url){await page.locator(`[data-sheet-drop="${role}"]`).evaluate((element,url)=>{const transfer=new DataTransfer();transfer.setData('text/uri-list',url);element.dispatchEvent(new DragEvent('drop',{bubbles:true,cancelable:true,dataTransfer:transfer}));},url);await idle();}
  await dropURL('subjects','https://images.example.test/bird.png');await page.locator('[data-sheet-photo]').filter({hasText:'Web image.png'}).waitFor();assert.deepEqual(imports,[{url:'https://images.example.test/bird.png'}]);
  const count=await page.locator('[data-sheet-photo]').count();await dropURL('details','https://images.example.test/page');await page.waitForFunction(()=>document.querySelector('[data-sheet-status]').textContent.includes('Copy image'));
  assert.equal(await page.locator('[data-sheet-photo]').count(),count);assert.match(await page.locator('[data-sheet-status]').innerText(),/web page, not a photo/);await closeSheet();const saved=(await saveProject()).project;assert.equal(saved.layers.length,1);assert.equal(saved.assets[saved.original.assetId].source,fixtures.original);assert.ok(getSheetInputPhotos(saved).some(entry=>entry.role!=='reference'&&entry.photo.source===fixtures.web));
});

test('pasting while editing notes or annotation text never adds an accidental photo',async()=>{
  await main();await open();await upload('subjects',[file('front','Clipboard subject.png')]);
  const before=await page.locator('[data-sheet-photo]').count();await clipboardPhoto('detail');await page.locator('[data-sheet-notes]').focus();await page.keyboard.press('Control+v');await idle();assert.equal(await page.locator('[data-sheet-photo]').count(),before);
  await editPhoto('Clipboard subject.png');await text('Keep ',false);await page.evaluate(()=>navigator.clipboard.writeText('the same face'));await editorControl('refTextEditor').press('Control+v');assert.equal(await editorControl('refTextEditor').inputValue(),'Keep the same face');await editorControl('refTextEditor').press('Enter');
  await clipboardPhoto('extra');await editorControl('refCanvasStage').focus();await page.keyboard.press('Control+v');await idle();assert.equal(await photoDialog().isVisible(),true);await savePhoto();assert.equal(await page.locator('[data-sheet-photo]').count(),before);
  await closeSheet();const saved=(await saveProject()).project;assert.equal(saved.references.length,1);assert.equal(saved.layers.length,1);
});

test('sheet photo editor and multi-photo sections remain usable at compact desktop size in both themes',async()=>{
  await main();await open();await upload('subjects',[file('front','UI subject.png'),file('side','UI side.png')]);await upload('details',[file('detail','UI detail.png')]);
  for(const theme of ['light','dark']){
    await page.evaluate(theme=>{document.documentElement.dataset.theme=theme;},theme);
    for(const width of [1440,1024]){
      await page.setViewportSize({width,height:850});const sheet=await page.locator('#asunSheetCreator').evaluate(element=>({scroll:element.scrollWidth,width:element.clientWidth}));assert.ok(sheet.scroll<=sheet.width+1);
      await editPhoto('UI subject.png');const bounds=await photoDialog().boundingBox();assert.ok(bounds.x>=0&&bounds.x+bounds.width<=width&&bounds.y>=0&&bounds.y+bounds.height<=850);
      for(const selector of ['[data-ref-tool="pencil"]','[data-ref-tool="highlight"]','[data-ref-tool="text"]','[data-sheet-photo-save]','[data-sheet-photo-cancel]']){const target=photoDialog().locator(selector).first();await target.scrollIntoViewIfNeeded();assert.equal(await target.isVisible(),true);}
      await page.screenshot({path:path.join(qa,`photo-editor-${theme}-${width}.png`)});await photoDialog().locator('[data-sheet-photo-cancel]').click();await photoDialog().waitFor({state:'hidden'});
    }
  }
});
