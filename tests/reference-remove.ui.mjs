import {test,before,after,beforeEach,afterEach} from 'node:test';
import assert from 'node:assert/strict';
import {mkdir,writeFile} from 'node:fs/promises';
import path from 'node:path';
import {chromium} from 'playwright';
import {createServer} from '../server.mjs';

let server,browser,context,page,base,errors;
const qa=path.resolve('qa','reference-remove');
const photos='.reference-gallery-photo[data-reference-key]';
const removals='.reference-gallery-remove[data-remove-reference-key]';
before(async()=>{await mkdir(qa,{recursive:true});server=createServer();await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));base=`http://127.0.0.1:${server.address().port}`;browser=await chromium.launch({headless:true});});
after(async()=>{await browser?.close();if(server)await new Promise(resolve=>server.close(resolve));});
beforeEach(async()=>{
  errors=[];context=await browser.newContext({viewport:{width:1672,height:941},acceptDownloads:true});page=await context.newPage();
  page.on('pageerror',error=>errors.push(error.message));page.on('request',request=>{if(!request.url().startsWith(base)&&!request.url().startsWith('data:')&&!request.url().startsWith('blob:'))errors.push('Unexpected remote request: '+request.url());});
  await page.route('**/api/local-detection/status',route=>route.fulfill({json:{available:false,message:'Isolated reference-gallery test'}}));
  await page.goto(base);await page.waitForFunction(()=>document.documentElement.dataset.ready==='true');
});
afterEach(async(info)=>{try{if(info.error)await page.screenshot({path:path.join(qa,'failure-'+info.name.replace(/\W+/g,'-')+'.png')});assert.deepEqual(errors,[]);}finally{await context?.close();}});

