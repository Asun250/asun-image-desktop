import {test,before,after,beforeEach,afterEach} from 'node:test';
import assert from 'node:assert/strict';
import {mkdir} from 'node:fs/promises';
import path from 'node:path';
import {chromium} from 'playwright';
import {createServer} from '../server.mjs';

let server,browser,context,page,base,errors;
const qa=path.resolve('qa','paste');
before(async()=>{
  await mkdir(qa,{recursive:true});server=createServer();
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  base=`http://127.0.0.1:${server.address().port}`;browser=await chromium.launch({headless:true});
});
after(async()=>{await browser?.close();if(server)await new Promise(resolve=>server.close(resolve));});
beforeEach(async()=>{
  errors=[];context=await browser.newContext({viewport:{width:1672,height:941},acceptDownloads:true});
  // Write permission seeds our own fixture on the real clipboard. Native
  // Ctrl+V is tested without granting navigator.clipboard.read permission.
  await context.grantPermissions(['clipboard-write'],{origin:base});
  page=await context.newPage();page.on('pageerror',error=>errors.push(error.message));
  page.on('request',request=>{if(!request.url().startsWith(base)&&!request.url().startsWith('data:')&&!request.url().startsWith('blob:'))errors.push('Unexpected remote request: '+request.url());});
  await page.goto(base);await page.waitForFunction(()=>document.documentElement.dataset.ready==='true');
});
afterEach(async(info)=>{
  try{if(info.error)await page.screenshot({path:path.join(qa,'failure-'+info.name.replace(/\W+/g,'-')+'.png')});assert.deepEqual(errors,[]);}
  finally{await context?.close();}
});

async function png(width=300,height=180,color='#ffffff',stripe=null){
  return page.evaluate(({width,height,color,stripe})=>{
    const canvas=document.createElement('canvas');canvas.width=width;canvas.height=height;
    const ctx=canvas.getContext('2d');ctx.fillStyle=color;ctx.fillRect(0,0,width,height);
    if(stripe){ctx.fillStyle=stripe;ctx.fillRect(width/2,0,width/2,height);}
    const source=canvas.toDataURL('image/png');return {source,width,height,bytes:Array.from(Uint8Array.from(atob(source.split(',')[1]),c=>c.charCodeAt(0)))};
  },{width,height,color,stripe});
}
async function writePng(fixture){
  await page.evaluate(async bytes=>navigator.clipboard.write([new ClipboardItem({'image/png':new Blob([new Uint8Array(bytes)],{type:'image/png'})})]),fixture.bytes);
}
async function nativePaste(count,{capture=false}={}){
  if(capture)await page.evaluate(()=>{
    window.__pasteSources=null;
    document.addEventListener('paste',event=>{
      Promise.all([...event.clipboardData.files].map(file=>new Promise((resolve,reject)=>{
        const reader=new FileReader();reader.onload=()=>resolve({source:reader.result,type:file.type});reader.onerror=()=>reject(reader.error);reader.readAsDataURL(file);
      }))).then(files=>window.__pasteSources=files);
    },{capture:true,once:true});
  });
  await page.locator('#stage').focus();await page.keyboard.press('Control+v');
  await page.waitForFunction(count=>!document.body.classList.contains('busy')&&document.querySelectorAll('.layer-row').length===count,count);
  if(capture)await page.waitForFunction(()=>window.__pasteSources!==null);
}
async function waitPixel(x,y,expected){
  await page.waitForFunction(({x,y,expected})=>Array.from(document.querySelector('#canvas').getContext('2d').getImageData(x,y,1,1).data).join(',')===expected.join(','),{x,y,expected});
}
async function imageDigest(bytes=null){
  return page.evaluate(async bytes=>{
    let canvas=document.querySelector('#canvas');
    if(bytes){const bitmap=await createImageBitmap(new Blob([new Uint8Array(bytes)],{type:'image/png'}));canvas=document.createElement('canvas');canvas.width=bitmap.width;canvas.height=bitmap.height;canvas.getContext('2d').drawImage(bitmap,0,0);bitmap.close();}
    const hash=[...new Uint8Array(await crypto.subtle.digest('SHA-256',canvas.getContext('2d').getImageData(0,0,canvas.width,canvas.height).data))].map(x=>x.toString(16).padStart(2,'0')).join('');
    return {width:canvas.width,height:canvas.height,hash};
  },bytes);
}
async function waitDigest(expected){
  await page.waitForFunction(async expected=>{
    const canvas=document.querySelector('#canvas');if(canvas.width!==expected.width||canvas.height!==expected.height)return false;
    const hash=[...new Uint8Array(await crypto.subtle.digest('SHA-256',canvas.getContext('2d').getImageData(0,0,canvas.width,canvas.height).data))].map(x=>x.toString(16).padStart(2,'0')).join('');
    return hash===expected.hash;
  },expected);
}
async function docPoint(x,y){
  const rect=await page.locator('#board').boundingBox(),size=await page.locator('#canvas').evaluate(c=>({width:c.width,height:c.height}));
  return {x:rect.x+x*rect.width/size.width,y:rect.y+y*rect.height/size.height};
}
async function clickDoc(x,y,options){const p=await docPoint(x,y);await page.mouse.click(p.x,p.y,options);}
async function setControl(id,value){await page.locator('#'+id).evaluate((input,value)=>{input.value=String(value);input.dispatchEvent(new Event('input',{bubbles:true}));input.dispatchEvent(new Event('change',{bubbles:true}));},value);}
async function annotation(content='Pasted and editable'){
  await page.locator('#addText').click();await setControl('textSize',18);await setControl('textColor','#0000ff');
  await clickDoc(15,15);await page.locator('#textEditor').fill(content);await page.locator('#textEditor').press('Enter');await page.locator('#textEditor').waitFor({state:'hidden'});
  await page.locator('[data-tool=pencil]').first().click();await setControl('brushSize',6);await setControl('brushColor','#ff0000');
  const first=await docPoint(50,115),last=await docPoint(250,115);await page.mouse.move(first.x,first.y);await page.mouse.down();await page.mouse.move(last.x,last.y,{steps:8});await page.mouse.up();
  await waitPixel(150,115,[255,0,0,255]);
}
async function downloadBytes(event){const download=await event,stream=await download.createReadStream(),chunks=[];for await(const chunk of stream)chunks.push(chunk);return {buffer:Buffer.concat(chunks),name:download.suggestedFilename()};}
async function saveProject(){const event=page.waitForEvent('download');await page.locator('#saveProject').click();const saved=await downloadBytes(event);await page.waitForTimeout(725);return {...saved,data:JSON.parse(saved.buffer.toString())};}
async function openBlankCanvasDialog(){await page.locator('#newProject').click();await page.locator('#desktopCreateDialog .desktop-create-blank').click();await page.locator('#dialog').waitFor({state:'visible'});}
async function reopen(saved,count){
  await openBlankCanvasDialog();await page.locator('#confirmDialog').click();
  await page.locator('#projectInput').setInputFiles({name:saved.name,mimeType:'application/json',buffer:saved.buffer});
  await page.waitForFunction(count=>!document.body.classList.contains('busy')&&document.querySelectorAll('.layer-row').length===count,count);
}

