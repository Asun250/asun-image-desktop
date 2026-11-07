import {test,before,after,beforeEach,afterEach} from 'node:test';
import assert from 'node:assert/strict';
import {mkdir} from 'node:fs/promises';
import path from 'node:path';
import {chromium} from 'playwright';
import {createServer} from '../server.mjs';

let server,browser,context,page,base,errors;
const qa=path.resolve('qa','annotations');
before(async()=>{
  await mkdir(qa,{recursive:true});
  server=createServer();
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  base=`http://127.0.0.1:${server.address().port}`;
  browser=await chromium.launch({headless:true});
});
after(async()=>{await browser?.close();if(server)await new Promise(resolve=>server.close(resolve));});
beforeEach(async()=>{
  errors=[];
  context=await browser.newContext({viewport:{width:1672,height:941},acceptDownloads:true});
  page=await context.newPage();
  page.on('pageerror',error=>errors.push(error.message));
  page.on('request',request=>{
    if(!request.url().startsWith(base)&&!request.url().startsWith('data:')&&!request.url().startsWith('blob:'))errors.push('Unexpected remote request: '+request.url());
  });
  await page.goto(base);
  await page.waitForFunction(()=>document.documentElement.dataset.ready==='true');
});
afterEach(async(info)=>{
  try{
    if(info.error)await page.screenshot({path:path.join(qa,'failure-'+info.name.replace(/\W+/g,'-')+'.png')});
    assert.deepEqual(errors,[]);
  }finally{await context?.close();}
});

async function importWhite(){
  const source=await page.evaluate(()=>{
    const canvas=document.createElement('canvas');canvas.width=480;canvas.height=320;
    const ctx=canvas.getContext('2d');ctx.fillStyle='#ffffff';ctx.fillRect(0,0,480,320);
    return canvas.toDataURL('image/png');
  });
  await page.locator('#imageInput').setInputFiles({name:'Annotation test.png',mimeType:'image/png',buffer:Buffer.from(source.split(',')[1],'base64')});
  await page.waitForFunction(()=>!document.body.classList.contains('busy')&&document.querySelectorAll('.layer-row').length===1&&document.querySelector('#canvas').width===480);
  await waitPixel(240,160,[255,255,255,255]);
}
async function docPoint(x,y){
  const rect=await page.locator('#board').boundingBox();
  assert.ok(rect,'board is visible');
  return {x:rect.x+x*rect.width/480,y:rect.y+y*rect.height/320};
}
async function clickDoc(x,y,options){const p=await docPoint(x,y);await page.mouse.click(p.x,p.y,options);}
async function setControl(id,value){
  await page.locator('#'+id).evaluate((input,value)=>{input.value=String(value);input.dispatchEvent(new Event('input',{bubbles:true}));input.dispatchEvent(new Event('change',{bubbles:true}));},value);
}
async function addText(content,x,y){
  await clickDoc(x,y);
  await page.locator('#textEditor').waitFor({state:'visible'});
  await page.locator('#textEditor').fill(content);
  await page.locator('#textEditor').press('Enter');
  await page.locator('#textEditor').waitFor({state:'hidden'});
}
async function stroke(points){
  const first=await docPoint(...points[0]);
  await page.mouse.move(first.x,first.y);await page.mouse.down();
  for(const point of points.slice(1)){const p=await docPoint(...point);await page.mouse.move(p.x,p.y,{steps:8});}
  await page.mouse.up();
}
async function pixel(x,y){return page.locator('#canvas').evaluate((canvas,{x,y})=>Array.from(canvas.getContext('2d').getImageData(x,y,1,1).data),{x,y});}
async function waitPixel(x,y,expected){
  await page.waitForFunction(({x,y,expected})=>Array.from(document.querySelector('#canvas').getContext('2d').getImageData(x,y,1,1).data).join(',')===expected.join(','),{x,y,expected});
}
async function canvasDigest(){
  return page.locator('#canvas').evaluate(async canvas=>{
    const pixels=canvas.getContext('2d').getImageData(0,0,canvas.width,canvas.height).data;
    return [...new Uint8Array(await crypto.subtle.digest('SHA-256',pixels))].map(x=>x.toString(16).padStart(2,'0')).join('');
  });
}
async function waitChanged(digest){
  await page.waitForFunction(async digest=>{
    const canvas=document.querySelector('#canvas'),pixels=canvas.getContext('2d').getImageData(0,0,canvas.width,canvas.height).data;
    const next=[...new Uint8Array(await crypto.subtle.digest('SHA-256',pixels))].map(x=>x.toString(16).padStart(2,'0')).join('');
    return next!==digest;
  },digest);
}
async function saveProject(){
  const event=page.waitForEvent('download');await page.locator('#saveProject').click();
  const download=await event,stream=await download.createReadStream(),chunks=[];
  for await(const chunk of stream)chunks.push(chunk);
  const buffer=Buffer.concat(chunks);
  // The app deliberately guards a second download for 700 ms. Match the time
  // between ordinary user saves rather than racing that guard in this helper.
  await page.waitForTimeout(725);
  return {data:JSON.parse(buffer.toString()),buffer,name:download.suggestedFilename()};
}
async function reopen(saved,count){
  await page.locator('#newProject').click();
  await page.locator('#desktopCreateDialog .desktop-create-blank').click();
  await page.locator('#confirmDialog').click();
  await page.locator('#projectInput').setInputFiles({name:saved.name,mimeType:'application/json',buffer:saved.buffer});
  await page.waitForFunction(count=>!document.body.classList.contains('busy')&&document.querySelectorAll('.layer-row').length===count,count);
}
async function decodedPng(bytes){
  return page.evaluate(async bytes=>{
    const blob=new Blob([new Uint8Array(bytes)],{type:'image/png'}),bitmap=await createImageBitmap(blob);
    const canvas=document.createElement('canvas');canvas.width=bitmap.width;canvas.height=bitmap.height;
    const ctx=canvas.getContext('2d');ctx.drawImage(bitmap,0,0);bitmap.close();
    const hash=[...new Uint8Array(await crypto.subtle.digest('SHA-256',ctx.getImageData(0,0,canvas.width,canvas.height).data))].map(x=>x.toString(16).padStart(2,'0')).join('');
    return {width:canvas.width,height:canvas.height,hash};
  },bytes);
}

