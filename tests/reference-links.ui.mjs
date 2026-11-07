import {test,before,after,beforeEach,afterEach} from 'node:test';
import assert from 'node:assert/strict';
import {mkdir} from 'node:fs/promises';
import path from 'node:path';
import {chromium} from 'playwright';
import {createServer} from '../server.mjs';

let server,browser,context,page,base,errors;
const qa=path.resolve('qa','reference-links');
before(async()=>{await mkdir(qa,{recursive:true});server=createServer();await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));base=`http://127.0.0.1:${server.address().port}`;browser=await chromium.launch({headless:true});});
after(async()=>{await browser?.close();if(server)await new Promise(resolve=>server.close(resolve));});
beforeEach(async()=>{
  errors=[];context=await browser.newContext({viewport:{width:1672,height:941},acceptDownloads:true});
  await context.grantPermissions(['clipboard-read','clipboard-write'],{origin:base});page=await context.newPage();
  page.on('pageerror',error=>errors.push(error.message));page.on('request',request=>{if(!request.url().startsWith(base)&&!request.url().startsWith('data:')&&!request.url().startsWith('blob:'))errors.push('Unexpected remote request: '+request.url());});
  await page.goto(base);await page.waitForFunction(()=>document.documentElement.dataset.ready==='true');
});
afterEach(async(info)=>{try{if(info.error)await page.screenshot({path:path.join(qa,'failure-'+info.name.replace(/\W+/g,'-')+'.png')});assert.deepEqual(errors,[]);}finally{await context?.close();}});

async function fixture(name,color,width=120,height=80){
  const source=await page.evaluate(({color,width,height})=>{const c=document.createElement('canvas');c.width=width;c.height=height;const ctx=c.getContext('2d');ctx.fillStyle=color;ctx.fillRect(0,0,width,height);return c.toDataURL('image/png');},{color,width,height});
  return {source,file:{name,mimeType:'image/png',buffer:Buffer.from(source.split(',')[1],'base64')}};
}
async function main(){const image=await fixture('Main.png','#ffffff',480,320);await page.locator('#imageInput').setInputFiles(image.file);await waitLayers(1);await page.waitForFunction(()=>document.querySelector('#canvas').width===480);return image;}
async function waitLayers(count){await page.waitForFunction(count=>!document.body.classList.contains('busy')&&document.querySelectorAll('.layer-row').length===count,count);}
async function reference(name,color){const image=await fixture(name,color);await page.locator('#referenceInput').setInputFiles(image.file);await page.waitForFunction(()=>!document.body.classList.contains('busy'));await page.getByRole('button',{name:`Remove reference ${name}`,exact:true}).waitFor({state:'visible'});return image;}
async function point(x,y){const r=await page.locator('#board').boundingBox();return {x:r.x+x*r.width/480,y:r.y+y*r.height/320};}
async function clickDoc(x,y,options){const p=await point(x,y);await page.mouse.click(p.x,p.y,options);}
async function setControl(id,value){await page.locator('#'+id).evaluate((input,value)=>{input.value=String(value);input.dispatchEvent(new Event('input',{bubbles:true}));input.dispatchEvent(new Event('change',{bubbles:true}));},value);}
async function label(content,x=40,y=40){await page.locator('#addText').click();await setControl('textSize',24);await setControl('textColor','#000000');await clickDoc(x,y);await page.locator('#textEditor').fill(content);await page.locator('#textEditor').press('Enter');await page.locator('#textEditor').waitFor({state:'hidden'});}
async function linkExisting(name){await page.locator('#linkReference').click();await page.locator('#referenceDialog').waitFor({state:'visible'});await page.locator('#referenceChoice').selectOption({label:name});await page.locator('#saveReferenceLink').click();await page.locator('#referenceDialog').waitFor({state:'hidden'});}
async function downloadBytes(event){const d=await event,s=await d.createReadStream(),chunks=[];for await(const c of s)chunks.push(c);return {buffer:Buffer.concat(chunks),name:d.suggestedFilename()};}
async function save(){const event=page.waitForEvent('download');await page.locator('#saveProject').click();const result=await downloadBytes(event);await page.waitForTimeout(725);return {...result,data:JSON.parse(result.buffer.toString())};}
async function reopen(saved,count){await page.locator('#newProject').click();await page.locator('#confirmDialog').click();await page.locator('#projectInput').setInputFiles({name:saved.name,mimeType:'application/json',buffer:saved.buffer});await waitLayers(count);}
async function decoded(bytes=null){
  return page.evaluate(async bytes=>{
    let c=document.querySelector('#canvas');if(bytes){const bitmap=await createImageBitmap(new Blob([new Uint8Array(bytes)],{type:'image/png'}));c=document.createElement('canvas');c.width=bitmap.width;c.height=bitmap.height;c.getContext('2d').drawImage(bitmap,0,0);bitmap.close();}
    const pixels=c.getContext('2d').getImageData(0,0,c.width,c.height).data,colors={};
    for(const [name,r,g,b]of [['green',0,255,0],['red',255,0,0],['blue',0,0,255]]){
      let count=0,minX=c.width,minY=c.height,maxX=-1,maxY=-1;
      for(let y=0;y<c.height;y++)for(let x=0;x<c.width;x++){const i=(y*c.width+x)*4;if(pixels[i]===r&&pixels[i+1]===g&&pixels[i+2]===b&&pixels[i+3]===255){count++;minX=Math.min(minX,x);minY=Math.min(minY,y);maxX=Math.max(maxX,x);maxY=Math.max(maxY,y);}}
      colors[name]={count,minX,minY,maxX,maxY};
    }
    const hash=[...new Uint8Array(await crypto.subtle.digest('SHA-256',pixels))].map(x=>x.toString(16).padStart(2,'0')).join('');return {width:c.width,height:c.height,hash,colors};
  },bytes);
}
async function clipboardPng(){const bytes=await page.evaluate(async()=>{const item=(await navigator.clipboard.read()).find(item=>item.types.includes('image/png'));if(!item)throw new Error('Clipboard has no PNG');return [...new Uint8Array(await(await item.getType('image/png')).arrayBuffer())];});return {bytes,decoded:await decoded(bytes)};}
async function copyScene(){await clickDoc(400,270,{button:'right'});await page.locator('#copyImage').click();await page.waitForFunction(()=>/annotations copied/i.test(document.querySelector('#toast').textContent));return clipboardPng();}
async function copyBoard({menu=false}={}){
  if(menu){await clickDoc(400,270,{button:'right'});await page.locator('#copyReferenceBoard').click();}else await page.locator('#copyReferencesTop').click();
  await page.waitForFunction(()=>!document.querySelector('#copyReferencesTop').disabled&&/copied/i.test(document.querySelector('#toast').textContent)&&/reference/i.test(document.querySelector('#toast').textContent));return clipboardPng();
}

