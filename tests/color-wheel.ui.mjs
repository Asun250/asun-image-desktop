import {test,before,after,beforeEach,afterEach} from 'node:test';
import assert from 'node:assert/strict';
import {mkdir} from 'node:fs/promises';
import path from 'node:path';
import {chromium} from 'playwright';
import {createServer} from '../server.mjs';

let server,browser,context,page,base,errors;
const qa=path.resolve('qa','color-wheel');
before(async()=>{
  await mkdir(qa,{recursive:true});server=createServer();
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  base=`http://127.0.0.1:${server.address().port}`;
  browser=await chromium.launch({headless:true});
});
after(async()=>{await browser?.close();if(server)await new Promise(resolve=>server.close(resolve));});
beforeEach(async()=>{
  errors=[];context=await browser.newContext({viewport:{width:1672,height:941},acceptDownloads:true});
  page=await context.newPage();page.on('pageerror',error=>errors.push(error.message));
  page.on('request',request=>{if(!request.url().startsWith(base)&&!request.url().startsWith('data:')&&!request.url().startsWith('blob:'))errors.push('Unexpected remote request: '+request.url());});
  await page.goto(base);await page.waitForFunction(()=>document.documentElement.dataset.ready==='true');
});
afterEach(async(info)=>{
  try{if(info.error)await page.screenshot({path:path.join(qa,'failure-'+info.name.replace(/\W+/g,'-')+'.png')});assert.deepEqual(errors,[]);}
  finally{await context?.close();}
});

async function importWhite(){
  const source=await page.evaluate(()=>{
    const c=document.createElement('canvas');c.width=480;c.height=320;
    const ctx=c.getContext('2d');ctx.fillStyle='#ffffff';ctx.fillRect(0,0,c.width,c.height);return c.toDataURL('image/png');
  });
  await page.locator('#imageInput').setInputFiles({name:'Number color test.png',mimeType:'image/png',buffer:Buffer.from(source.split(',')[1],'base64')});
  await page.waitForFunction(()=>!document.body.classList.contains('busy')&&document.querySelectorAll('.layer-row').length===1&&document.querySelector('#canvas').width===480);
}
async function clickDoc(x,y,options){const b=await page.locator('#board').boundingBox();assert.ok(b);await page.mouse.click(b.x+x*b.width/480,b.y+y*b.height/320,options);}
async function addText(content,x,y){await clickDoc(x,y);await page.locator('#textEditor').fill(content);await page.locator('#textEditor').press('Enter');await page.locator('#textEditor').waitFor({state:'hidden'});}
async function setControl(id,value){await page.locator('#'+id).evaluate((input,value)=>{input.value=String(value);input.dispatchEvent(new Event('input',{bubbles:true}));input.dispatchEvent(new Event('change',{bubbles:true}));},value);}
async function digest(){return page.locator('#canvas').evaluate(async c=>[...new Uint8Array(await crypto.subtle.digest('SHA-256',c.getContext('2d').getImageData(0,0,c.width,c.height).data))].map(v=>v.toString(16).padStart(2,'0')).join(''));}
async function waitDigest(expected){await page.waitForFunction(async expected=>{const c=document.querySelector('#canvas'),value=[...new Uint8Array(await crypto.subtle.digest('SHA-256',c.getContext('2d').getImageData(0,0,c.width,c.height).data))].map(v=>v.toString(16).padStart(2,'0')).join('');return value===expected;},expected);}
async function waitChanged(previous){await page.waitForFunction(async previous=>{const c=document.querySelector('#canvas'),value=[...new Uint8Array(await crypto.subtle.digest('SHA-256',c.getContext('2d').getImageData(0,0,c.width,c.height).data))].map(v=>v.toString(16).padStart(2,'0')).join('');return value!==previous;},previous);}
async function countSolidColor(hex){return page.locator('#canvas').evaluate((c,hex)=>{const rgb=hex.match(/\w\w/g).map(v=>parseInt(v,16)),pixels=c.getContext('2d').getImageData(0,0,c.width,c.height).data;let count=0;for(let i=0;i<pixels.length;i+=4)if(pixels[i]===rgb[0]&&pixels[i+1]===rgb[1]&&pixels[i+2]===rgb[2]&&pixels[i+3]===255)count++;return count;},hex.replace('#',''));}
async function saveProject(){
  const event=page.waitForEvent('download');await page.locator('#saveProject').click();const download=await event,stream=await download.createReadStream(),chunks=[];
  for await(const chunk of stream)chunks.push(chunk);const buffer=Buffer.concat(chunks);
  await page.waitForTimeout(725);return {data:JSON.parse(buffer.toString()),buffer,name:download.suggestedFilename()};
}
async function reopen(saved,count){await page.locator('#newProject').click();await page.locator('#confirmDialog').click();await page.locator('#projectInput').setInputFiles({name:saved.name,mimeType:'application/json',buffer:saved.buffer});await page.waitForFunction(count=>!document.body.classList.contains('busy')&&document.querySelectorAll('.layer-row').length===count,count);}
async function decodePng(bytes){return page.evaluate(async bytes=>{const bitmap=await createImageBitmap(new Blob([new Uint8Array(bytes)],{type:'image/png'})),c=document.createElement('canvas');c.width=bitmap.width;c.height=bitmap.height;const ctx=c.getContext('2d');ctx.drawImage(bitmap,0,0);bitmap.close();const hash=[...new Uint8Array(await crypto.subtle.digest('SHA-256',ctx.getImageData(0,0,c.width,c.height).data))].map(v=>v.toString(16).padStart(2,'0')).join('');return {width:c.width,height:c.height,hash};},bytes);}
async function openWheel(){await page.locator('#textColorWheel').click();await page.locator('#colorPicker').waitFor({state:'visible'});assert.equal(await page.locator('#colorPicker').evaluate(d=>d.open),true);}
async function chooseBlue(){
  await setControl('colorBrightness',100);const w=await page.locator('#colorWheelCanvas').boundingBox();assert.ok(w);
  // Real pointer input: hue 240 degrees is upper-left, full saturation at the edge.
  const radius=Math.min(w.width,w.height)/2-3,angle=240*Math.PI/180;
  await page.mouse.click(w.x+w.width/2+Math.cos(angle)*radius,w.y+w.height/2+Math.sin(angle)*radius);
  const hex=await page.locator('#colorHex').inputValue(),rgb=hex.replace('#','').match(/\w\w/g).map(v=>parseInt(v,16));
  assert.ok(rgb[2]>240&&rgb[0]<15&&rgb[1]<15,`Wheel chooses blue, received ${hex}`);return hex.toLowerCase();
}
function withoutColor(item){const next=structuredClone(item);delete next.text.color;return next;}