test('text click and Enter place repeated editable labels at document coordinates after pan and zoom',async()=>{
  await importWhite();
  const blank=await canvasDigest();
  await page.locator('#addText').click();await setControl('textSize',24);await setControl('textColor','#0000ff');
  await addText('First',40,35);await waitChanged(blank);
  assert.equal(await page.locator('#addText').evaluate(button=>button.classList.contains('active')),true,'Text remains active after committing');
  await addText('Second',275,105);
  await page.locator('#zoomOut').click();
  await page.locator('[data-tool=hand]').first().click();
  const stage=await page.locator('#stage').boundingBox();
  await page.mouse.move(stage.x+25,stage.y+25);await page.mouse.down();
  await page.mouse.move(stage.x+67,stage.y+55,{steps:5});await page.mouse.up();
  await page.locator('#addText').click();await addText('After view change',65,235);
  const saved=await saveProject(),texts=saved.data.layers.filter(layer=>layer.kind==='text');
  assert.equal(texts.length,3);
  assert.deepEqual(texts.map(layer=>layer.text.content),['First','Second','After view change']);
  for(const [index,expected]of [[40,35],[275,105],[65,235]].entries()){
    assert.ok(Math.abs(texts[index].x-expected[0])<=1,`label ${index+1} x is stored in image pixels`);
    assert.ok(Math.abs(texts[index].y-expected[1])<=1,`label ${index+1} y is stored in image pixels`);
    assert.equal(texts[index].text.fontSize,24);assert.equal(texts[index].text.color.toLowerCase(),'#0000ff');
  }
  assert.equal(await page.locator('.layer-row').count(),4);
  await page.screenshot({path:path.join(qa,'repeated-text.png')});
});

