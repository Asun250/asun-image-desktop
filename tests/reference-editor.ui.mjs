import {test,before,after,beforeEach,afterEach} from 'node:test';
import assert from 'node:assert/strict';
import {mkdir} from 'node:fs/promises';
import path from 'node:path';
import {chromium} from 'playwright';
import {createServer} from '../server.mjs';

let server,browser,context,page,base,errors;
const qa=path.resolve('qa','reference-editor');
before(async()=>{await mkdir(qa,{recursive:true});server=createServer();await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));base=`http://127.0.0.1:${server.address().port}`;browser=await chromium.launch({headless:true});});
after(async()=>{await browser?.close();if(server)await new Promise(resolve=>server.close(resolve));});
beforeEach(async()=>{
  errors=[];context=await browser.newContext({viewport:{width:1672,height:941}});page=await context.newPage();page.on('pageerror',error=>errors.push(error.message));
  await page.goto(base+'/health');
  await page.evaluate(async()=>{
    document.body.innerHTML='<div id="referenceWidgetHost" style="width:640px;max-width:calc(100vw - 40px);margin:20px"></div>';
    for(const file of ['editor.css','color-wheel.css']){const link=document.createElement('link');link.rel='stylesheet';link.href='/'+file;document.head.append(link);}
    window.refChanges=[];window.refErrors=[];
    const {createReferenceEditor}=await import('/reference-editor.mjs');window.widget=createReferenceEditor(document.querySelector('#referenceWidgetHost'),{onChange:layers=>window.refChanges.push(layers),onError:error=>window.refErrors.push(error.message)});
    window.makeReference=(id,color='#ffffff')=>{const c=document.createElement('canvas');c.width=480;c.height=320;const ctx=c.getContext('2d');ctx.fillStyle=color;ctx.fillRect(0,0,480,320);return {id,name:id+'.png',source:c.toDataURL('image/png'),width:480,height:320,annotations:[]};};
    window.originalReference=window.makeReference('First');await window.widget.load(window.originalReference);
  });
  await page.waitForFunction(()=>document.querySelector('#referenceWidgetHost').dataset.refReady==='true');
});
afterEach(async(info)=>{try{if(info.error)await page.screenshot({path:path.join(qa,'failure-'+info.name.replace(/\W+/g,'-')+'.png')});assert.deepEqual(errors,[]);}finally{await context?.close();}});
async function tool(name){await page.locator(`[data-ref-tool=${name}]`).click();}
async function control(id,value){await page.locator('#'+id).evaluate((input,value)=>{input.value=String(value);input.dispatchEvent(new Event('input',{bubbles:true}));input.dispatchEvent(new Event('change',{bubbles:true}));},value);}
async function point(x,y){const r=await page.locator('#refCanvasBoard').boundingBox();return {x:r.x+x*r.width/480,y:r.y+y*r.height/320};}
async function click(x,y,options){const p=await point(x,y);await page.mouse.click(p.x,p.y,options);}
async function text(content,x=40,y=40){await tool('text');await click(x,y);await page.locator('#refTextEditor').fill(content);await page.locator('#refTextEditor').press('Enter');await page.locator('#refTextEditor').waitFor({state:'hidden'});}
async function layers(){return page.evaluate(()=>window.widget.flush());}
async function waitPixel(x,y,color){await page.waitForFunction(({x,y,color})=>Array.from(document.querySelector('#refCanvas').getContext('2d').getImageData(x,y,1,1).data).join(',')===color.join(','),{x,y,color});}
async function stroke(points){const first=await point(...points[0]);await page.mouse.move(first.x,first.y);await page.mouse.down();for(const coords of points.slice(1)){const p=await point(...coords);await page.mouse.move(p.x,p.y,{steps:8});}await page.mouse.up();}