test('color wheel recolors a selected number with real pixels, preserving transforms, undo, project, export and clipboard',async()=>{
  await context.grantPermissions(['clipboard-write'],{origin:base});await importWhite();await page.locator('#addText').click();await setControl('textSize',48);await addText('1',65,60);
  await page.locator('[data-tool=move]').first().click();assert.equal(await page.locator('#textColorWheel').isVisible(),true,'Selected numbers expose the wheel in Select mode');
  await page.locator('#showProperties').click();await setControl('layerX',82);await setControl('layerY',71);await page.locator('#lockRatio').uncheck();await setControl('layerW',100);await setControl('layerH',125);
  const before=await saveProject(),number=before.data.layers.find(l=>l.kind==='text'),orangeHash=await digest();
  assert.equal(number.text.content,'1');assert.equal(number.text.color,'#eba76f');assert.ok(await countSolidColor('#eba76f')>30,'The original orange is rendered');
  await openWheel();const chosen=await chooseBlue();await page.locator('#applyColor').click();await page.locator('#colorPicker').waitFor({state:'hidden'});await waitChanged(orangeHash);
  assert.ok(await countSolidColor(chosen)>30,'The selected blue appears in the actual composite');assert.equal(await countSolidColor('#eba76f'),0);
  const blueHash=await digest(),after=await saveProject(),recolored=after.data.layers.find(l=>l.id===number.id);
  assert.equal(recolored.text.color.toLowerCase(),chosen);assert.deepEqual(withoutColor(recolored),withoutColor(number),'Color changes retain editable words, size, masks and every transform');
  await page.locator('#undo').click();await waitDigest(orangeHash);await page.locator('#redo').click();await waitDigest(blueHash);
  await reopen(after,2);await waitDigest(blueHash);
  await page.locator('#export').click();await page.locator('#formatField').selectOption('png');const event=page.waitForEvent('download');await page.locator('#confirmDialog').click();const download=await event,stream=await download.createReadStream(),chunks=[];for await(const chunk of stream)chunks.push(chunk);
  assert.deepEqual(await decodePng([...Buffer.concat(chunks)]),{width:480,height:320,hash:blueHash},'Export includes the chosen number color');
  await clickDoc(400,280,{button:'right'});await page.locator('#copyImage').click();await page.waitForFunction(()=>/copied/i.test(document.querySelector('#toast').textContent));
  await context.grantPermissions(['clipboard-read'],{origin:base});const bytes=await page.evaluate(async()=>{const item=(await navigator.clipboard.read()).find(item=>item.types.includes('image/png'));return Array.from(new Uint8Array(await(await item.getType('image/png')).arrayBuffer()));});
  assert.deepEqual(await decodePng(bytes),{width:480,height:320,hash:blueHash},'Right-click copy includes the chosen number color');
});

