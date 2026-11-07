import {test,before,after} from 'node:test';
import assert from 'node:assert/strict';
import {mkdir,writeFile} from 'node:fs/promises';
import path from 'node:path';
import {chromium} from 'playwright';
import {createServer} from '../server.mjs';

const qa=path.resolve('qa','reference-studio');
const report={suite:'Reference studio',fixture:'Deterministic procedural alpine landscapes; original PNG bytes retained.',cases:[]};
const layouts=[{width:1680,height:941},{width:1080,height:800},{width:800,height:800}];
let server,browser,base;
before(async()=>{
  await mkdir(path.join(qa,'fixtures'),{recursive:true});
  server=createServer();await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  base='http://127.0.0.1:'+server.address().port;
  browser=await chromium.launch({headless:true});
});
after(async()=>{
  report.passed=report.cases.filter(item=>item.status==='passed').length;
  report.failed=report.cases.filter(item=>item.status==='failed').length;
  await writeFile(path.join(qa,'report.json'),JSON.stringify(report,null,2));
  await browser?.close();if(server)await new Promise(resolve=>server.close(resolve));
});

function check(name,body){
  test(name,{timeout:60000},async()=>{
    const record={name,status:'running'},errors=[];
    report.cases.push(record);
    const context=await browser.newContext({viewport:{width:1680,height:941},acceptDownloads:true});
    await context.addInitScript(()=>localStorage.setItem('asun-image-appearance','light'));
    const page=await context.newPage();
    page.on('pageerror',error=>errors.push(error.message));
    page.on('request',request=>{if(!request.url().startsWith(base)&&!request.url().startsWith('data:')&&!request.url().startsWith('blob:'))errors.push('Unexpected remote request: '+request.url());});
    await page.route('**/api/local-detection/status',route=>route.fulfill({json:{available:false,message:'Reference layout fixture; no inference'}}));
    try{
      await page.goto(base);
      await page.waitForFunction(()=>document.documentElement.dataset.ready==='true'&&document.documentElement.dataset.appearanceReady==='true');
      await body(page,record);
      assert.deepEqual(errors,[],'The reference UI has no browser errors or unexpected remote requests');
      record.status='passed';
    }catch(error){
      record.status='failed';record.error=error.message;
      record.browserErrors=errors;
      await page.screenshot({path:path.join(qa,'failure-'+name.replace(/\W+/g,'-')+'.png')}).catch(()=>{});
      throw error;
    }finally{await context.close();}
  });
}