async function fixture(name,color='#ffffff',width=240,height=160){
  const data=await page.evaluate(({color,width,height})=>{const canvas=document.createElement('canvas');canvas.width=width;canvas.height=height;const ctx=canvas.getContext('2d');ctx.fillStyle=color;ctx.fillRect(0,0,width,height);return canvas.toDataURL('image/png');},{color,width,height});
  const buffer=Buffer.concat([Buffer.from(data.split(',')[1],'base64'),Buffer.from('\nAsun reference-gallery source metadata: '+name)]);
  return {name,type:'image/png',width,height,buffer,source:'data:image/png;base64,'+buffer.toString('base64')};
}
const file=image=>({name:image.name,mimeType:image.type,buffer:image.buffer});
async function idle(){await page.waitForFunction(()=>!document.body.classList.contains('busy'));}
async function control(id,value){await page.locator('#'+id).evaluate((input,value)=>{input.value=String(value);input.dispatchEvent(new Event('input',{bubbles:true}));input.dispatchEvent(new Event('change',{bubbles:true}));},value);}
async function main(){const image=await fixture('Original main.png','#ffffff',480,320);await page.locator('#imageInput').setInputFiles(file(image));await page.waitForFunction(()=>document.querySelector('#canvas').width===480&&document.querySelectorAll('.layer-row').length===1&&!document.body.classList.contains('busy'));return image;}
async function label(content='1',x=40,y=40){await page.locator('#addText').click();await control('textSize',24);await control('textColor','#000000');const rect=await page.locator('#board').boundingBox();await page.mouse.click(rect.x+x*rect.width/480,rect.y+y*rect.height/320);await page.locator('#textEditor').fill(content);await page.locator('#textEditor').press('Enter');await page.locator('#textEditor').waitFor({state:'hidden'});return page.locator('.layer-row.selected').getAttribute('data-id');}
async function open(){await page.locator('#linkReference').click();await page.locator('#referenceDialog').waitFor({state:'visible'});await idle();}
async function gallery(count){await page.waitForFunction(count=>document.querySelectorAll('.reference-gallery-photo[data-reference-key]').length===count&&document.querySelectorAll('.reference-gallery-remove[data-remove-reference-key]').length===count&&!document.body.classList.contains('busy'),count);}
async function add(images){await page.locator('#referenceFileInput').setInputFiles(images.map(file));await idle();}
async function keys(){return page.locator(photos).evaluateAll(buttons=>buttons.map(button=>button.dataset.referenceKey));}
async function activeKey(){return page.locator(photos+'.selected').getAttribute('data-reference-key');}
async function select(key){await page.locator(`${photos}[data-reference-key="${key}"]`).click();await activeReady();}
async function activeReady(){await page.waitForFunction(()=>document.querySelector('#referenceEditorHost').dataset.refReady==='true'&&!document.body.classList.contains('busy'));await page.locator('#refCanvas').waitFor({state:'visible'});}
async function remove(key){await page.locator(`${removals}[data-remove-reference-key="${key}"]`).click();}
async function close(id='cancelReferenceLink'){
  await page.evaluate(()=>{window.__referenceClose=new Promise(resolve=>document.querySelector('#referenceDialog').addEventListener('close',()=>resolve(true),{once:true}));});
  await page.locator('#'+id).click();await page.evaluate(()=>window.__referenceClose);await idle();
}
async function saveLinks(){await close('saveReferenceLink');}
async function save(){const event=page.waitForEvent('download');await page.locator('#saveProject').click();const download=await event,stream=await download.createReadStream(),chunks=[];for await(const chunk of stream)chunks.push(chunk);const buffer=Buffer.concat(chunks);await page.waitForTimeout(725);return {name:download.suggestedFilename(),buffer,data:JSON.parse(buffer.toString())};}
async function reopen(saved){await page.locator('#projectInput').setInputFiles({name:saved.name,mimeType:'application/json',buffer:saved.buffer});await page.waitForFunction(count=>document.querySelectorAll('.layer-row').length===count&&!document.body.classList.contains('busy'),saved.data.layers.length);}
async function selectLabel(id){await page.locator(`.layer-row[data-id="${id}"]`).click();}
const text=(project,content)=>project.layers.find(layer=>layer.kind==='text'&&layer.text.content===content);
async function refText(content){
  await page.locator('[data-ref-tool=text]').click();await control('refTextSize',18);await control('refColor','#ff0000');
  const canvas=page.locator('#refCanvas');await canvas.evaluate(canvas=>canvas.scrollIntoView({block:'center',inline:'nearest'}));await page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(resolve)));
  const size=await canvas.evaluate(canvas=>({width:canvas.width,height:canvas.height})),rect=await canvas.boundingBox(),point={x:rect.x+15*rect.width/size.width,y:rect.y+15*rect.height/size.height};
  assert.equal(await page.evaluate(point=>Boolean(document.elementFromPoint(point.x,point.y)?.closest('#refCanvasStage')),point),true,'Reference text point is physically visible');
  await page.mouse.click(point.x,point.y);await page.locator('#refTextEditor').fill(content);
}
async function baseline(images){await main();const layerId=await label();await open();await add(images);await gallery(images.length);await page.locator('#labelComment').fill('Keep this area comment\nwith its number.');await saveLinks();return {saved:await save(),layerId};}

test('duplicate file names and bytes remove only the chosen inactive photo and preserve active edits',async()=>{
  await main();await label();const duplicate=await fixture('Duplicate reference.png'),other=await fixture('Other reference.png','#0000ff');await open();await add([duplicate,duplicate,other]);await gallery(3);
  const ids=await keys();assert.equal(new Set(ids).size,3,'Identical files retain distinct editable reference identities');await select(ids[0]);await page.locator('#referenceNotes').fill('Notes stay with the first duplicate.');await page.locator('#labelComment').fill('Area instruction remains.');await refText('keep this annotation');
  const editorSize=await page.locator('#refCanvas').evaluate(canvas=>[canvas.width,canvas.height]);await remove(ids[1]);await gallery(2);
  assert.deepEqual(await keys(),[ids[0],ids[2]],'The exact second duplicate is removed');assert.equal(await activeKey(),ids[0]);assert.equal(await page.locator('#referenceDialog').isVisible(),true);assert.equal(await page.locator('#referenceNotes').inputValue(),'Notes stay with the first duplicate.');assert.equal(await page.locator('#labelComment').inputValue(),'Area instruction remains.');assert.deepEqual(await page.locator('#refCanvas').evaluate(canvas=>[canvas.width,canvas.height]),editorSize);
  await saveLinks();const saved=await save(),first=saved.data.references[0];assert.equal(saved.data.references.length,2);assert.equal(first.name,duplicate.name);assert.equal(first.source,duplicate.source);assert.equal(first.notes,'Notes stay with the first duplicate.');assert.equal(first.annotations[0].text.content,'keep this annotation');assert.equal(saved.data.references[1].source,other.source);assert.equal(text(saved.data,'1').referenceComment,'Area instruction remains.');
  await reopen(saved);await open();await gallery(2);assert.equal(await page.locator('#referenceNotes').inputValue(),first.notes);await close();assert.deepEqual((await save()).data,saved.data);
});

