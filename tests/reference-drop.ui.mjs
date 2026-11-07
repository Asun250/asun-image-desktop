import {test,before,after,beforeEach,afterEach} from 'node:test';
import assert from 'node:assert/strict';
import {mkdir} from 'node:fs/promises';
import path from 'node:path';
import {chromium} from 'playwright';
import {createServer} from '../server.mjs';

let server,browser,context,page,base,errors;
const qa=path.resolve('qa','reference-drop');
before(async()=>{await mkdir(qa,{recursive:true});server=createServer();await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));base=`http://127.0.0.1:${server.address().port}`;browser=await chromium.launch({headless:true});});
after(async()=>{await browser?.close();if(server)await new Promise(resolve=>server.close(resolve));});
beforeEach(async()=>{errors=[];context=await browser.newContext({viewport:{width:1672,height:941},acceptDownloads:true});page=await context.newPage();page.on('pageerror',error=>errors.push(error.message));page.on('request',request=>{if(!request.url().startsWith(base)&&!request.url().startsWith('data:')&&!request.url().startsWith('blob:'))errors.push('Unexpected remote request: '+request.url());});await page.goto(base);await page.waitForFunction(()=>document.documentElement.dataset.ready==='true');});
afterEach(async(info)=>{try{if(info.error)await page.screenshot({path:path.join(qa,'failure-'+info.name.replace(/\W+/g,'-')+'.png')});assert.deepEqual(errors,[]);}finally{await context?.close();}});

async function fixture(name,color,format='png',width=120,height=80){
  const result=await page.evaluate(({color,format,width,height})=>{const c=document.createElement('canvas');c.width=width;c.height=height;const ctx=c.getContext('2d');ctx.fillStyle=color;ctx.fillRect(0,0,width,height);const source=c.toDataURL('image/'+format);return {source,bytes:Array.from(Uint8Array.from(atob(source.split(',')[1]),c=>c.charCodeAt(0)))};},{color,format,width,height});
  return {...result,name,type:'image/'+format,width,height};
}
async function main(){const image=await fixture('Main.png','#ffffff','png',480,320);await page.locator('#imageInput').setInputFiles({name:image.name,mimeType:image.type,buffer:Buffer.from(image.bytes)});await page.waitForFunction(()=>document.querySelectorAll('.layer-row').length===1&&!document.body.classList.contains('busy')&&document.querySelector('#canvas').width===480);}
async function point(x,y){const r=await page.locator('#board').boundingBox();return {x:r.x+x*r.width/480,y:r.y+y*r.height/320};}
async function clickDoc(x,y,options){const p=await point(x,y);await page.mouse.click(p.x,p.y,options);}
async function control(id,value){await page.locator('#'+id).evaluate((input,value)=>{input.value=String(value);input.dispatchEvent(new Event('input',{bubbles:true}));input.dispatchEvent(new Event('change',{bubbles:true}));},value);}
async function label(content='1',x=40){await page.locator('#addText').click();await control('textSize',24);await control('textColor','#000000');await clickDoc(x,40);await page.locator('#textEditor').fill(content);await page.locator('#textEditor').press('Enter');await page.locator('#textEditor').waitFor({state:'hidden'});}
async function open(){await page.locator('#linkReference').click();await page.locator('#referenceDialog').waitFor({state:'visible'});}
async function prepareDrag(files=[],strings=[]){
  await page.evaluate(({files,strings})=>{const data=new DataTransfer();for(const file of files)data.items.add(new File([file.size?new Uint8Array(file.size):new Uint8Array(file.bytes)],file.name,{type:file.type}));for(const string of strings)data.setData(string.type,string.value);window.__referenceDropData=data;},{files,strings});
}
async function dragEvent(selector,type,relatedSelector=null){
  return page.locator(selector).evaluate((target,{type,relatedSelector})=>{const event=new DragEvent(type,{bubbles:true,cancelable:true,dataTransfer:window.__referenceDropData,relatedTarget:relatedSelector?document.querySelector(relatedSelector):null});target.dispatchEvent(event);return {prevented:event.defaultPrevented,dropEffect:event.dataTransfer.dropEffect};},{type,relatedSelector});
}
async function drop(files,target='#referenceDropZone',strings=[]){await prepareDrag(files,strings);await dragEvent(target,'dragenter');await dragEvent(target,'dragover');return dragEvent(target,'drop');}
async function preview(image){await page.waitForFunction(name=>{const preview=document.querySelector('#referencePreview');return !document.body.classList.contains('busy')&&document.querySelector('#referenceName').textContent===name&&preview.dataset.imageRole==='generated-preview'&&/^data:image\/png;base64,/.test(preview.getAttribute('src')||'')&&preview.complete&&preview.naturalWidth>0&&preview.naturalWidth<=512&&preview.naturalHeight<=512;},image.name);assert.equal(await page.locator('#referenceName').innerText(),image.name);}
async function saveLink(){await page.locator('#saveReferenceLink').click();await page.locator('#referenceDialog').waitFor({state:'hidden'});}
async function bytes(event){const d=await event,s=await d.createReadStream(),chunks=[];for await(const c of s)chunks.push(c);return {buffer:Buffer.concat(chunks),name:d.suggestedFilename()};}
async function save(){const event=page.waitForEvent('download');await page.locator('#saveProject').click();const result=await bytes(event);await page.waitForTimeout(725);return {...result,data:JSON.parse(result.buffer.toString())};}
async function reopen(saved,count){await page.locator('#newProject').click();await page.locator('#confirmDialog').click();await page.locator('#projectInput').setInputFiles({name:saved.name,mimeType:'application/json',buffer:saved.buffer});await page.waitForFunction(count=>document.querySelectorAll('.layer-row').length===count&&!document.body.classList.contains('busy'),count);}
async function linkedFixture(){await main();await label();const image=await fixture('Original green.png','#00ff00');await open();await page.locator('#referenceFileInput').setInputFiles({name:image.name,mimeType:image.type,buffer:Buffer.from(image.bytes)});await preview(image);await saveLink();return image;}
async function waitError(pattern){await page.waitForFunction(pattern=>!document.body.classList.contains('busy')&&new RegExp(pattern,'i').test(document.querySelector('#referenceDialogError').textContent),pattern);}