test('reference text uses image coordinates, supports repeated labels and multiline, and never edits the original photo',async()=>{
  await tool('move');await click(250,200);assert.equal(await page.locator('#refDelete').isDisabled(),true);assert.deepEqual(await layers(),[]);
  await tool('text');await control('refTextSize',24);await control('refColor','#0000ff');await text('1',40,35);await text('2',180,35);
  await click(40,100);await page.locator('#refTextEditor').fill('First line');await page.locator('#refTextEditor').press('Shift+Enter');await page.locator('#refTextEditor').pressSequentially('Second line');await page.locator('#refTextEditor').press('Enter');
  let annotations=await layers();assert.deepEqual(annotations.map(layer=>layer.text.content),['1','2','First line\nSecond line']);
  for(const [index,[x,y]]of [[40,35],[180,35],[40,100]].entries()){assert.ok(Math.abs(annotations[index].x-x)<1);assert.ok(Math.abs(annotations[index].y-y)<1);assert.equal(annotations[index].text.color,'#0000ff');assert.equal(annotations[index].kind,'text');assert.equal(annotations[index].assetId,undefined);}
  await click(300,200);await page.locator('#refTextEditor').fill('Cancelled');await page.locator('#refTextEditor').press('Escape');assert.equal((await layers()).length,3);
  await page.locator('#refUndo').click();assert.equal((await layers()).length,2);await page.locator('#refRedo').click();assert.equal((await layers()).length,3);
  assert.deepEqual(await page.evaluate(()=>window.originalReference.annotations),[]);assert.equal(await page.evaluate(()=>window.originalReference.name),'First.png');
  await page.screenshot({path:path.join(qa,'editable-reference-text-1672.png')});await page.setViewportSize({width:1280,height:800});await page.screenshot({path:path.join(qa,'editable-reference-text-1280.png')});
});

test('reference annotations can move, edit their words and color, delete and undo without selecting the base',async()=>{
  await text('Move me',40,40);await tool('move');const a=await point(60,55),b=await point(100,85);await page.mouse.move(a.x,a.y);await page.mouse.down();await page.mouse.move(b.x,b.y,{steps:5});await page.mouse.up();
  let annotation=(await layers())[0];assert.ok(Math.abs(annotation.x-80)<=1);assert.ok(Math.abs(annotation.y-70)<=1);
  await click(95,85,{clickCount:2});await page.locator('#refTextEditor').waitFor({state:'visible'});await page.locator('#refTextEditor').fill('Revised');await page.locator('#refTextEditor').press('Enter');
  await control('refTextSize',30);await page.locator('#refColorWheel').click();await page.locator('#referenceEditorColorDialog #refcolorHex').fill('#0066FF');await page.locator('#referenceEditorColorDialog #refapplyColor').click();
  annotation=(await layers())[0];assert.equal(annotation.text.content,'Revised');assert.equal(annotation.text.fontSize,30);assert.equal(annotation.text.color,'#0066ff');assert.ok(Math.abs(annotation.x-80)<=1&&Math.abs(annotation.y-70)<=1);
  await page.locator('#refDelete').click();assert.deepEqual(await layers(),[]);await page.locator('#refCanvasStage').focus();await page.keyboard.press('Control+z');assert.equal((await layers())[0].text.content,'Revised');
  await click(400,280);assert.equal(await page.locator('#refDelete').isDisabled(),true);await page.keyboard.press('Delete');assert.equal((await layers()).length,1,'Clicking the photograph never selects or deletes the original');
});

test('pencil and translucent highlight preserve native stroke geometry and undo actual pixels independently',async()=>{
  await tool('pencil');await control('refBrushSize',12);await control('refColor','#ff0000');await stroke([[50,170],[240,170]]);await waitPixel(140,170,[255,0,0,255]);
  await tool('highlight');await control('refBrushSize',24);await control('refColor','#ffff00');await stroke([[50,225],[240,225]]);
  await page.waitForFunction(()=>{const p=document.querySelector('#refCanvas').getContext('2d').getImageData(140,225,1,1).data;return p[0]===255&&p[1]===255&&p[2]>0&&p[2]<255&&p[3]===255;});
  let annotations=await layers();assert.deepEqual(annotations.map(layer=>layer.drawing.mode),['pencil','highlight']);assert.equal(annotations[0].opacity,1);assert.equal(annotations[1].opacity,.35);assert.ok(annotations.every(layer=>layer.drawing.points.length>=2&&layer.assetId===undefined));
  await page.locator('#refUndo').click();await waitPixel(140,225,[255,255,255,255]);await page.locator('#refUndo').click();await waitPixel(140,170,[255,255,255,255]);await page.locator('#refRedo').click();await waitPixel(140,170,[255,0,0,255]);
  await tool('pencil');await stroke([[20,20],[-100,-100]]);annotations=await layers();const border=annotations.at(-1);assert.ok(border.drawing.points.every(([x,y])=>x+border.x>=0&&y+border.y>=0&&x+border.x<=480&&y+border.y<=320),'Drawing outside the photo clamps its editable points to the photo boundary');
});