test('native Ctrl+V imports real clipboard PNG bytes, adopts dimensions and adds centered layers with undo',async()=>{
  const first=await png(300,180,'#ff0000','#0000ff');await writePng(first);await nativePaste(1,{capture:true});
  await waitPixel(40,90,[255,0,0,255]);await waitPixel(240,90,[0,0,255,255]);
  assert.match(await page.locator('#documentSize').innerText(),/300 × 180/);
  const captured=await page.evaluate(()=>window.__pasteSources);assert.equal(captured.length,1);assert.equal(captured[0].type,'image/png');
  let saved=await saveProject();assert.equal(saved.data.assets[saved.data.layers[0].assetId].source,captured[0].source,'Source keeps the exact bytes received by the native paste event');
  const originalLayer=saved.data.layers[0],originalAsset=saved.data.assets[originalLayer.assetId];
  const second=await png(60,40,'#00ff00');await writePng(second);await nativePaste(2);
  await waitPixel(150,90,[0,255,0,255]);await waitPixel(30,90,[255,0,0,255]);
  saved=await saveProject();assert.equal(saved.data.width,300);assert.equal(saved.data.height,180);
  assert.deepEqual(saved.data.layers[0],originalLayer);assert.deepEqual(saved.data.assets[originalLayer.assetId],originalAsset);
  assert.deepEqual([saved.data.layers[1].x,saved.data.layers[1].y,saved.data.layers[1].width,saved.data.layers[1].height],[120,70,60,40]);
  await nativePaste(3);await page.locator('#undo').click();assert.equal(await page.locator('.layer-row').count(),2);
  await page.locator('#undo').click();await waitPixel(150,90,[0,0,255,255]);assert.equal(await page.locator('.layer-row').count(),1);
  await page.locator('#redo').click();await waitPixel(150,90,[0,255,0,255]);
});