test('local PNG, JPEG and WebP drops retain bytes, save as editable links and reopen with the correct photo and board mapping',async()=>{
  await main();const photos=[await fixture('Dropped green.png','#00ff00'),await fixture('Dropped red.jpg','#ff0000','jpeg'),await fixture('Dropped blue.webp','#0000ff','webp')];
  for(const [index,image]of photos.entries()){
    await label(String(index+1),40+index*80);await open();assert.equal((await drop([image])).prevented,true);await preview(image);assert.equal(await page.locator('#saveReferenceLink').isEnabled(),true);await saveLink();
  }
  const saved=await save();assert.equal(saved.data.layers.length,4);assert.equal(saved.data.references.length,3);
  for(const [index,image]of photos.entries()){
    const ref=saved.data.references.find(ref=>ref.name===image.name);assert.ok(ref);assert.equal(ref.source,image.source);assert.deepEqual([ref.width,ref.height],[120,80]);assert.equal(saved.data.layers[index+1].referenceIds?.[0],ref.id);
  }
  await reopen(saved,4);await page.locator('[data-tool=move]').first().click();await clickDoc(128,52);await page.locator('#referenceDialog').waitFor({state:'visible'});await preview(photos[1]);
  await page.screenshot({path:path.join(qa,'dropped-photo-dialog-1672.png')});await page.setViewportSize({width:1280,height:800});assert.equal(await page.locator('#referenceDropZone').isVisible(),true);assert.equal(await page.locator('#saveReferenceLink').isVisible(),true);await page.screenshot({path:path.join(qa,'dropped-photo-dialog-1280.png')});await page.locator('#closeReferenceDialog').click();
  const mapping=await page.evaluate(async project=>(await import('/reference-board.mjs')).linkedReferences(project).map(group=>({name:group.reference.name,labels:group.labels})),saved.data);
  assert.deepEqual(mapping,photos.map((image,index)=>({name:image.name,labels:[String(index+1)]})));
  const event=page.waitForEvent('download');await clickDoc(400,270,{button:'right'});await page.locator('#downloadReferenceBoard').click();const board=await bytes(event);
  const colors=await page.evaluate(async bytes=>{const bitmap=await createImageBitmap(new Blob([new Uint8Array(bytes)],{type:'image/png'})),c=document.createElement('canvas');c.width=bitmap.width;c.height=bitmap.height;const ctx=c.getContext('2d');ctx.drawImage(bitmap,0,0);bitmap.close();const data=ctx.getImageData(0,0,c.width,c.height).data,counts=[0,0,0];for(let i=0;i<data.length;i+=4){if(data[i+1]>240&&data[i]<15&&data[i+2]<15)counts[0]++;if(data[i]>240&&data[i+1]<15&&data[i+2]<15)counts[1]++;if(data[i+2]>240&&data[i]<15&&data[i+1]<15)counts[2]++;}return counts;},[...board.buffer]);
  assert.ok(colors.every(count=>count>1000),'Downloaded board contains real pixels from all three dropped photos');
});