test('flush confirms a pending label, validation retains it, and switching or clearing does not carry edits into another photo',async()=>{
  await tool('text');await click(50,50);await page.locator('#refTextEditor').fill('Pending on first photo');assert.equal(await page.evaluate(()=>window.widget.hasPending()),true);
  await control('refTextSize',0);const failed=await page.evaluate(()=>{try{window.widget.flush();return null;}catch(error){return error.message;}});assert.match(failed,/8 to 500/);assert.equal(await page.locator('#refTextEditor').inputValue(),'Pending on first photo');
  await control('refTextSize',24);const first=await layers();assert.equal(first[0].text.content,'Pending on first photo');assert.equal(await page.evaluate(()=>window.widget.hasPending()),false);
  await page.evaluate(async()=>{window.secondReference=window.makeReference('Second','#00ff00');await window.widget.load(window.secondReference);});await waitPixel(240,160,[0,255,0,255]);assert.deepEqual(await layers(),[]);assert.equal(await page.locator('#refUndo').isDisabled(),true);
  await tool('text');await click(40,40);await page.locator('#refTextEditor').fill('Discard by clear');await page.evaluate(()=>window.widget.clear());assert.equal(await page.evaluate(()=>window.widget.hasPending()),false);assert.equal(await page.locator('#refTextEditor').isVisible(),false);assert.equal(await page.locator('#refDelete').isDisabled(),true);assert.deepEqual(await layers(),[]);
  await page.evaluate(()=>window.widget.destroy());assert.equal(await page.locator('#refCanvasStage').count(),0);assert.equal(await page.locator('#referenceEditorColorDialog').count(),0);
  const stylesheetCounts=await page.evaluate(async()=>{const css=new URL('/reference-editor.css',location.href).href,links=()=>Array.from(document.querySelectorAll('link[rel~="stylesheet"]')).filter(link=>link.href===css);const before=links().length;links()[0].removeAttribute('data-reference-editor-style');const {createReferenceEditor}=await import('/reference-editor.mjs');window.widget=createReferenceEditor(document.querySelector('#referenceWidgetHost'));return {before,after:links().length};});assert.deepEqual(stylesheetCounts,{before:1,after:1},'An existing static stylesheet is reused while standalone hosts receive one stylesheet');
});

test('a delayed render from a previous photo cannot replace a newly loaded reference',async()=>{
  await page.evaluate(()=>{
    window.oldReference=window.makeReference('Delayed','#0000ff');window.newReference=window.makeReference('Newest','#00ff00');
    const NativeImage=window.Image;window.Image=class extends NativeImage{set src(value){if(value===window.oldReference.source)window.__releaseOldImage=()=>{super.src=value;};else super.src=value;}get src(){return super.src;}};
    window.oldLoad=window.widget.load(window.oldReference);
  });
  await page.waitForFunction(()=>typeof window.__releaseOldImage==='function');await page.evaluate(()=>window.widget.load(window.newReference));await waitPixel(240,160,[0,255,0,255]);
  await page.evaluate(async()=>{window.__releaseOldImage();await window.oldLoad;});await waitPixel(240,160,[0,255,0,255]);assert.deepEqual(await layers(),[]);
});