async function frames(page){await page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));}
async function idle(page){await page.waitForFunction(()=>!document.body.classList.contains('busy'));}
async function control(page,id,value){await page.locator('#'+id).evaluate((input,value)=>{input.value=String(value);input.dispatchEvent(new Event('input',{bubbles:true}));input.dispatchEvent(new Event('change',{bubbles:true}));},value);}
function file(photo){return {name:photo.name,mimeType:'image/png',buffer:Buffer.from(photo.bytes)};}
async function fixture(page,index=0){
  const names=['Alpine meadow.png','Blue mountain light.png','Rocky ridge.png','Lakeside grasses.png','Soft snow caps.png','Warm evening slope.png','Forest edge.png','A long descriptive eighth reference photo name.png','Extra new landscape.png'];
  const source=await page.evaluate(index=>{
    const c=document.createElement('canvas');c.width=720;c.height=480;const ctx=c.getContext('2d');
    let seed=1701+index*137;const random=()=>{seed=(seed*1664525+1013904223)>>>0;return seed/4294967296;};
    const palettes=[['#a8d4df','#f4efe1','#657f88','#486966','#829764'],['#b4cbdc','#efe4d3','#778697','#536b7b','#79977b'],['#c4d8d5','#f8ecd1','#8b887b','#667366','#a1a271'],['#bddbd4','#f0e8d4','#688f90','#486f6c','#91ad78']];
    const [sky,paper,rock,deep,grass]=palettes[index%palettes.length],g=ctx.createLinearGradient(0,0,0,360);g.addColorStop(0,sky);g.addColorStop(1,paper);ctx.fillStyle=g;ctx.fillRect(0,0,720,480);
    ctx.fillStyle='#fff7df';ctx.beginPath();ctx.arc(570-index*9,72+index*3,24,0,Math.PI*2);ctx.fill();
    const polygon=(points,fill)=>{ctx.fillStyle=fill;ctx.beginPath();points.forEach(([x,y],i)=>i?ctx.lineTo(x,y):ctx.moveTo(x,y));ctx.closePath();ctx.fill();};
    polygon([[0,254],[66,190],[103,222],[201,116],[249,173],[330,81],[388,153],[425,125],[520,224],[589,164],[720,272],[720,420],[0,420]],rock);
    polygon([[199,116],[222,150],[236,159],[249,173],[225,166],[212,183],[194,170],[169,181]],paper);
    polygon([[330,81],[353,111],[373,131],[388,153],[359,139],[350,156],[325,136],[307,147],[295,132]],paper);
    polygon([[330,81],[326,159],[295,227],[246,260],[354,292],[425,125],[388,153],[350,156]],'#4b687470');
    polygon([[0,308],[104,254],[167,305],[263,268],[366,334],[444,276],[536,293],[628,258],[720,304],[720,480],[0,480]],deep);
    polygon([[0,371],[102,346],[214,372],[329,353],[402,382],[520,343],[625,356],[720,334],[720,480],[0,480]],grass);
    polygon([[185,383],[287,378],[399,391],[521,385],[626,405],[526,423],[332,429],[176,411]],'#aac8bd');
    ctx.globalAlpha=.23;ctx.lineWidth=1;
    for(let i=0;i<430;i++){const x=random()*720,y=355+random()*125;ctx.strokeStyle=i%3?'#3e614b':'#fff2cd';ctx.beginPath();ctx.moveTo(x,y);ctx.lineTo(x+(random()-.5)*8,y-3-random()*12);ctx.stroke();}
    ctx.globalAlpha=.12;
    for(let i=0;i<1200;i++){ctx.fillStyle=i%2?'#213f48':'#fff9e7';ctx.fillRect(random()*720,160+random()*320,1+random()*3,1+random()*2);}
    ctx.globalAlpha=1;return c.toDataURL('image/png');
  },index);
  const photo={name:names[index]||'Landscape reference '+String(index+1)+'.png',source,width:720,height:480,bytes:[...Buffer.from(source.split(',')[1],'base64')]};
  await writeFile(path.join(qa,'fixtures','landscape-'+String(index+1).padStart(2,'0')+'.png'),Buffer.from(photo.bytes));
  return photo;
}
async function setup(page){
  const scene=await fixture(page,0);
  await page.locator('#imageInput').setInputFiles(file({...scene,name:'Alpine scene.png'}));
  await page.waitForFunction(()=>document.querySelectorAll('.layer-row').length===1&&document.querySelector('#canvas').width===720&&!document.body.classList.contains('busy'));
  await page.locator('#addText').click();await control(page,'textSize',30);
  const r=await page.locator('#board').boundingBox();
  await page.mouse.click(r.x+52*r.width/720,r.y+52*r.height/480);
  await page.locator('#textEditor').fill('1');await page.locator('#textEditor').press('Enter');
  await page.locator('#textEditor').waitFor({state:'hidden'});await idle(page);return scene;
}
async function open(page){await page.locator('#linkReference').click();await page.locator('#referenceDialog').waitFor({state:'visible'});await idle(page);await frames(page);}
async function gallery(page,count){await page.waitForFunction(count=>document.querySelectorAll('#referenceGallery [data-reference-key]').length===count&&!document.body.classList.contains('busy'),count);}
async function addPhotos(page,count=8,start=0){const photos=[];for(let index=start;index<start+count;index++)photos.push(await fixture(page,index));await page.locator('#referenceFileInput').setInputFiles(photos.map(file));await gallery(page,count);await page.waitForFunction(()=>document.querySelector('#referenceEditorHost').dataset.refReady==='true');return photos;}
async function choose(page,index){const name=await page.locator('#referenceGallery [data-reference-key]').nth(index).getAttribute('title');await page.locator('#referenceGallery [data-reference-key]').nth(index).click();await page.waitForFunction(name=>document.querySelector('#referenceName').textContent===name&&document.querySelector('#referenceEditorHost').dataset.refReady==='true'&&!document.body.classList.contains('busy'),name);await frames(page);}
async function close(page){await page.evaluate(()=>{window.__refClose=new Promise(resolve=>document.querySelector('#referenceDialog').addEventListener('close',resolve,{once:true}));});await page.locator('#cancelReferenceLink').click();await page.evaluate(()=>window.__refClose);await idle(page);}
async function saveLinks(page){await page.locator('#saveReferenceLink').click();await page.locator('#referenceDialog').waitFor({state:'hidden'});await idle(page);}
async function saveProject(page){
  const pending=page.waitForEvent('download');await page.locator('#saveProject').click();
  const download=await pending,stream=await download.createReadStream(),chunks=[];for await(const chunk of stream)chunks.push(chunk);
  const buffer=Buffer.concat(chunks);await page.waitForTimeout(725);
  return {name:download.suggestedFilename(),buffer,data:JSON.parse(buffer.toString())};
}
async function theme(page,value){if(await page.locator('html').getAttribute('data-theme')!==value)await page.locator('#themeToggle').click();await frames(page);}
async function reachable(page,selector){
  const locator=page.locator(selector);await locator.scrollIntoViewIfNeeded();await locator.evaluate(element=>element.scrollIntoView({block:'center',inline:'nearest'}));await frames(page);
  const item=await locator.evaluate(element=>{const r=element.getBoundingClientRect(),dialog=document.querySelector('#referenceDialog').getBoundingClientRect(),hit=document.elementFromPoint(r.x+r.width/2,r.y+r.height/2);return {selector:element.id||element.dataset.refTool||element.className,rect:{left:r.left,top:r.top,right:r.right,bottom:r.bottom},dialog:{left:dialog.left,top:dialog.top,right:dialog.right,bottom:dialog.bottom},hit:hit?.id||hit?.tagName,reachable:Boolean(hit&&(element===hit||element.contains(hit))),viewport:{width:innerWidth,height:innerHeight}};});
  assert.ok(item.reachable&&item.rect.left>=item.dialog.left-.5&&item.rect.right<=item.dialog.right+.5&&item.rect.top>=item.dialog.top-.5&&item.rect.bottom<=Math.min(item.dialog.bottom,item.viewport.height)+.5,'Control is reachable without clipping: '+JSON.stringify(item));
  if(!await locator.isDisabled()){await locator.focus();assert.equal(await locator.evaluate(element=>element===document.activeElement),true,'Control accepts keyboard focus: '+selector);}
  return item;
}
async function footer(page){
  const result=await page.evaluate(()=>{const form=document.querySelector('#referenceLinkForm'),dialog=document.querySelector('#referenceDialog').getBoundingClientRect();return {position:getComputedStyle(document.querySelector('#referenceDialog .dialog-actions')).position,scrollTop:form.scrollTop,scrollHeight:form.scrollHeight,clientHeight:form.clientHeight,buttons:['cancelReferenceLink','saveReferenceLink'].map(id=>{const element=document.getElementById(id),r=element.getBoundingClientRect(),hit=document.elementFromPoint(r.x+r.width/2,r.y+r.height/2);return {id,left:r.left,right:r.right,top:r.top,bottom:r.bottom,dialogTop:dialog.top,dialogBottom:dialog.bottom,viewportWidth:innerWidth,viewportHeight:innerHeight,hit:Boolean(hit&&(element===hit||element.contains(hit)))};})};});
  assert.equal(result.position,'sticky');for(const r of result.buttons)assert.ok(r.hit&&r.left>=0&&r.right<=r.viewportWidth&&r.top>=r.dialogTop&&r.bottom<=Math.min(r.dialogBottom,r.viewportHeight),'Sticky footer remains reachable: '+JSON.stringify(r));
  return result;
}
async function structure(page,populated,width){
  const data=await page.evaluate(()=>{const rect=element=>{const r=element.getBoundingClientRect();return {left:r.left,right:r.right,top:r.top,bottom:r.bottom,width:r.width,height:r.height};};const ids=['referenceDialog','referenceLinkForm','referenceWebQuery','labelCommentField','referenceGallery','referenceDropZone'];return {title:document.querySelector('#referenceDialogTitle').textContent,area:document.querySelector('#referenceAreaLabel').textContent,searchBeforeComment:Boolean(document.querySelector('.reference-finder').compareDocumentPosition(document.querySelector('#labelCommentField'))&Node.DOCUMENT_POSITION_FOLLOWING),metrics:ids.map(id=>{const element=document.getElementById(id);return {id,clientWidth:element.clientWidth,scrollWidth:element.scrollWidth,rect:rect(element)};}),gallery:{clientWidth:document.querySelector('#referenceGallery').clientWidth,scrollWidth:document.querySelector('#referenceGallery').scrollWidth,clientHeight:document.querySelector('#referenceGallery').clientHeight,scrollHeight:document.querySelector('#referenceGallery').scrollHeight},viewport:{width:innerWidth,height:innerHeight}};});
  assert.equal(data.title,'References');assert.match(data.area,/^Area [“"]?1[”"]?$/);assert.equal(data.searchBeforeComment,true,'Find a reference precedes area comments in DOM order');
  data.importAlignment=await page.evaluate(()=>['chooseReferencePhoto','pasteReferencePhoto','referenceChoice'].map(id=>({id,bottom:document.getElementById(id).getBoundingClientRect().bottom})));
  for(const item of data.importAlignment)assert.ok(Math.abs(item.bottom-data.importAlignment[2].bottom)<=2,'Folder, paste and project-photo choice share a baseline: '+JSON.stringify(data.importAlignment));
  if(populated){data.numberBadges=await page.locator('#referenceGallery .reference-photo-number').evaluateAll(elements=>elements.map(element=>({width:element.getBoundingClientRect().width,height:element.getBoundingClientRect().height,minWidth:getComputedStyle(element).minWidth})));for(const badge of data.numberBadges)assert.ok(badge.width>=23&&badge.height>=23,'Photo index badge retains its readable 23px size: '+JSON.stringify(badge));}
  for(const item of data.metrics){if(item.id==='referenceGallery'&&width<=900)continue;assert.ok(item.scrollWidth<=item.clientWidth+1,'No horizontal overflow: '+JSON.stringify(item));}
  assert.ok(data.metrics[0].rect.left>=0&&data.metrics[0].rect.right<=width+1,'The dialog fits its viewport');
  if(populated&&width>900)assert.ok(data.gallery.scrollHeight>data.gallery.clientHeight,'Eight photos scroll vertically within their collection');
  if(populated&&width<=900)assert.ok(data.gallery.scrollWidth>data.gallery.clientWidth,'Compact gallery scrolling is contained in its shelf');
  return data;
}
async function icons(page,populated){
  const data=await page.evaluate(async populated=>{const result={count:document.querySelectorAll('#referenceDialog .reference-icon').length,placeholderCount:document.querySelectorAll('#referenceDialog [data-ref-icon]').length,wrapperCount:document.querySelectorAll('#referenceDialog .reference-section-icon > svg').length,tools:[]};if(populated)for(const name of ['move','text','pencil','highlight']){const button=document.querySelector('[data-ref-tool="'+name+'"]'),svg=button.querySelector('svg'),rail=document.querySelector('.toolrail [data-tool="'+name+'"] svg');result.tools.push({name,same:svg.innerHTML===rail.innerHTML,label:button.querySelector('span').textContent,hidden:svg.getAttribute('aria-hidden'),focusable:svg.getAttribute('focusable'),width:svg.getBoundingClientRect().width,height:svg.getBoundingClientRect().height});}const {decorateReferenceIcons}=await import('/reference-icons.mjs'),before=document.querySelector('#referenceDialog').innerHTML;decorateReferenceIcons();decorateReferenceIcons();result.repeatSafe=before===document.querySelector('#referenceDialog').innerHTML;return result;},populated);
  assert.ok(data.count>=8,'Find, folder, paste, comments, title and empty-state illustrations are present');assert.equal(data.placeholderCount,0);assert.ok(data.wrapperCount>=6,'Section icon wrappers retain their scoped styles');assert.equal(data.repeatSafe,true);
  for(const item of data.tools){assert.equal(item.same,true,item.name+' exactly matches main rail illustration');assert.equal(item.hidden,'true');assert.equal(item.focusable,'false');assert.deepEqual([item.width,item.height],[21,21]);assert.ok(item.label);}
  return data;
}
async function bottomStrip(page,count){
  const result=await page.evaluate(()=>{const rect=element=>{const r=element.getBoundingClientRect();return {top:r.top,bottom:r.bottom,height:r.height};},section=document.querySelector('.composer .reference-section'),title=section.querySelector('.reference-strip-title').getBoundingClientRect(),count=document.querySelector('#referenceCount').getBoundingClientRect();return {label:section.querySelector('.reference-strip-title').textContent.trim(),count:document.querySelector('#referenceCount').textContent,add:document.querySelector('#addReference').textContent.trim(),addRect:rect(document.querySelector('#addReference')),cards:[...document.querySelectorAll('#referenceList .reference-card')].map(rect),countLeft:count.left,titleRight:title.right};});
  assert.equal(result.label,'References');assert.equal(result.count,count+' photos');assert.equal(result.add,'Add photos');assert.ok(result.countLeft>=result.titleRight,'Bottom label and count do not overlap');
  for(const card of result.cards){assert.ok(Math.abs(card.top-result.addRect.top)<=1&&Math.abs(card.bottom-result.addRect.bottom)<=1&&Math.abs(card.height-result.addRect.height)<=1,'Bottom photo and Add photos tile share a baseline: '+JSON.stringify({card,add:result.addRect}));}return result;
}