test('existing reference opens from its text label, dragging stays editable and double-click editing preserves the link',async()=>{
  await main();const green=await reference('Green reference.png','#00ff00');await label('1');await linkExisting('Green reference.png');
  let saved=await save(),text=saved.data.layers.find(layer=>layer.kind==='text'),ref=saved.data.references[0];assert.equal(text.referenceIds?.[0],ref.id);
  await page.locator('[data-tool=move]').first().click();await clickDoc(48,52);await page.locator('#referenceDialog').waitFor({state:'visible'});
  assert.equal(await page.locator('#referencePreview').getAttribute('src'),green.source);assert.match(await page.locator('#referenceName').innerText(),/Green reference/);
  assert.match(await page.locator('#referenceDialog').innerText(),/copy board/i,'Dialog names the redesigned Copy board action that includes reference photos');
  await page.locator('#closeReferenceDialog').click();
  await clickDoc(48,52);await page.keyboard.press('Escape');await page.waitForTimeout(500);
  assert.equal(await page.locator('#referenceDialog').isVisible(),false,'Escape cancels the delayed reference opening');
  const a=await point(48,52),b=await point(78,72);await page.mouse.move(a.x,a.y);await page.mouse.down();await page.mouse.move(b.x,b.y,{steps:6});await page.mouse.up();await page.waitForTimeout(500);
  assert.equal(await page.locator('#referenceDialog').isVisible(),false,'Dragging a linked number does not open its photo');
  saved=await save();text=saved.data.layers.find(layer=>layer.id===text.id);assert.ok(text.x>40);assert.ok(text.y>40);assert.equal(text.referenceIds?.[0],ref.id);
  await clickDoc(text.x+8,text.y+12,{clickCount:2});await page.locator('#textEditor').waitFor({state:'visible'});assert.equal(await page.locator('#referenceDialog').isVisible(),false);
  await page.locator('#textEditor').fill('12');await page.locator('#textEditor').press('Enter');saved=await save();text=saved.data.layers.find(layer=>layer.id===text.id);assert.equal(text.text.content,'12');assert.equal(text.referenceIds?.[0],ref.id);
});