test('active and last X removals are staged, cancellable, and saved as one undoable link change',async()=>{
  const images=[await fixture('First.png','#00ff00'),await fixture('Second.png','#0000ff'),await fixture('Third.png','#ff0000')],{saved:before,layerId}=await baseline(images),ids=text(before.data,'1').referenceIds;
  await open();await select(ids[1]);await remove(ids[1]);await gallery(2);assert.equal(await activeKey(),ids[2],'Removing the active middle photo selects the following photo');await activeReady();await remove(ids[2]);await gallery(1);assert.equal(await activeKey(),ids[0]);await close('closeReferenceDialog');assert.deepEqual((await save()).data,before.data,'X close discards staged per-photo removals');
  await open();for(const id of ids){await remove(id);await gallery(ids.length-ids.indexOf(id)-1);}assert.equal(await page.locator('#referenceEditorHost').isVisible(),false);assert.equal(await page.locator('#referenceNotesField').isVisible(),false);assert.equal(await page.locator('#labelComment').inputValue(),text(before.data,'1').referenceComment);assert.equal(await page.locator('#referenceDialog').isVisible(),true);assert.equal(await page.locator('#saveReferenceLink').isEnabled(),true);
  await saveLinks();const after=await save();assert.deepEqual(text(after.data,'1').referenceIds||[],[]);assert.equal(text(after.data,'1').referenceComment,text(before.data,'1').referenceComment);assert.deepEqual(after.data.references,before.data.references,'Unlinking keeps every original in the project library');
  await page.locator('#undo').click();assert.deepEqual((await save()).data,before.data,'One undo restores all three associations');await page.locator('#redo').click();assert.deepEqual((await save()).data,after.data);await reopen(after);await selectLabel(layerId);await open();await gallery(0);assert.equal(await page.locator('#labelComment').inputValue(),text(before.data,'1').referenceComment);assert.equal(await page.locator('#referenceChoice option').count(),4);await close();
});

test('removing a shared photo from one number keeps its source, notes, annotations and other association',async()=>{
  await main();const firstId=await label('1'),shared=await fixture('Shared editable photo.png'),other=await fixture('Only number one.png','#00ff00');await open();await add([shared,other]);await gallery(2);const draftKeys=await keys();await select(draftKeys[0]);await page.locator('#referenceNotes').fill('Shared material instructions.');await refText('shared mark');await page.locator('#refTextEditor').press('Enter');await saveLinks();let saved=await save();const sharedRef=saved.data.references.find(ref=>ref.name===shared.name),secondId=await label('2',200,40);
  await open();await page.locator('#referenceChoice').selectOption(sharedRef.id);await gallery(1);await activeReady();assert.equal(await page.locator('#referenceNotes').inputValue(),sharedRef.notes);await page.locator('#labelComment').fill('Number two retains this reference.');await saveLinks();const before=await save();
  await selectLabel(firstId);await open();await remove(sharedRef.id);await gallery(1);await saveLinks();const after=await save();assert.deepEqual(text(after.data,'1').referenceIds,[otherRefId(after.data,other.name)]);assert.deepEqual(text(after.data,'2').referenceIds,[sharedRef.id]);assert.deepEqual(after.data.references,before.data.references,'Per-number removal does not delete shared original or editable annotations');
  await page.locator('#undo').click();assert.deepEqual((await save()).data,before.data);await page.locator('#redo').click();await reopen(after);await selectLabel(secondId);await open();await gallery(1);await activeReady();assert.equal(await page.locator('#referenceName').innerText(),shared.name);assert.equal(await page.locator('#referenceNotes').inputValue(),sharedRef.notes);await close();
  const groups=await page.evaluate(async project=>(await import('/reference-board.mjs')).linkedReferences(project).map(group=>({id:group.reference.id,labels:group.labels})),after.data);assert.deepEqual(groups.find(group=>group.id===sharedRef.id).labels,['2']);assert.equal(after.data.references.find(ref=>ref.id===sharedRef.id).source,shared.source);
});
function otherRefId(project,name){return project.references.find(ref=>ref.name===name).id;}