for(const value of ['light','dark'])for(const viewport of layouts){
  const name=value+' '+viewport.width+'x'+viewport.height+' empty and eight-photo layout';
  check(name,async(page,record)=>{
    await setup(page);await theme(page,value);await page.setViewportSize(viewport);await open(page);
    const prefix=value+'-'+viewport.width+'x'+viewport.height;
    await page.screenshot({path:path.join(qa,prefix+'-empty.png')});
    record.empty={structure:await structure(page,false,viewport.width),icons:await icons(page,false),footer:await footer(page)};
    for(const selector of ['#referenceWebQuery','#searchReferenceWeb','#chooseReferencePhoto','#pasteReferencePhoto','#referenceChoice','#labelComment','#cancelReferenceLink','#saveReferenceLink'])await reachable(page,selector);
    await page.locator('#referenceLinkForm').evaluate(form=>form.scrollTop=0);await frames(page);
    const photos=await addPhotos(page);await choose(page,0);await page.locator('#referenceNotes').fill('Keep the grass texture and warm mountain light.');await page.locator('#labelComment').fill('Use these references for the numbered meadow area.');
    await page.locator('#referenceLinkForm').evaluate(form=>form.scrollTop=0);await frames(page);
    await page.screenshot({path:path.join(qa,prefix+'-populated.png')});
    record.populated={structure:await structure(page,true,viewport.width),icons:await icons(page,true),footer:await footer(page)};
    assert.equal(await page.locator('#referenceGalleryCount').textContent(),'8 photos');
    assert.equal(await page.locator('#referenceGallery .reference-gallery-photo.selected[aria-pressed="true"]').count(),1);
    const controls=['#referenceWebQuery','#searchReferenceWeb','#chooseReferencePhoto','#pasteReferencePhoto','#referenceChoice','[data-ref-tool="move"]','[data-ref-tool="text"]','[data-ref-tool="pencil"]','[data-ref-tool="highlight"]','#refColor','#refColorWheel','#refEdit','#refUndo','#refRedo','#refDelete','#referenceNotes','#labelComment','#removeLinkedPhoto','#unlinkReference','#cancelReferenceLink','#saveReferenceLink'];
    record.reachable=[];for(const selector of controls)record.reachable.push(await reachable(page,selector));
    await page.locator('[data-ref-tool="text"]').click();record.reachable.push(await reachable(page,'#refTextSize'));
    await page.locator('[data-ref-tool="pencil"]').click();record.reachable.push(await reachable(page,'#refBrushSize'));
    await page.locator('#referenceGallery .reference-gallery-photo').last().scrollIntoViewIfNeeded();await page.locator('#referenceGallery .reference-gallery-photo').last().focus();await page.keyboard.press('Enter');await page.waitForFunction(name=>document.querySelector('#referenceName').textContent===name,photos[7].name);
    assert.equal(await page.locator('#referenceGallery .reference-gallery-photo.selected[aria-pressed="true"]').count(),1,'Keyboard selection leaves exactly one active photo');
    record.footerAtEnd=await footer(page);
    await page.locator('#referenceLinkForm').evaluate(form=>form.scrollTop=form.scrollHeight);await frames(page);record.footerAtBottom=await footer(page);
    await saveLinks(page);record.bottomStrip=await bottomStrip(page,8);
    await page.screenshot({path:path.join(qa,prefix+'-saved-strip.png')});
  });
}