test('large fitted photos start with readable annotation sizes and preserve explicitly chosen sizes',async()=>{
  await page.evaluate(async()=>{const c=document.createElement('canvas');c.width=2000;c.height=3500;const ctx=c.getContext('2d');ctx.fillStyle='#ffffff';ctx.fillRect(0,0,c.width,c.height);window.largeReference={id:'Large',name:'Large.png',source:c.toDataURL('image/png'),width:c.width,height:c.height,annotations:[]};await window.widget.load(window.largeReference);});
  const zoom=await page.locator('#refCanvas').evaluate(canvas=>canvas.getBoundingClientRect().width/canvas.width);
  await tool('text');const fontSize=Number(await page.locator('#refTextSize').inputValue());assert.ok(fontSize>=8&&fontSize<=500);assert.ok(Math.abs(fontSize*zoom-24)<1,'Default text remains about24 screen pixels on a full-resolution photo');
  const board=await page.locator('#refCanvas').boundingBox();await page.mouse.click(board.x+board.width*.15,board.y+board.height*.2);await page.locator('#refTextEditor').fill('1');await page.locator('#refTextEditor').press('Enter');assert.equal((await layers())[0].text.fontSize,fontSize);
  await tool('pencil');let brush=Number(await page.locator('#refBrushSize').inputValue());assert.ok(Math.abs(brush*zoom-5)<1,'Default pencil is visible at fitted scale');await control('refBrushSize',12);
  await tool('highlight');brush=Number(await page.locator('#refBrushSize').inputValue());assert.ok(brush>=1&&brush<=500);assert.ok(Math.abs(brush*zoom-24)<1,'Default highlight is broad enough to see');
  await tool('move');await page.mouse.click(board.x+board.width*.8,board.y+board.height*.7);await tool('text');await control('refTextSize',42);const annotations=await layers();await page.evaluate(async annotations=>window.widget.load({...window.largeReference,id:'Another large photo',annotations}),annotations);
  await tool('text');assert.equal(await page.locator('#refTextSize').inputValue(),'42','An explicitly chosen text size survives photo switches');await tool('pencil');assert.equal(await page.locator('#refBrushSize').inputValue(),'12','An explicitly chosen pencil size survives photo switches');assert.equal((await layers())[0].text.fontSize,fontSize,'Loading never rescales existing annotation data');assert.deepEqual(await page.evaluate(()=>window.largeReference.annotations),[]);
});

test('Escape cancels a local draft or drawing gesture while leaving ordinary dialog Escape available',async()=>{
  await page.evaluate(()=>{const dialog=document.createElement('dialog');dialog.id='testReferenceDialog';document.body.append(dialog);dialog.append(document.querySelector('#referenceWidgetHost'));dialog.showModal();});
  await tool('text');await click(40,40);await page.locator('#refTextEditor').fill('Cancel here');await page.locator('#refTextEditor').press('Escape');assert.equal(await page.locator('#testReferenceDialog').isVisible(),true);assert.deepEqual(await layers(),[]);
  await tool('pencil');const p=await point(50,50);await page.mouse.move(p.x,p.y);await page.mouse.down();await page.keyboard.press('Escape');await page.mouse.up();assert.equal(await page.locator('#testReferenceDialog').isVisible(),true);assert.deepEqual(await layers(),[]);
  await page.locator('#refCanvasStage').focus();await page.keyboard.press('Escape');await page.locator('#testReferenceDialog').waitFor({state:'hidden'});
});

test('Enter activates view buttons with selected text and only edits text when the stage is focused',async()=>{
  await text('Selected label',40,40);await tool('move');const before=await layers();
  const zoom=()=>page.locator('#refCanvasBoard').evaluate(board=>new DOMMatrix(getComputedStyle(board).transform).a);
  const initialZoom=await zoom();await page.locator('#refZoomIn').focus();await page.keyboard.press('Enter');assert.ok((await zoom())>initialZoom);assert.equal(await page.locator('#refTextEditor').isVisible(),false);assert.deepEqual(await layers(),before);
  await page.locator('#refZoomPercent').focus();await page.keyboard.press('Enter');assert.equal(await zoom(),1);assert.equal(await page.locator('#refTextEditor').isVisible(),false);
  await page.locator('#refFit').focus();await page.keyboard.press('Enter');assert.equal(await page.locator('#refFit').getAttribute('aria-pressed'),'true');assert.equal(await page.locator('#refTextEditor').isVisible(),false);
  await page.locator('#refCanvasStage').focus();await page.keyboard.press('Enter');assert.equal(await page.locator('#refTextEditor').isVisible(),true);assert.equal(await page.locator('#refTextEditor').inputValue(),'Selected label');await page.keyboard.press('Escape');assert.deepEqual(await layers(),before);
});