test('Shift+Enter, cancel and later text edits preserve editable content and positions on reopen',async()=>{
  await importWhite();await page.locator('#addText').click();await setControl('textSize',24);
  await clickDoc(30,35);await page.locator('#textEditor').fill('Line one');
  await page.locator('#textEditor').press('Shift+Enter');await page.locator('#textEditor').pressSequentially('Line two');
  assert.equal(await page.locator('#textEditor').inputValue(),'Line one\nLine two');
  await page.locator('#textEditor').press('Enter');
  const committed=await saveProject(),text=committed.data.layers.find(layer=>layer.kind==='text');
  assert.equal(text.text.content,'Line one\nLine two');
  const beforeCancel=await canvasDigest();
  await clickDoc(270,60);await page.locator('#textEditor').fill('Cancelled');await page.locator('#textEditor').press('Escape');
  assert.equal(await page.locator('.layer-row').count(),2);assert.equal(await canvasDigest(),beforeCancel);
  await page.locator(`.layer-row[data-id="${text.id}"]`).click();await page.locator('#editTextLayer').click();
  assert.equal(await page.locator('#textEditor').inputValue(),'Line one\nLine two');
  await page.locator('#textEditor').fill('Revised\nstill editable');await page.locator('#textEditor').press('Enter');
  await page.locator('[data-tool=move]').first().click();await clickDoc(45,50,{clickCount:2});
  await page.locator('#textEditor').waitFor({state:'visible'});
  assert.equal(await page.locator('#textEditor').inputValue(),'Revised\nstill editable');
  await page.locator('#textEditor').fill('Double click edit');await page.locator('#textEditor').press('Enter');
  const saved=await saveProject();
  assert.equal(saved.data.layers.find(layer=>layer.id===text.id).text.content,'Double click edit');
  const digest=await canvasDigest();await reopen(saved,2);
  await page.waitForFunction(async digest=>{
    const c=document.querySelector('#canvas'),hash=[...new Uint8Array(await crypto.subtle.digest('SHA-256',c.getContext('2d').getImageData(0,0,c.width,c.height).data))].map(x=>x.toString(16).padStart(2,'0')).join('');
    return hash===digest;
  },digest);
  await page.locator(`.layer-row[data-id="${text.id}"]`).click();await page.locator('#editTextLayer').click();
  assert.equal(await page.locator('#textEditor').inputValue(),'Double click edit');await page.locator('#textEditor').press('Escape');
});

test('pencil and translucent highlight strokes change pixels and undo or redo independently',async()=>{
  await importWhite();const blank=await canvasDigest();
  await page.locator('[data-tool=pencil]').first().click();await setControl('brushSize',12);await setControl('brushColor','#ff0000');
  await stroke([[60,170],[220,170]]);await waitPixel(140,170,[255,0,0,255]);
  const pencil=await canvasDigest();assert.notEqual(pencil,blank);assert.deepEqual(await pixel(140,195),[255,255,255,255]);
  await page.locator('[data-tool=highlight]').first().click();await setControl('brushSize',28);await setControl('brushColor','#ffff00');
  await stroke([[60,225],[260,225]]);
  await page.waitForFunction(()=>{const p=document.querySelector('#canvas').getContext('2d').getImageData(140,225,1,1).data;return p[0]===255&&p[1]===255&&p[2]>0&&p[2]<255&&p[3]===255;});
  const highlighted=await canvasDigest();
  await page.locator('#undo').click();await waitPixel(140,225,[255,255,255,255]);assert.equal(await canvasDigest(),pencil);
  await page.locator('#undo').click();await waitPixel(140,170,[255,255,255,255]);assert.equal(await canvasDigest(),blank);
  await page.locator('#redo').click();await waitPixel(140,170,[255,0,0,255]);
  await page.locator('#redo').click();await waitChanged(pencil);assert.equal(await canvasDigest(),highlighted);
  const saved=await saveProject(),drawings=saved.data.layers.filter(layer=>layer.kind==='drawing');
  assert.deepEqual(drawings.map(layer=>layer.drawing.mode),['pencil','highlight']);
  assert.ok(drawings.every(layer=>layer.drawing.points.length>=2),'Each stroke keeps editable points');
  assert.equal(drawings[0].opacity,1);assert.ok(drawings[1].opacity>0&&drawings[1].opacity<1);
  await reopen(saved,3);await waitPixel(140,170,[255,0,0,255]);assert.equal(await canvasDigest(),highlighted);
  await page.screenshot({path:path.join(qa,'pencil-highlight.png')});
  await page.setViewportSize({width:1280,height:800});
  for(const mode of ['pencil','highlight']){
    await page.locator(`[data-tool=${mode}]`).first().click();
    assert.equal(await page.locator('#brushSize').isVisible(),true);assert.equal(await page.locator('#brushColor').isVisible(),true);
    const brush=await page.locator('#brushOptions').boundingBox();assert.ok(brush.x>=0&&brush.x+brush.width<=1280,'Brush controls fit compact viewport');
    await page.screenshot({path:path.join(qa,mode+'-compact-1280.png')});
  }
});