test('pasted image can be annotated, exported, saved and reopened; app Copy then Ctrl+V preserves editable source layers',async()=>{
  const fixture=await png();await writePng(fixture);await nativePaste(1);await annotation();
  const edited=await imageDigest();
  await page.locator('#export').click();await page.locator('#formatField').selectOption('png');
  let event=page.waitForEvent('download');await page.locator('#confirmDialog').click();const exported=await downloadBytes(event);
  assert.deepEqual(await imageDigest([...exported.buffer]),edited);
  await clickDoc(275,150,{button:'right'});await page.locator('#copyImage').click();
  await page.waitForFunction(()=>/annotations copied/i.test(document.querySelector('#toast').textContent));
  await nativePaste(4,{capture:true});await waitDigest(edited);
  const captured=await page.evaluate(()=>window.__pasteSources),saved=await saveProject();
  assert.deepEqual(saved.data.layers.map(layer=>layer.kind),['raster','text','drawing','raster']);
  assert.equal(saved.data.layers[1].text.content,'Pasted and editable');
  assert.equal(saved.data.assets[saved.data.layers[3].assetId].source,captured[0].source);
  await page.locator('#undo').click();assert.equal(await page.locator('.layer-row').count(),3);await waitDigest(edited);
  await page.locator('#redo').click();assert.equal(await page.locator('.layer-row').count(),4);
  await reopen(saved,4);await waitDigest(edited);
  await page.locator(`.layer-row[data-id="${saved.data.layers[1].id}"]`).click();await page.locator('#editTextLayer').click();
  assert.equal(await page.locator('#textEditor').inputValue(),'Pasted and editable');await page.locator('#textEditor').press('Escape');
  await page.screenshot({path:path.join(qa,'copy-paste-editable-roundtrip.png')});
});

test('Paste toolbar and right-click Paste work on empty canvas; native paste confirms pending annotation',async()=>{
  await context.grantPermissions(['clipboard-read','clipboard-write'],{origin:base});
  const fixture=await png(300,180,'#ffffff');await writePng(fixture);
  await page.locator('#pasteTop').click();await page.waitForFunction(()=>document.querySelectorAll('.layer-row').length===1&&!document.body.classList.contains('busy'));
  await waitPixel(150,90,[255,255,255,255]);assert.match(await page.locator('#documentSize').innerText(),/300 × 180/);
  await openBlankCanvasDialog();await page.locator('#confirmDialog').click();
  assert.equal(await page.locator('.layer-row').count(),0);
  const stage=await page.locator('#stage').boundingBox();await page.mouse.click(stage.x+stage.width/2,stage.y+stage.height/2,{button:'right'});
  await page.locator('#imageMenu').waitFor({state:'visible'});await page.locator('#pasteImage').click();
  await page.waitForFunction(()=>document.querySelectorAll('.layer-row').length===1&&!document.body.classList.contains('busy'));await waitPixel(150,90,[255,255,255,255]);
  await page.locator('#addText').click();await setControl('textSize',18);await clickDoc(15,15);await page.locator('#textEditor').fill('Draft before paste');
  await writePng(await png(60,40,'#00ff00'));await nativePaste(3);await page.locator('#textEditor').waitFor({state:'hidden'});
  const saved=await saveProject();assert.deepEqual(saved.data.layers.map(layer=>layer.kind),['raster','text','raster']);
  assert.equal(saved.data.layers[1].text.content,'Draft before paste');await waitPixel(150,90,[0,255,0,255]);
});

test('native image paste while the Text editor is focused preserves typed words and ignores an empty draft',async()=>{
  await writePng(await png());await nativePaste(1);
  await page.locator('#addText').click();await setControl('textSize',18);await clickDoc(15,15);
  await page.locator('#textEditor').fill('Keep these pending words');
  await writePng(await png(60,40,'#00ff00'));
  assert.equal(await page.locator('#textEditor').evaluate(input=>document.activeElement===input),true,'Clicking the image with Text active focuses the draft editor');
  await page.keyboard.press('Control+v');
  await page.waitForFunction(()=>!document.body.classList.contains('busy')&&document.querySelectorAll('.layer-row').length===3);
  await page.locator('#textEditor').waitFor({state:'hidden'});await waitPixel(150,90,[0,255,0,255]);
  let saved=await saveProject();assert.deepEqual(saved.data.layers.map(layer=>layer.kind),['raster','text','raster']);
  assert.equal(saved.data.layers[1].text.content,'Keep these pending words');
  await page.locator('#addText').click();await clickDoc(15,135);assert.equal(await page.locator('#textEditor').inputValue(),'');
  await writePng(await png(40,30,'#0000ff'));
  assert.equal(await page.locator('#textEditor').evaluate(input=>document.activeElement===input),true);
  await page.keyboard.press('Control+v');
  await page.waitForFunction(()=>!document.body.classList.contains('busy')&&document.querySelectorAll('.layer-row').length===4);
  await page.locator('#textEditor').waitFor({state:'hidden'});await waitPixel(150,90,[0,0,255,255]);
  saved=await saveProject();assert.equal(saved.data.layers.filter(layer=>layer.kind==='text').length,1,'An empty draft adds no empty text layer');
  assert.equal(saved.data.layers.find(layer=>layer.kind==='text').text.content,'Keep these pending words');
  assert.equal(saved.data.layers.filter(layer=>layer.kind==='raster').length,3);
});