test('adding to an existing reference by drop stays reversible until Save references and undo restores the previous links',async()=>{
  const original=await linkedFixture(),before=await save(),replacement=await fixture('Replacement red.png','#ff0000');
  await open();await drop([replacement]);await preview(replacement);await page.locator('#cancelReferenceLink').click();assert.deepEqual((await save()).data,before.data,'Cancel discards the dropped preview without adding a photo');
  await open();await preview(original);await drop([replacement]);await preview(replacement);await saveLink();let saved=await save();
  assert.equal(saved.data.references.length,2);const text=saved.data.layers.find(layer=>layer.kind==='text');assert.deepEqual(text.referenceIds,saved.data.references.map(ref=>ref.id));assert.equal(saved.data.references.at(-1).source,replacement.source);
  await page.locator('#undo').click();saved=await save();assert.deepEqual(saved.data,before.data,'One undo reverses the atomic photo-add and link change');
  await page.locator('#redo').click();saved=await save();assert.deepEqual(saved.data.layers[1].referenceIds,saved.data.references.map(ref=>ref.id));assert.equal(saved.data.references.at(-1).source,replacement.source);
});

test('unsupported, mixed-invalid, large and undecodable drops retain the existing choice or valid unsaved preview',async()=>{
  const original=await linkedFixture();await open();const originalChoice=await page.locator('#referenceChoice').inputValue();
  await drop([{name:'Not a photo.txt',type:'text/plain',bytes:[97,98,99]}]);await waitError('PNG|JPEG|WebP|image');await preview(original);assert.equal(await page.locator('#referenceChoice').inputValue(),originalChoice);
  const replacement=await fixture('Valid red.png','#ff0000');await drop([replacement]);await preview(replacement);
  await drop([replacement,{name:'Invalid batch member.txt',type:'text/plain',bytes:[97,98,99]}]);await waitError('PNG|JPEG|WebP|image');await preview(replacement);assert.equal(await page.locator('#referenceChoice').inputValue(),'');
  await drop([{name:'Too large.png',type:'image/png',size:50*1024*1024+1}]);await waitError('50 MB|50 meg');await preview(replacement);
  await drop([{name:'Broken.png',type:'image/png',bytes:[98,97,100]}]);await waitError('PNG|JPEG|WebP|image');await preview(replacement);
  await drop([{name:'Truncated.png',type:'image/png',bytes:[137,80,78,71,13,10,26,10,0,0,0,0]}]);await waitError('decode|decoded');await preview(replacement);
  assert.equal(await page.locator('#referenceDropZone').evaluate(zone=>zone.classList.contains('is-dragover')),false,'A rejected drop clears the hover highlight');
  await saveLink();const saved=await save();assert.equal(saved.data.references.length,2);assert.deepEqual(saved.data.layers[1].referenceIds,saved.data.references.map(ref=>ref.id));assert.equal(saved.data.references.at(-1).source,replacement.source);
});