test('right-click copy includes pending text and all strokes as a real PNG matching export and paste',async()=>{
  // Headless Chromium cannot present its clipboard permission prompt; use the
  // permission a user grants to test the real OS image clipboard end to end.
  await context.grantPermissions(['clipboard-write'],{origin:base});
  await importWhite();await page.locator('[data-tool=pencil]').first().click();await setControl('brushSize',12);await setControl('brushColor','#ff0000');
  await stroke([[50,150],[250,150]]);await waitPixel(140,150,[255,0,0,255]);
  await page.locator('[data-tool=highlight]').first().click();await setControl('brushSize',24);await setControl('brushColor','#ffff00');
  await stroke([[50,220],[250,220]]);
  await page.locator('#addText').click();await setControl('textSize',24);await setControl('textColor','#0000ff');
  await clickDoc(35,35);await page.locator('#textEditor').fill('Pending copied label');
  await clickDoc(400,280,{button:'right'});await page.locator('#imageMenu').waitFor({state:'visible'});
  await page.locator('#copyImage').click();
  await page.waitForFunction(()=>/copied/i.test(document.querySelector('#toast').textContent));
  // Reading the user's clipboard is independently gated by the browser. Only
  // grant this test read access after it has put its own fixture there.
  await context.grantPermissions(['clipboard-read'],{origin:base});
  const clipboard=await page.evaluate(async()=>{
    const items=await navigator.clipboard.read(),item=items.find(item=>item.types.includes('image/png'));
    if(!item)return {types:items.flatMap(item=>item.types),bytes:null};
    return {types:item.types,bytes:Array.from(new Uint8Array(await(await item.getType('image/png')).arrayBuffer()))};
  });
  assert.ok(clipboard.types.includes('image/png'),'The system clipboard contains a PNG image');
  assert.ok(clipboard.bytes?.length>100);assert.deepEqual(clipboard.bytes.slice(0,8),[137,80,78,71,13,10,26,10]);
  const copied=await decodedPng(clipboard.bytes);assert.equal(copied.width,480);assert.equal(copied.height,320);
  assert.equal(copied.hash,await canvasDigest(),'Clipboard pixels include the full image composite');
  const saved=await saveProject();assert.equal(saved.data.layers.find(layer=>layer.kind==='text').text.content,'Pending copied label');
  assert.equal(saved.data.layers.filter(layer=>layer.kind==='drawing').length,2);
  await page.locator('#export').click();await page.locator('#formatField').selectOption('png');
  const event=page.waitForEvent('download');await page.locator('#confirmDialog').click();
  const download=await event,stream=await download.createReadStream(),chunks=[];for await(const chunk of stream)chunks.push(chunk);
  assert.deepEqual(await decodedPng([...Buffer.concat(chunks)]),copied,'PNG export and copied image decode to identical pixels');
  await page.evaluate(()=>{
    const probe=document.createElement('textarea');probe.id='pasteProbe';probe.style.cssText='position:fixed;left:100px;top:100px;z-index:99999;width:300px;height:100px';
    probe.setAttribute('aria-label','Clipboard paste test');
    probe.addEventListener('paste',async event=>{
      event.preventDefault();event.stopImmediatePropagation();
      const file=[...event.clipboardData.files].find(file=>file.type==='image/png');
      window.__pastedImage=file?{type:file.type,bytes:Array.from(new Uint8Array(await file.arrayBuffer()))}:{types:[...event.clipboardData.types]};
    });document.body.append(probe);probe.focus();
  });
  await page.locator('#pasteProbe').focus();await page.keyboard.press('Control+v');
  await page.waitForFunction(()=>window.__pastedImage);
  const pasted=await page.evaluate(()=>window.__pastedImage);assert.equal(pasted.type,'image/png');
  assert.deepEqual(await decodedPng(pasted.bytes),copied,'A normal Ctrl+V consumer receives the annotated PNG');
  await page.locator('#pasteProbe').evaluate(element=>element.remove());
  await reopen(saved,4);assert.equal(await canvasDigest(),copied.hash);
});