test('folder photo selection is reversible until Save, then preserves its original bytes and can be unlinked',async()=>{
  await main();await label('2',100,40);const photo=await fixture('Folder photo.png','#ff0000');
  await page.locator('#linkReference').click();await page.locator('#referenceFileInput').setInputFiles(photo.file);
  await page.waitForFunction(source=>document.querySelector('#referencePreview').getAttribute('src')===source,photo.source);
  await page.locator('#closeReferenceDialog').click();let saved=await save();assert.equal(saved.data.references.length,0);assert.equal(saved.data.layers[1].referenceIds?.[0],undefined);
  await page.locator('#linkReference').click();await page.locator('#referenceFileInput').setInputFiles(photo.file);
  await page.waitForFunction(source=>document.querySelector('#referencePreview').getAttribute('src')===source,photo.source);await page.locator('#saveReferenceLink').click();await page.locator('#referenceDialog').waitFor({state:'hidden'});
  saved=await save();assert.equal(saved.data.references.length,1);assert.equal(saved.data.references[0].source,photo.source);assert.equal(saved.data.layers[1].referenceIds?.[0],saved.data.references[0].id);
  await page.locator('#linkReference').click();await page.locator('#unlinkReference').click();await page.locator('#saveReferenceLink').click();await page.locator('#referenceDialog').waitFor({state:'hidden'});
  saved=await save();assert.equal(saved.data.layers[1].referenceIds?.[0],undefined);assert.equal(saved.data.references.length,1,'Unlinking keeps the embedded photo available');
  await page.locator('#undo').click();saved=await save();assert.equal(saved.data.layers[1].referenceIds?.[0],saved.data.references[0].id);
  const broken=structuredClone(saved.data);broken.references[0].width+=10;
  await page.locator('#projectInput').setInputFiles({name:'Wrong reference dimensions.asun',mimeType:'application/json',buffer:Buffer.from(JSON.stringify(broken))});
  await page.waitForFunction(()=>!document.body.classList.contains('busy')&&/reference photo does not match its saved dimensions/i.test(document.querySelector('#toast').textContent));
  assert.deepEqual((await save()).data,saved.data,'A reference with incorrect saved dimensions cannot replace the current project');
});

test('duplicate, project reopen, reference removal and undo keep current and saved-variant links coherent',async()=>{
  await main();await reference('Green reference.png','#00ff00');await label('3');await linkExisting('Green reference.png');
  await page.locator('#variants').click();await page.locator('#saveVariant').click();await page.locator('#variantName').fill('Linked reference variant');await page.locator('#confirmDialog').click();
  await page.locator('#duplicateLayer').click();let saved=await save(),ref=saved.data.references[0];
  assert.equal(saved.data.layers.filter(layer=>layer.referenceIds?.[0]===ref.id).length,2);assert.equal(saved.data.variants[0].layers.find(layer=>layer.kind==='text').referenceIds?.[0],ref.id);
  await reopen(saved,3);await page.getByRole('button',{name:'Remove reference Green reference.png',exact:true}).click();saved=await save();
  assert.equal(saved.data.references.length,0);assert.ok(saved.data.layers.every(layer=>layer.referenceIds?.[0]===undefined));assert.ok(saved.data.variants.every(variant=>variant.layers.every(layer=>layer.referenceIds?.[0]===undefined)));
  await page.locator('#undo').click();saved=await save();assert.equal(saved.data.references[0].id,ref.id);assert.equal(saved.data.layers.filter(layer=>layer.referenceIds?.[0]===ref.id).length,2);assert.equal(saved.data.variants[0].layers.find(layer=>layer.kind==='text').referenceIds?.[0],ref.id);
  await page.locator('#deleteLayer').click();saved=await save();assert.equal(saved.data.layers.length,2);assert.equal(saved.data.references.length,1,'Deleting a label does not discard its embedded photo');
  await reopen(saved,2);await page.locator('[data-tool=move]').first().click();await clickDoc(48,52);await page.locator('#referenceDialog').waitFor({state:'visible'});assert.match(await page.locator('#referenceName').innerText(),/Green reference/);await page.locator('#closeReferenceDialog').click();
});