test('Cancel and Escape restore a draft color without losing the typed number; applied color carries to more labels',async()=>{
  await importWhite();await page.locator('#addText').click();await clickDoc(65,60);await page.locator('#textEditor').fill('2');const original=await page.locator('#textColor').inputValue();
  await openWheel();await page.locator('#colorHex').fill('#ff00ff');assert.equal(await page.locator('#textEditor').evaluate(e=>getComputedStyle(e).color),'rgb(255, 0, 255)','Draft previews the candidate');
  assert.equal(await page.locator('.layer-row').count(),1,'Opening the palette does not commit the draft');await page.locator('#cancelColor').click();
  assert.equal(await page.locator('#textEditor').inputValue(),'2');assert.equal(await page.locator('#textColor').inputValue(),original);assert.equal(await page.locator('#textEditor').isVisible(),true);
  await openWheel();await page.locator('#colorHex').fill('#20c050');await page.keyboard.press('Escape');await page.locator('#colorPicker').waitFor({state:'hidden'});
  assert.equal(await page.locator('#textEditor').isVisible(),true);assert.equal(await page.locator('#textEditor').inputValue(),'2');assert.equal(await page.locator('#textColor').inputValue(),original);
  await page.locator('#textEditor').press('Enter');const first=await saveProject();assert.equal(first.data.layers.find(l=>l.kind==='text').text.color,original);
  // Select the source image before choosing a default, so the older label stays orange.
  const image=first.data.layers.find(l=>l.kind==='raster');await page.locator(`.layer-row[data-id="${image.id}"]`).click();await openWheel();await page.locator('#colorHex').fill('#20c050');await page.locator('#applyColor').click();await addText('3',200,60);await addText('4',335,60);
  const saved=await saveProject(),numbers=saved.data.layers.filter(l=>l.kind==='text');assert.deepEqual(numbers.map(l=>l.text.content),['2','3','4']);assert.deepEqual(numbers.map(l=>l.text.color.toLowerCase()),[original,'#20c050','#20c050']);
  const coloredHash=await digest();await reopen(saved,4);await waitDigest(coloredHash);
});

test('brightness reaches black and the center reaches white; invalid hex cannot change annotations',async()=>{
  await importWhite();await page.locator('#addText').click();await addText('0',65,60);await page.locator('[data-tool=move]').first().click();const original=await digest();
  await openWheel();await page.locator('#colorHex').fill('invalid');assert.equal(await page.locator('#applyColor').isDisabled(),true);await page.locator('#colorHex').press('Enter');assert.equal(await page.locator('#colorPicker').evaluate(d=>d.open),true);await page.locator('#cancelColor').click();assert.equal(await digest(),original);
  await openWheel();await setControl('colorBrightness',0);assert.equal((await page.locator('#colorHex').inputValue()).toLowerCase(),'#000000');await page.locator('#applyColor').click();await waitChanged(original);assert.ok(await countSolidColor('#000000')>20,'Black numbers are rendered');const black=await digest();
  await openWheel();await setControl('colorBrightness',100);const wheel=await page.locator('#colorWheelCanvas').boundingBox();await page.mouse.click(wheel.x+wheel.width/2,wheel.y+wheel.height/2);assert.equal((await page.locator('#colorHex').inputValue()).toLowerCase(),'#ffffff');await page.locator('#applyColor').click();await waitChanged(black);assert.equal(await countSolidColor('#000000'),0);assert.equal(await countSolidColor('#ffffff'),480*320,'White numbers blend into a white source');
  const white=await saveProject();assert.equal(white.data.layers.find(l=>l.kind==='text').text.color.toLowerCase(),'#ffffff');await page.locator('#undo').click();await waitDigest(black);
});