test('busy photo loading and invalid annotation flush block X removals without losing drafts',async()=>{
  const images=[await fixture('Current white.png'),await fixture('Inactive green.png','#00ff00')],{saved:before}=await baseline(images),ids=text(before.data,'1').referenceIds,added=await fixture('Delayed blue.png','#0000ff');await open();await activeReady();
  await page.evaluate(()=>{window.__nativePhotoRead=FileReader.prototype.readAsDataURL;FileReader.prototype.readAsDataURL=function(file){window.__releasePhotoRead=()=>window.__nativePhotoRead.call(this,file);};});await page.locator('#referenceFileInput').setInputFiles(file(added));await page.waitForFunction(()=>document.body.classList.contains('busy')&&typeof window.__releasePhotoRead==='function');
  assert.deepEqual(await page.locator(removals).evaluateAll(buttons=>buttons.map(button=>button.disabled)),[true,true]);await page.locator(removals).first().evaluate(button=>button.dispatchEvent(new MouseEvent('click',{bubbles:true,cancelable:true})));assert.deepEqual(await keys(),ids,'Busy guard also blocks a dispatched click');
  await page.evaluate(()=>{FileReader.prototype.readAsDataURL=window.__nativePhotoRead;window.__releasePhotoRead();});await gallery(3);await select(ids[0]);await page.locator('#referenceNotes').fill('Retain pending notes.');await page.locator('#labelComment').fill('Retain pending area instruction.');await refText('invalid until size is fixed');await control('refTextSize',0);await remove(ids[1]);
  assert.equal(await page.locator(photos).count(),3);assert.match(await page.locator('#referenceDialogError').innerText(),/8 to 500/);assert.equal(await page.locator('#refTextEditor').inputValue(),'invalid until size is fixed');assert.equal(await activeKey(),ids[0]);assert.equal(await page.locator('#referenceNotes').inputValue(),'Retain pending notes.');assert.equal(await page.locator('#labelComment').inputValue(),'Retain pending area instruction.');
  await control('refTextSize',18);await remove(ids[1]);await gallery(2);assert.equal(await activeKey(),ids[0]);await close();assert.deepEqual((await save()).data,before.data,'Cancel discards removal, newly decoded photo and all draft edits together');
});