test('saving while typing commits the annotation and preserves its text and placement',async()=>{
  await importWhite();await page.locator('#addText').click();await setControl('textSize',24);await setControl('textColor','#112233');
  await clickDoc(70,85);await page.locator('#textEditor').fill('Save this draft');
  const saved=await saveProject(),text=saved.data.layers.find(layer=>layer.kind==='text');
  assert.ok(text,'Saving includes the pending text layer');assert.equal(text.text.content,'Save this draft');
  assert.ok(Math.abs(text.x-70)<=1);assert.ok(Math.abs(text.y-85)<=1);
  await reopen(saved,2);await page.locator(`.layer-row[data-id="${text.id}"]`).click();await page.locator('#editTextLayer').click();
  assert.equal(await page.locator('#textEditor').inputValue(),'Save this draft');await page.locator('#textEditor').press('Escape');
});

test('clipboard denial leaves edits intact and offers a usable annotated PNG download',async()=>{
  await importWhite();await page.locator('#addText').click();await setControl('textSize',24);await addText('Keep this label',35,40);
  await page.locator('[data-tool=pencil]').first().click();await setControl('brushSize',12);await setControl('brushColor','#ff0000');
  await stroke([[60,180],[240,180]]);await waitPixel(140,180,[255,0,0,255]);
  const digest=await canvasDigest(),count=await page.locator('.layer-row').count();
  await page.evaluate(()=>Object.defineProperty(navigator.clipboard,'write',{configurable:true,value:async()=>{throw new DOMException('Test permission denial','NotAllowedError');}}));
  await clickDoc(400,280,{button:'right'});await page.locator('#copyImage').click();
  await page.waitForFunction(()=>/allow clipboard access/i.test(document.querySelector('#toast').textContent));
  assert.match(await page.locator('#toast').innerText(),/download the annotated PNG/i);
  assert.equal(await page.locator('.layer-row').count(),count);assert.equal(await canvasDigest(),digest);
  await clickDoc(400,280,{button:'right'});const event=page.waitForEvent('download');await page.locator('#downloadImage').click();
  const download=await event,stream=await download.createReadStream(),chunks=[];for await(const chunk of stream)chunks.push(chunk);
  assert.deepEqual(await decodedPng([...Buffer.concat(chunks)]),{width:480,height:320,hash:digest});
  assert.equal(await page.locator('.layer-row').count(),count);assert.equal(await canvasDigest(),digest);
});

test('editing then choosing a layer, deleting or jumping history resolves the draft before the action',async()=>{
  await importWhite();await page.locator('#addText').click();await setControl('textSize',24);await addText('Initial label',35,40);
  let saved=await saveProject(),text=saved.data.layers.find(layer=>layer.kind==='text'),raster=saved.data.layers.find(layer=>layer.kind==='raster');
  await page.locator('#editTextLayer').click();await page.locator('#textEditor').fill('Changed before selecting');
  await page.locator(`.layer-row[data-id="${raster.id}"]`).click();
  await page.locator('#textEditor').waitFor({state:'hidden'});saved=await saveProject();
  assert.equal(saved.data.layers.find(layer=>layer.id===text.id).text.content,'Changed before selecting');
  await page.locator(`.layer-row[data-id="${text.id}"]`).click();await page.locator('#editTextLayer').click();await page.locator('#textEditor').fill('Changed before deleting');
  await page.locator('#deleteLayer').click();await page.locator('#textEditor').waitFor({state:'hidden'});
  saved=await saveProject();assert.equal(saved.data.layers.length,1);assert.equal(saved.data.layers[0].kind,'raster');
  await page.locator('#undo').click();assert.equal(await page.locator('.layer-row').count(),2);
  await page.locator(`.layer-row[data-id="${text.id}"]`).click();await page.locator('#editTextLayer').click();
  assert.equal(await page.locator('#textEditor').inputValue(),'Changed before deleting');await page.locator('#textEditor').fill('Changed before history');
  await page.locator('#historyList button').first().click();await page.locator('#textEditor').waitFor({state:'hidden'});
  saved=await saveProject();assert.equal(saved.data.layers.length,0,'History jump stays authoritative after the draft commits');
});
