import {test,before,after,beforeEach,afterEach} from 'node:test';
import assert from 'node:assert/strict';
import {mkdir} from 'node:fs/promises';
import {inflateRawSync} from 'node:zlib';
import path from 'node:path';
import {chromium} from 'playwright';
import {createServer} from '../server.mjs';

let server,browser,context,page,base,errors;
const qa=path.resolve('qa','sheet-creation');
before(async()=>{
  await mkdir(qa,{recursive:true});
  server=createServer({detection:{token:'sheet-test',status:async()=>({available:false}),dispose(){}}});
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  base=`http://127.0.0.1:${server.address().port}`;
  browser=await chromium.launch({headless:true});
});
after(async()=>{await browser?.close();if(server)await new Promise(resolve=>server.close(resolve));});
beforeEach(async()=>{
  errors=[];context=await browser.newContext({viewport:{width:1440,height:1000},acceptDownloads:true});
  page=await context.newPage();page.on('pageerror',error=>errors.push(error.message));
  await page.route('**/api/sheets/status',route=>route.fulfill({json:{configured:false,authenticated:false,models:[],message:'No API connection in this isolated test.',token:'test'}}));
  await page.goto(base);await page.waitForFunction(()=>document.documentElement.dataset.ready==='true');
  if(await page.locator('#skipStartup').isVisible())await page.locator('#skipStartup').click();
});
afterEach(async info=>{
  try{if(info.error)await page.screenshot({path:path.join(qa,'failure-'+info.name.replace(/\W+/g,'-')+'.png')});assert.deepEqual(errors,[]);}
  finally{await context?.close();}
});
async function downloaded(pending){
  const item=await pending,stream=await item.createReadStream(),chunks=[];
  for await(const chunk of stream)chunks.push(chunk);
  return {name:item.suggestedFilename(),buffer:Buffer.concat(chunks)};
}
async function save(){
  const pending=page.waitForEvent('download');await page.locator('#saveProject').click();
  const result=await downloaded(pending);await page.waitForTimeout(725);
  return {...result,project:JSON.parse(result.buffer.toString())};
}
function unzip(zip){
  let end=zip.length-22;
  while(end>=Math.max(0,zip.length-65557)&&zip.readUInt32LE(end)!==0x06054b50)end--;
  assert.ok(end>=0,'ZIP end record is present');
  let cursor=zip.readUInt32LE(end+16);const entries=new Map();
  for(let count=zip.readUInt16LE(end+10);count>0;count--){
    assert.equal(zip.readUInt32LE(cursor),0x02014b50);
    const method=zip.readUInt16LE(cursor+10),compressedSize=zip.readUInt32LE(cursor+20),size=zip.readUInt32LE(cursor+24),nameLength=zip.readUInt16LE(cursor+28),extraLength=zip.readUInt16LE(cursor+30),commentLength=zip.readUInt16LE(cursor+32),offset=zip.readUInt32LE(cursor+42);
    const name=zip.subarray(cursor+46,cursor+46+nameLength).toString();
    assert.equal(zip.readUInt32LE(offset),0x04034b50);assert.ok(method===0||method===8);
    const start=offset+30+zip.readUInt16LE(offset+26)+zip.readUInt16LE(offset+28),compressed=zip.subarray(start,start+compressedSize),buffer=method===8?inflateRawSync(compressed):compressed;
    assert.equal(buffer.length,size);assert.ok(!entries.has(name));entries.set(name,buffer);
    cursor+=46+nameLength+extraLength+commentLength;
  }
  return entries;
}
async function assertReadableDownload(){
  const button=page.locator('[data-sheet-action="download"]');await button.hover();
  await button.evaluate(element=>Promise.all(element.getAnimations().map(animation=>animation.finished.catch(()=>{}))));
  const colors=await button.evaluate(element=>{const style=getComputedStyle(element);return {foreground:style.color,background:style.backgroundColor};});
  const luminance=value=>{
    const rgb=value.match(/[\d.]+/g).slice(0,3).map(Number).map(number=>{const v=number/255;return v<=.04045?v/12.92:((v+.055)/1.055)**2.4;});
    return .2126*rgb[0]+.7152*rgb[1]+.0722*rgb[2];
  };
  const values=[luminance(colors.foreground),luminance(colors.background)].sort((a,b)=>b-a);
  assert.ok((values[0]+.05)/(values[1]+.05)>=4.5,`Download label remains readable on hover: ${JSON.stringify(colors)}`);
}

test('Create offers the sheet card and retains the existing blank-canvas editor',async()=>{
  await page.locator('#newProject').click();
  assert.equal(await page.locator('#desktopCreateDialog').isVisible(),true);
  assert.equal(await page.locator('#desktopCreateDialog [data-sheet-creation-card]').isVisible(),true);
  await page.screenshot({path:path.join(qa,'windows-create-card.png')});
  await page.locator('.desktop-create-blank').click();
  assert.equal(await page.locator('#desktopCreateDialog').isVisible(),false);
  assert.equal(await page.locator('#dialogTitle').innerText(),'Create a canvas');
  await page.locator('#nameField').fill('Blank canvas remains available');
  await page.locator('#widthField').fill('600');await page.locator('#heightField').fill('400');
  await page.locator('#confirmDialog').click();
  const result=await save();
  assert.equal(result.project.name,'Blank canvas remains available');
  assert.deepEqual([result.project.width,result.project.height],[600,400]);
  assert.deepEqual(result.project.layers,[]);
});