test('gallery X buttons remain distinct hit targets when scrolled and support Enter and Space without submit',async()=>{
  const images=[];for(let index=0;index<10;index++)images.push(await fixture(`Reference ${index+1} with an intentionally long name.png`,`rgb(${index*17},${220-index*11},${40+index*9})`));const {saved:before}=await baseline(images);await open();await gallery(10);const ids=await keys(),records=[];
  for(const viewport of [{width:1280,height:800},{width:1672,height:941}]){
    await page.setViewportSize(viewport);await page.locator('#referenceGallery').evaluate(gallery=>{gallery.scrollIntoView({block:'center',inline:'nearest'});gallery.scrollLeft=gallery.scrollWidth;gallery.scrollTop=gallery.scrollHeight;});await page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(resolve)));
    const geometry=await page.evaluate(()=>{const gallery=document.querySelector('#referenceGallery'),clip=gallery.getBoundingClientRect(),dialog=document.querySelector('#referenceDialog').getBoundingClientRect();return {viewport:{width:innerWidth,height:innerHeight},clip:{left:clip.left,right:clip.right,top:clip.top,bottom:clip.bottom},buttons:[...gallery.querySelectorAll('.reference-gallery-remove')].map(button=>{const rect=button.getBoundingClientRect(),card=button.closest('.reference-gallery-card'),photo=card.querySelector('.reference-gallery-photo'),pr=photo.getBoundingClientRect(),x=rect.x+rect.width/2,y=rect.y+rect.height/2;return {key:button.dataset.removeReferenceKey,width:rect.width,height:rect.height,left:rect.left,right:rect.right,top:rect.top,bottom:rect.bottom,photoRight:pr.right,photoTop:pr.top,visible:rect.left>=clip.left&&rect.right<=clip.right&&rect.top>=clip.top&&rect.bottom<=clip.bottom,hit:document.elementFromPoint(x,y)===button,siblings:button.parentElement===photo.parentElement&&!photo.contains(button),type:button.type,title:button.title,aria:button.getAttribute('aria-label'),text:button.textContent};}),footer:['saveReferenceLink','cancelReferenceLink'].map(id=>{const r=document.getElementById(id).getBoundingClientRect();return {id,left:r.left,right:r.right,top:r.top,bottom:r.bottom,inside:r.left>=dialog.left&&r.right<=dialog.right&&r.top>=dialog.top&&r.bottom<=dialog.bottom&&r.bottom<=innerHeight};})};});
    const visible=geometry.buttons.filter(button=>button.visible);assert.ok(visible.length>=2,'Gallery scroll exposes several complete X controls');assert.equal(visible.at(-1).key,ids.at(-1));for(const button of visible){assert.equal(button.hit,true);assert.equal(button.siblings,true,'X and photo are sibling buttons');assert.equal(button.type,'button');assert.equal(button.text,'×');assert.equal(button.title,button.aria);assert.match(button.aria,/^Remove photo \d+: .+ from this number$/);assert.ok(button.width>=24&&button.height>=24,'X has an accessible mouse target');assert.ok(Math.abs(button.right-button.photoRight)<10&&button.top-button.photoTop<12,'X overlays the top-right photo corner');}assert.ok(geometry.footer.every(button=>button.inside),'Save and Cancel stay within the modal');records.push(geometry);await page.screenshot({path:path.join(qa,`reference-remove-${viewport.width}.png`)});
  }
  await page.locator(`${removals}[data-remove-reference-key="${ids.at(-1)}"]`).focus();await page.locator(`${removals}[data-remove-reference-key="${ids.at(-1)}"]`).press('Enter');await gallery(9);assert.equal(await page.locator('#referenceDialog').isVisible(),true);assert.equal(await page.evaluate(()=>document.activeElement?.dataset.referenceKey),ids[0],'Focus moves to the active photo after inactive X removal');
  await select(ids[0]);await page.locator(`${removals}[data-remove-reference-key="${ids[0]}"]`).focus();await page.locator(`${removals}[data-remove-reference-key="${ids[0]}"]`).press('Space');await gallery(8);assert.equal(await activeKey(),ids[1]);assert.equal(await page.evaluate(()=>document.activeElement?.dataset.referenceKey),ids[1]);assert.equal(await page.locator('#referenceDialog').isVisible(),true,'Space removes without submitting the form');
  await close();assert.deepEqual((await save()).data,before.data);await open();await gallery(10);await page.locator('#referenceGallery').evaluate(gallery=>{gallery.scrollIntoView({block:'center'});gallery.scrollLeft=gallery.scrollWidth;gallery.scrollTop=gallery.scrollHeight;});await remove(ids.at(-1));await gallery(9);assert.ok(!(await keys()).includes(ids.at(-1)),'Physical X click removes the correct scrolled photo');await close();assert.deepEqual((await save()).data,before.data);await writeFile(path.join(qa,'gallery-hit-targets.json'),JSON.stringify(records,null,2));
});