test('nested hover clears on exit, modal background drops cannot import or navigate and URL-only drops never fetch',async()=>{
  const original=await linkedFixture(),replacement=await fixture('Convenient header drop.png','#0000ff');await open();await prepareDrag([replacement]);
  assert.equal((await dragEvent('#referenceDropZone','dragenter')).prevented,true);await dragEvent('#referenceDropZone','dragover');assert.equal(await page.locator('#referenceDropZone').evaluate(zone=>zone.classList.contains('is-dragover')),true);
  await dragEvent('#referenceDropZone','dragleave','#referencePreview');await dragEvent('#referencePreview','dragenter','#referenceDropZone');assert.equal(await page.locator('#referenceDropZone').evaluate(zone=>zone.classList.contains('is-dragover')),true,'Moving over the nested image retains the highlight');
  await dragEvent('#referencePreview','dragleave','#referenceName');assert.equal(await page.locator('#referenceDropZone').evaluate(zone=>zone.classList.contains('is-dragover')),true,'Moving into another accepted area of the photo dialog retains the highlight');
  await dragEvent('#referenceName','dragleave','#stage');assert.equal(await page.locator('#referenceDropZone').evaluate(zone=>zone.classList.contains('is-dragover')),false,'Leaving the accepted dialog clears the highlight');
  const url=page.url(),count=await page.locator('.layer-row').count();assert.equal((await drop([replacement],'#stage')).prevented,true);assert.equal(page.url(),url);assert.equal(await page.locator('.layer-row').count(),count);await preview(original);
  assert.equal((await drop([],'#referenceDropZone',[{type:'text/uri-list',value:'https://example.com/photo.png'},{type:'text/html',value:'<img src="https://example.com/photo.png">'}])).prevented,true);await waitError('file|folder|photo|image');await preview(original);assert.deepEqual(errors,[]);
  assert.equal((await drop([replacement],'#referenceDialogTitle')).prevented,true);await preview(replacement);assert.equal(await page.locator('.layer-row').count(),count,'Dropping elsewhere inside the photo dialog only changes its draft preview');await page.locator('#closeReferenceDialog').click();
  assert.equal(await page.locator('#referenceDropZone').evaluate(zone=>zone.classList.contains('is-dragover')),false);
});

test('closing the reference dialog during a delayed image read discards the stale drop and retains the project',async()=>{
  const original=await linkedFixture(),before=await save(),replacement=await fixture('Delayed red.png','#ff0000');await open();
  await page.evaluate(()=>{window.__nativeRead=FileReader.prototype.readAsDataURL;FileReader.prototype.readAsDataURL=function(file){window.__releaseReferenceRead=()=>window.__nativeRead.call(this,file);};});
  await drop([replacement]);await page.waitForFunction(()=>typeof window.__releaseReferenceRead==='function'&&document.body.classList.contains('busy'));
  await page.locator('#closeReferenceDialog').click();await page.locator('#referenceDialog').waitFor({state:'hidden'});
  await page.evaluate(()=>{FileReader.prototype.readAsDataURL=window.__nativeRead;window.__releaseReferenceRead();});await page.waitForFunction(()=>!document.body.classList.contains('busy'));
  assert.deepEqual((await save()).data,before.data,'A closed-dialog read never creates or links its stale photo');await open();await preview(original);assert.equal(await page.locator('#referenceName').innerText(),original.name);await page.locator('#closeReferenceDialog').click();
});