test('scene plus references clipboard groups shared labels, excludes hidden or unused photos and leaves ordinary image copy unchanged',async()=>{
  await main();await reference('Green reference.png','#00ff00');await reference('Red reference.png','#ff0000');await reference('Unused blue.png','#0000ff');
  await label('1',40,40);await linkExisting('Green reference.png');await label('2',100,40);await linkExisting('Green reference.png');await label('3',160,40);await linkExisting('Red reference.png');
  await page.locator('#linkReference').click();await page.screenshot({path:path.join(qa,'linked-reference-1672.png')});
  await page.setViewportSize({width:1280,height:800});assert.equal(await page.locator('#refCanvas').isVisible(),true);assert.equal(await page.locator('#closeReferenceDialog').isVisible(),true);
  await page.screenshot({path:path.join(qa,'linked-reference-1280.png')});await page.locator('#closeReferenceDialog').click();await page.screenshot({path:path.join(qa,'linked-labels-editor-1280.png')});await page.setViewportSize({width:1672,height:941});
  const saved=await save(),normal=await copyScene();assert.deepEqual(normal.decoded,await decoded());assert.deepEqual([normal.decoded.width,normal.decoded.height],[480,320]);
  const board=await copyBoard();assert.ok(board.decoded.width>480);assert.ok(board.decoded.height>320);
  for(const color of ['green','red']){const s=board.decoded.colors[color];assert.ok(s.count>1000,`Board includes actual ${color} reference image pixels`);assert.equal(s.count,(s.maxX-s.minX+1)*(s.maxY-s.minY+1),`Shared labels render one rectangular ${color} photo, not duplicate cards`);}
  assert.equal(board.decoded.colors.blue.count,0,'Unused reference image is not copied');
  const grouping=await page.evaluate(async saved=>(await import('/reference-board.mjs')).linkedReferences(saved).map(group=>({name:group.reference.name,labels:group.labels})),saved.data);
  assert.deepEqual(grouping,[{name:'Green reference.png',labels:['1','2']},{name:'Red reference.png',labels:['3']}]);
  await page.evaluate(async bytes=>{const blob=new Blob([new Uint8Array(bytes)],{type:'image/png'});const url=URL.createObjectURL(blob);window.__boardPreview=url;const img=document.createElement('img');img.id='referenceBoardTestPreview';img.src=url;img.style.cssText='position:fixed;inset:0;max-width:100vw;max-height:100vh;object-fit:contain;background:white;z-index:99999';document.body.append(img);},board.bytes);
  await page.locator('#referenceBoardTestPreview').screenshot({path:path.join(qa,'scene-and-grouped-references.png')});await page.locator('#referenceBoardTestPreview').evaluate(img=>{img.remove();URL.revokeObjectURL(window.__boardPreview);});
  const redLabel=saved.data.layers.find(layer=>layer.kind==='text'&&layer.text.content==='3');await page.locator(`.layer-row[data-id="${redLabel.id}"] .visibility`).click();
  const hiddenBoard=await copyBoard({menu:true});assert.ok(hiddenBoard.decoded.colors.green.count>1000);assert.equal(hiddenBoard.decoded.colors.red.count,0,'A hidden linked label does not include its reference');
  const after=await copyScene();assert.deepEqual(after.decoded,await decoded());assert.deepEqual([after.decoded.width,after.decoded.height],[480,320]);
});

test('reference board clipboard denial preserves the project and its download fallback carries the same photo pixels',async()=>{
  await main();await reference('Green reference.png','#00ff00');await label('7');await linkExisting('Green reference.png');const expected=await copyBoard(),before=await save();
  await page.evaluate(()=>Object.defineProperty(navigator.clipboard,'write',{configurable:true,value:async()=>{throw new DOMException('Test clipboard denied','NotAllowedError');}}));
  await page.locator('#copyReferencesTop').click();await page.waitForFunction(()=>document.querySelector('#toast').classList.contains('error')&&/download|clipboard/i.test(document.querySelector('#toast').textContent));
  let saved=await save();assert.deepEqual(saved.data,before.data);
  await clickDoc(400,270,{button:'right'});const event=page.waitForEvent('download');await page.locator('#downloadReferenceBoard').click();const downloaded=await downloadBytes(event);
  assert.deepEqual(await decoded([...downloaded.buffer]),expected.decoded);saved=await save();assert.deepEqual(saved.data,before.data);
});

test('a new blank draft never targets the previous linked label and Link confirms the new number first',async()=>{
  await main();await reference('Green reference.png','#00ff00');await label('1',40,40);await linkExisting('Green reference.png');
  await page.locator('#addText').click();await clickDoc(160,100);
  assert.equal(await page.locator('#textEditor').inputValue(),'');assert.equal(await page.locator('#linkReference').isDisabled(),true);
  assert.doesNotMatch(await page.locator('#linkReference').innerText(),/view reference/i,'A new empty draft does not expose the old label link');
  await page.locator('#textEditor').fill('2');assert.equal(await page.locator('#linkReference').isDisabled(),false);
  await page.locator('#linkReference').click();await page.locator('#referenceDialog').waitFor({state:'visible'});
  assert.match(await page.locator('#referenceAreaLabel').innerText(),/2/);assert.equal(await page.locator('#referenceChoice').inputValue(),'','The new number starts without the previous label link');
  await page.locator('#referenceChoice').selectOption({label:'Green reference.png'});await page.locator('#saveReferenceLink').click();await page.locator('#referenceDialog').waitFor({state:'hidden'});
  const saved=await save(),texts=saved.data.layers.filter(layer=>layer.kind==='text');assert.deepEqual(texts.map(layer=>layer.text.content),['1','2']);
  assert.ok(Math.abs(texts[1].x-160)<=1&&Math.abs(texts[1].y-100)<=1);assert.equal(texts[0].referenceIds?.[0],saved.data.references[0].id);assert.equal(texts[1].referenceIds?.[0],saved.data.references[0].id);
});