async function refPoint(page,x,y){
  const canvas=page.locator('#refCanvas');await canvas.evaluate(canvas=>canvas.scrollIntoView({block:'center',inline:'nearest'}));await frames(page);
  const r=await canvas.boundingBox(),size=await canvas.evaluate(canvas=>({width:canvas.width,height:canvas.height})),p={x:r.x+x*r.width/size.width,y:r.y+y*r.height/size.height};
  const hit=await canvas.evaluate((canvas,p)=>{const stage=canvas.closest('#refCanvasStage'),target=document.elementFromPoint(p.x,p.y);return {visible:Boolean(target&&stage.contains(target)),target:target?.id||target?.tagName};},p);
  assert.equal(hit.visible,true,'Reference annotation coordinates target the visible canvas: '+JSON.stringify({source:{x,y},p,hit}));return p;
}
async function refPencil(page){
  await page.locator('[data-ref-tool="pencil"]').click();await control(page,'refBrushSize',8);await control(page,'refColor','#00ff00');
  const a=await refPoint(page,80,320),b=await refPoint(page,400,320);await page.mouse.move(a.x,a.y);await page.mouse.down();await page.mouse.move(b.x,b.y,{steps:12});await page.mouse.up();
  await page.waitForFunction(()=>{const pixel=document.querySelector('#refCanvas').getContext('2d').getImageData(240,320,1,1).data;return pixel[0]===0&&pixel[1]===255&&pixel[2]===0;});return [a,b];
}
async function refText(page,value,x=120,y=95,commit=true){
  await page.locator('[data-ref-tool="text"]').click();await control(page,'refTextSize',25);await control(page,'refColor','#f24326');const p=await refPoint(page,x,y);await page.mouse.click(p.x,p.y);await page.locator('#refTextEditor').fill(value);if(commit)await page.locator('#refTextEditor').press('Enter');return p;
}
async function canvasHash(page){return page.locator('#refCanvas').evaluate(async canvas=>{const pixels=canvas.getContext('2d').getImageData(0,0,canvas.width,canvas.height).data;return [...new Uint8Array(await crypto.subtle.digest('SHA-256',pixels))].map(value=>value.toString(16).padStart(2,'0')).join('');});}
check('compact annotation coordinates persist and Cancel is atomic',async(page,record)=>{
  await setup(page);await page.setViewportSize({width:800,height:800});await open(page);const photos=await addPhotos(page);await choose(page,0);
  record.pencilPoints=await refPencil(page);record.textPoint=await refText(page,'Meadow');
  await page.locator('#referenceNotes').fill('Preserve the meadow texture.');await page.locator('#labelComment').fill('Apply the selected references to area 1.');
  await page.locator('[data-ref-tool="move"]').click();await frames(page);record.annotatedHash=await canvasHash(page);
  await page.screenshot({path:path.join(qa,'compact-annotated-photo.png')});await saveLinks(page);const saved=await saveProject(page),ref=saved.data.references[0],label=saved.data.layers.find(layer=>layer.kind==='text');
  assert.equal(saved.data.references.length,8);assert.equal(label.referenceComment,'Apply the selected references to area 1.');assert.equal(label.referenceIds.length,8);
  assert.equal(ref.source,photos[0].source,'Saving annotations retains the original PNG bytes');assert.equal(ref.notes,'Preserve the meadow texture.');assert.deepEqual(ref.annotations.map(layer=>layer.kind),['drawing','text']);assert.equal(ref.annotations[1].text.content,'Meadow');
  const stroke=ref.annotations[0],first=stroke.drawing.points[0],last=stroke.drawing.points.at(-1);
  assert.ok(Math.abs(stroke.x+first[0]-80)<.6&&Math.abs(stroke.y+first[1]-320)<.6&&Math.abs(stroke.x+last[0]-400)<.6&&Math.abs(stroke.y+last[1]-320)<.6,'Drawing coordinates match source-photo coordinates');
  assert.ok(Math.abs(ref.annotations[1].x-120)<.6&&Math.abs(ref.annotations[1].y-95)<.6,'Text coordinates match source-photo coordinates');
  for(let index=0;index<8;index++)assert.equal(saved.data.references[index].source,photos[index].source);
  await page.locator('#projectInput').setInputFiles({name:saved.name,mimeType:'application/json',buffer:saved.buffer});await idle(page);await open(page);await choose(page,0);await frames(page);
  assert.equal(await canvasHash(page),record.annotatedHash,'Editable annotations reproduce their rendered pixels after project reopen');
  await page.locator('#referenceNotes').fill('Discard this changed note');await page.locator('#labelComment').fill('Discard this changed comment');await refText(page,'Discard pending text',130,180,false);
  await page.locator('#referenceGallery .reference-gallery-remove').last().focus();await page.keyboard.press('Enter');await gallery(page,7);
  const extra=await fixture(page,8);await page.locator('#referenceFileInput').setInputFiles(file(extra));await gallery(page,8);await close(page);
  const after=await saveProject(page);assert.deepEqual(after.data,saved.data,'Cancel discards pending annotations, notes, comments, additions and removals atomically');
  record.retainedOriginals=8;record.annotations=ref.annotations.map(layer=>({kind:layer.kind,x:layer.x,y:layer.y,width:layer.width,height:layer.height}));record.atomicCancel=true;
});