test('clipboard read denial retains the document and explains the native Ctrl+V alternative',async()=>{
  await writePng(await png());await nativePaste(1);await annotation('Keep my edits');
  const before=await imageDigest(),count=await page.locator('.layer-row').count();
  await page.evaluate(()=>Object.defineProperty(navigator.clipboard,'read',{configurable:true,value:async()=>{throw new DOMException('Test clipboard read denied','NotAllowedError');}}));
  await page.locator('#pasteTop').click();
  await page.waitForFunction(()=>document.querySelector('#toast').classList.contains('error')&&/ctrl\+v|control\+v|⌘|cmd\+v/i.test(document.querySelector('#toast').textContent));
  assert.equal(await page.locator('.layer-row').count(),count);assert.deepEqual(await imageDigest(),before);
  await clickDoc(275,150,{button:'right'});await page.locator('#pasteImage').click();
  await page.waitForFunction(()=>/ctrl\+v|control\+v|⌘|cmd\+v/i.test(document.querySelector('#toast').textContent));
  assert.equal(await page.locator('.layer-row').count(),count);assert.deepEqual(await imageDigest(),before);
});

test('normal text inputs and contenteditable retain text paste; modal image paste never imports a layer',async()=>{
  await writePng(await png());await nativePaste(1);
  await page.evaluate(()=>navigator.clipboard.writeText('Pasted normal text'));
  await page.locator('#prompt').fill('');await page.locator('#prompt').focus();await page.keyboard.press('Control+v');
  assert.equal(await page.locator('#prompt').inputValue(),'Pasted normal text');assert.equal(await page.locator('.layer-row').count(),1);
  await page.locator('#addText').click();await setControl('textSize',18);await clickDoc(15,15);await page.locator('#textEditor').fill('');await page.keyboard.press('Control+v');
  assert.equal(await page.locator('#textEditor').inputValue(),'Pasted normal text');assert.equal(await page.locator('.layer-row').count(),1);await page.locator('#textEditor').press('Escape');
  await page.evaluate(()=>{const target=document.createElement('div');target.id='pasteTextProbe';target.contentEditable='true';target.style.cssText='position:fixed;left:100px;top:100px;z-index:99999;background:white;width:250px;height:80px';document.body.append(target);});
  await page.locator('#pasteTextProbe').focus();await page.keyboard.press('Control+v');assert.equal(await page.locator('#pasteTextProbe').innerText(),'Pasted normal text');assert.equal(await page.locator('.layer-row').count(),1);
  await page.locator('#pasteTextProbe').evaluate(element=>element.remove());
  await page.locator('#projectName').click();await page.locator('#nameField').fill('');await page.locator('#nameField').focus();await page.keyboard.press('Control+v');
  assert.equal(await page.locator('#nameField').inputValue(),'Pasted normal text');await page.locator('#cancelDialog').click();
  await writePng(await png(60,40,'#00ff00'));await openBlankCanvasDialog();await page.locator('#confirmDialog').focus();await page.keyboard.press('Control+v');
  assert.equal(await page.locator('#dialog').isVisible(),true);assert.equal(await page.locator('.layer-row').count(),1);await page.locator('#cancelDialog').click();
});

test('URL-only clipboard content gives a clear image error and makes no remote image request',async()=>{
  await writePng(await png());await nativePaste(1);const before=await imageDigest();
  await page.evaluate(()=>navigator.clipboard.write([new ClipboardItem({
    'text/plain':new Blob(['https://example.com/image.png'],{type:'text/plain'}),
    'text/html':new Blob(['<img src="https://example.com/image.png">'],{type:'text/html'})
  })]));
  await page.locator('#stage').focus();await page.keyboard.press('Control+v');
  await page.waitForFunction(()=>document.querySelector('#toast').classList.contains('error'));
  assert.match(await page.locator('#toast').innerText(),/image/i);assert.match(await page.locator('#toast').innerText(),/copy|clipboard|png|jpeg|webp|paste/i);
  assert.equal(await page.locator('.layer-row').count(),1);assert.deepEqual(await imageDigest(),before);assert.deepEqual(errors,[]);
});