test('opening the Creation card preserves the imported original and existing prompt',async()=>{
  const png=await page.evaluate(()=>{const c=document.createElement('canvas');c.width=320;c.height=240;const ctx=c.getContext('2d');ctx.fillStyle='#efaa6a';ctx.fillRect(0,0,320,240);return c.toDataURL('image/png');});
  const buffer=Buffer.from(png.split(',')[1],'base64');
  await page.locator('#imageInput').setInputFiles({name:'Original subject.png',mimeType:'image/png',buffer});
  await page.waitForFunction(()=>document.querySelectorAll('.layer-row').length===1&&!document.body.classList.contains('busy'));
  await page.locator('#prompt').fill('Retain this unrelated image-edit prompt.');await page.locator('#prompt').dispatchEvent('change');
  const before=await save();
  await page.locator('#newProject').click();await page.locator('#desktopCreateDialog [data-sheet-creation-card]').click();
  assert.equal(await page.locator('#desktopCreateDialog').isVisible(),false);
  assert.equal(await page.locator('#asunSheetCreator').isVisible(),true);
  await page.locator('[data-sheet-views="7"]').click();
  await page.locator('[data-sheet-subject="character"]').click();
  await page.locator('[data-sheet-notes]').fill('Preserve the original outfit.');
  const packPending=page.waitForEvent('download');await page.locator('[data-sheet-action="download"]').click();
  const pack=await downloaded(packPending);assert.match(pack.name,/Character item sheet\.zip$/);
  const entries=unzip(pack.buffer),sheet=JSON.parse(entries.get('sheet.json').toString());
  assert.equal(sheet.preset.subject,'character');assert.equal(sheet.preset.views,7);
  assert.equal(sheet.angles.length,7);assert.equal(new Set(sheet.angles).size,7);
  assert.deepEqual(entries.get(sheet.cleanMain.path),buffer,'The exact original photo is in the ZIP.');
  assert.match(entries.get('request.txt').toString(),/WHITE \(#FFFFFF\) background/);
  assert.match(entries.get('request.txt').toString(),/Preserve the original outfit/);
  assert.deepEqual(sheet.numbers,[],'A sheet request does not need numbered edits.');
  await page.waitForFunction(()=>document.querySelector('#asunSheetCreator').getAttribute('aria-busy')==='false');
  await assertReadableDownload();
  await page.screenshot({path:path.join(qa,'windows-sheet-settings.png')});
  // The sheet panel cannot leak normal Delete shortcuts to the selected photo.
  await page.locator('#asunSheetCreator').press('Delete');
  assert.equal(await page.locator('.layer-row').count(),1);
  await page.locator('#asunSheetCreator').press('Escape');
  const after=await save();
  assert.equal(after.project.original.assetId,before.project.original.assetId);
  assert.deepEqual(after.project.layers,before.project.layers);
  assert.equal(after.project.prompt,before.project.prompt);
  assert.equal(after.project.assets[after.project.original.assetId].source,png);
  assert.ok(after.project.sheetPreset,'Sheet settings save in the editable project.');
  assert.equal(after.project.sheetPreset.views,7);
  await page.locator('#newProject').click();await page.locator('#desktopCreateDialog .desktop-create-image-edit:not([id])').click();
  const returned=await save();assert.equal(returned.project.sheetPreset.active,false);
  assert.deepEqual(returned.project.layers,before.project.layers);
  await page.locator('#themeToggle').click();
  await page.locator('#newProject').click();await page.locator('#desktopCreateDialog [data-sheet-creation-card]').click();
  await assertReadableDownload();
  await page.screenshot({path:path.join(qa,'windows-sheet-settings-dark.png')});
});

test('a new sheet imports its main photo and selected references without requiring a numbered area',async()=>{
  const png=await page.evaluate(()=>{const c=document.createElement('canvas');c.width=90;c.height=120;const ctx=c.getContext('2d');ctx.fillStyle='#67afa7';ctx.fillRect(0,0,90,120);return c.toDataURL('image/png');});
  const buffer=Buffer.from(png.split(',')[1],'base64');
  await page.locator('#newProject').click();await page.locator('[data-sheet-creation-card]').click();
  await page.locator('[data-sheet-source-input]').setInputFiles({name:'New subject.png',mimeType:'image/png',buffer});
  await page.waitForFunction(()=>document.querySelector('.sheet-source-card')&&document.querySelector('#asunSheetCreator').getAttribute('aria-busy')==='false');
  await page.locator('[data-sheet-reference-input]').setInputFiles({name:'Side view.png',mimeType:'image/png',buffer});
  await page.waitForFunction(()=>document.querySelectorAll('[data-sheet-reference]:checked').length===1&&document.querySelector('#asunSheetCreator').getAttribute('aria-busy')==='false');
  await page.locator('[data-sheet-action="close"]').click();
  const saved=await save();
  assert.equal(saved.project.assets[saved.project.original.assetId].source,png);
  assert.equal(saved.project.references.length,1);
  assert.deepEqual(saved.project.sheetPreset.referenceIds,[saved.project.references[0].id]);
  assert.equal(saved.project.references[0].source,png);
  assert.equal(saved.project.layers.length,1);
  assert.equal(saved.project.layers[0].kind,'raster');
});