check('gallery remove buttons support keyboard activation and preserve selected state',async(page,record)=>{
  await setup(page);await theme(page,'dark');await page.setViewportSize({width:1080,height:800});await open(page);const photos=await addPhotos(page);
  await choose(page,7);const button=page.locator('#referenceGallery .reference-gallery-remove').last();await reachable(page,'#referenceGallery .reference-gallery-card:last-child .reference-gallery-remove');await button.focus();await page.keyboard.press('Enter');await gallery(page,7);
  await page.waitForFunction(name=>document.querySelector('#referenceName').textContent===name&&document.querySelector('#referenceEditorHost').dataset.refReady==='true',photos[6].name);
  const state=await page.evaluate(()=>{const selected=[...document.querySelectorAll('#referenceGallery .reference-gallery-photo')].filter(button=>button.classList.contains('selected'));return {count:document.querySelector('#referenceGalleryCount').textContent,selected:selected.map(button=>({name:button.title,pressed:button.getAttribute('aria-pressed')})),focused:document.activeElement?.dataset.referenceKey,selectedKey:selected[0]?.dataset.referenceKey};});
  assert.equal(state.count,'7 photos');assert.deepEqual(state.selected,[{name:photos[6].name,pressed:'true'}]);assert.equal(state.focused,state.selectedKey,'Removing the active photo restores keyboard focus to the next active photo');
  await page.screenshot({path:path.join(qa,'dark-keyboard-remove.png')});record.state=state;await close(page);
  assert.equal(await page.locator('#referenceCount').textContent(),'0 photos','Cancelled gallery removals never create project references');
});