test('the applied default survives selection of an older orange number when placing another number',async()=>{
  await importWhite();await page.locator('#addText').click();await addText('1',65,60);await addText('2',200,60);
  const original=await saveProject(),numbers=original.data.layers.filter(l=>l.kind==='text');await page.locator('[data-tool=move]').first().click();
  await page.locator(`.layer-row[data-id="${numbers[0].id}"]`).click();await openWheel();await page.locator('#colorHex').fill('#0000ff');await page.locator('#applyColor').click();
  await page.locator(`.layer-row[data-id="${numbers[1].id}"]`).click();assert.equal(await page.locator('#textColor').inputValue(),'#eba76f','Selected older number shows its own orange');
  await page.locator('#addText').click();await addText('3',335,60);const saved=await saveProject(),final=saved.data.layers.filter(l=>l.kind==='text');
  assert.deepEqual(final.map(l=>l.text.content),['1','2','3']);assert.deepEqual(final.map(l=>l.text.color.toLowerCase()),['#0000ff','#eba76f','#0000ff'],'Selecting older text does not overwrite the chosen default or recolor it');
  assert.deepEqual(withoutColor(final[1]),withoutColor(numbers[1]),'The older orange number stays fully unchanged');
});

test('Enter on Cancel cancels, and Enter on a preset selects its color without prematurely applying it',async()=>{
  await importWhite();await page.locator('#addText').click();await addText('1',65,60);await page.locator('[data-tool=move]').first().click();const orange=await digest();
  await openWheel();await page.locator('#colorHex').fill('#0000ff');await page.locator('#cancelColor').focus();await page.keyboard.press('Enter');await page.locator('#colorPicker').waitFor({state:'hidden'});
  assert.equal(await digest(),orange,'Cancel keeps the number orange');assert.equal(await page.locator('#textColor').inputValue(),'#eba76f');
  await openWheel();const preset=page.locator('#colorPicker [data-color="#2196F3"]');await preset.focus();await page.keyboard.press('Enter');
  assert.equal(await page.locator('#colorPicker').evaluate(d=>d.open),true,'A preset remains in the dialog for review');assert.equal((await page.locator('#colorHex').inputValue()).toUpperCase(),'#2196F3');
  assert.equal(await digest(),orange,'Preset selection waits for Apply');await page.locator('#applyColor').focus();await page.keyboard.press('Enter');await page.locator('#colorPicker').waitFor({state:'hidden'});await waitChanged(orange);
  assert.ok(await countSolidColor('#2196F3')>20,'Explicit keyboard Apply renders the chosen preset');
  const saved=await saveProject();assert.equal(saved.data.layers.find(l=>l.kind==='text').text.color.toUpperCase(),'#2196F3');
});

test('wheel controls are accessible, visible and contained at desktop and 1280 by 800',async()=>{
  await importWhite();await page.locator('#addText').click();await addText('1',70,70);await page.locator('[data-tool=move]').first().click();
  for(const viewport of [{width:1672,height:941},{width:1280,height:800}]){
    await page.setViewportSize(viewport);await openWheel();
    const dialog=await page.locator('#colorPicker').boundingBox();assert.ok(dialog.x>=0&&dialog.y>=0&&dialog.x+dialog.width<=viewport.width&&dialog.y+dialog.height<=viewport.height,'The full wheel fits the viewport');
    assert.ok(await page.locator('#colorPicker').getAttribute('aria-labelledby'),'Color dialog has an accessible name');
    for(const selector of ['#colorWheelCanvas','#colorBrightness','#colorHex','#colorPreview','#applyColor','#cancelColor']){
      const control=page.locator(selector);assert.equal(await control.isVisible(),true,`${selector} is visible`);const rect=await control.boundingBox();assert.ok(rect.x>=dialog.x&&rect.y>=dialog.y&&rect.x+rect.width<=dialog.x+dialog.width+1&&rect.y+rect.height<=dialog.y+dialog.height+1,`${selector} stays within the dialog`);
    }
    assert.ok(await page.locator('#colorWheelCanvas').getAttribute('aria-label'),'Wheel has accessible keyboard guidance');assert.equal(await page.locator('#colorWheelCanvas').getAttribute('tabindex'),'0');
    assert.ok(await page.locator('#colorPicker [data-color]').count()>=6,'Common colors remain quick to select');
    await page.screenshot({path:path.join(qa,`color-wheel-${viewport.width}.png`)});
    const hue=Number(await page.locator('#colorHue').inputValue()),saturation=Number(await page.locator('#colorSaturation').inputValue());
    await page.locator('#colorWheelCanvas').focus();await page.keyboard.press('ArrowRight');assert.equal(Number(await page.locator('#colorHue').inputValue()),hue+1,'Keyboard can change hue');
    await page.keyboard.press('Shift+ArrowDown');assert.equal(Number(await page.locator('#colorSaturation').inputValue()),saturation-1,'Keyboard can change saturation');
    await page.locator('#cancelColor').click();
    const options=await page.locator('#textOptions').boundingBox();assert.ok(options.x>=0&&options.x+options.width<=viewport.width,'Text color entry point fits compact toolbar');
  }
});