for(const value of ['light','dark'])check(value+' paginated reference export layout',async(page,record)=>{
  await setup(page);await theme(page,value);await page.setViewportSize({width:1080,height:800});await open(page);await addPhotos(page,13);await saveLinks(page);
  const before=await saveProject(page);
  await page.locator('#copyReferencesTop').click();await page.locator('#referenceExportDialog').waitFor({state:'visible'});await frames(page);
  assert.equal(await page.locator('#referencePageChoice option').count(),2,'Thirteen photos use a two-page export picker');
  assert.match(await page.locator('#referenceExportInfo').textContent(),/13 reference photos.*2 pages/);
  record.geometry=await page.evaluate(()=>{
    const dialog=document.querySelector('#referenceExportDialog'),r=dialog.getBoundingClientRect(),reference=document.querySelector('#referenceDialog');
    const ids=['closeReferenceExport','referencePageChoice','downloadReferencePages','downloadCompleteReferencePackPages','copyReferencePage'];
    return {dialog:{left:r.left,right:r.right,top:r.top,bottom:r.bottom,width:r.width,height:r.height,clientWidth:dialog.clientWidth,scrollWidth:dialog.scrollWidth},viewport:{width:innerWidth,height:innerHeight},background:getComputedStyle(dialog).backgroundColor,referenceBackground:getComputedStyle(reference).backgroundColor,icons:[...dialog.querySelectorAll('.reference-icon')].map(svg=>({hidden:svg.getAttribute('aria-hidden'),focusable:svg.getAttribute('focusable')})),controls:ids.map(id=>{const element=document.getElementById(id),box=element.getBoundingClientRect(),hit=document.elementFromPoint(box.x+box.width/2,box.y+box.height/2);return {id,left:box.left,right:box.right,top:box.top,bottom:box.bottom,hit:Boolean(hit&&(element===hit||element.contains(hit)))};})};
  });
  const g=record.geometry;assert.ok(g.dialog.left>=0&&g.dialog.right<=g.viewport.width&&g.dialog.top>=0&&g.dialog.bottom<=g.viewport.height,'Export dialog fits the viewport');assert.ok(g.dialog.scrollWidth<=g.dialog.clientWidth+1,'Export dialog has no horizontal overflow');assert.equal(g.background,g.referenceBackground,'Export dialog shares the reference studio theme');
  assert.ok(g.icons.length>=4,'Export heading and actions use local illustrations');for(const icon of g.icons){assert.equal(icon.hidden,'true');assert.equal(icon.focusable,'false');}
  for(const item of g.controls){assert.ok(item.hit&&item.left>=g.dialog.left&&item.right<=g.dialog.right&&item.top>=g.dialog.top&&item.bottom<=g.dialog.bottom,'Export control stays visible: '+JSON.stringify(item));await page.locator('#'+item.id).focus();assert.equal(await page.locator('#'+item.id).evaluate(element=>element===document.activeElement),true);}
  await page.locator('#referencePageChoice').selectOption('1');assert.match(await page.locator('#referencePageChoice option:checked').textContent(),/Page 2 of 2/);
  await page.screenshot({path:path.join(qa,value+'-paginated-export-1080x800.png')});
  await page.locator('#closeReferenceExport').click();await page.locator('#referenceExportDialog').waitFor({state:'hidden'});
  assert.deepEqual((await saveProject(page)).data,before.data,'Page selection and closing export leave the editable project unchanged');
});

