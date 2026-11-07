import {offlineGeneration} from './fixtures/offline-generation.mjs';
import {test,before,after} from 'node:test';
import assert from 'node:assert/strict';
import {mkdir} from 'node:fs/promises';
import sharp from 'sharp';
import {chromium} from 'playwright';
import {createServer} from '../server.mjs';
let browser,server;
before(async()=>{await mkdir('qa',{recursive:true});server=createServer(offlineGeneration());await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));browser=await chromium.launch({headless:true});});
after(async()=>{await browser?.close();if(server)await new Promise(resolve=>server.close(resolve));});
for(const viewport of [{width:1672,height:941},{width:1280,height:800}])test(`Pearl Studio geometry and readable controls at ${viewport.width}×${viewport.height}`,async()=>{
  const page=await browser.newPage({viewport});const errors=[];page.on('pageerror',error=>errors.push(error.message));
  try{
    await page.goto(`http://127.0.0.1:${server.address().port}`);await page.waitForFunction(()=>document.documentElement.dataset.ready==='true');
    assert.equal(await page.locator('#transformPanel').isVisible(),false);
    await page.locator('#imageInput').setInputFiles({name:'Synthetic artwork.png',mimeType:'image/png',buffer:await sharp({create:{width:1254,height:1254,channels:4,background:'#c47d42'}}).png().toBuffer()});await page.waitForFunction(()=>document.querySelectorAll('.layer-row').length===1&&!document.body.classList.contains('busy'));
    assert.equal(await page.locator('#transformPanel').getAttribute('open'),null);
    const metrics=await page.evaluate(()=>{const box=selector=>{const r=document.querySelector(selector).getBoundingClientRect();return {x:r.x,y:r.y,right:r.right,bottom:r.bottom,width:r.width,height:r.height};};const size=selector=>parseFloat(getComputedStyle(document.querySelector(selector)).fontSize);return {rail:box('.toolrail'),canvas:box('.canvas-area'),composer:box('.composer'),inspector:box('.panels'),reference:box('.reference-section'),prompt:box('.prompt-section'),model:box('.model-section'),generate:box('.generate-section'),navigator:box('.navigator-preview'),layers:box('.layer-list'),row:box('.layer-row'),font:{brand:size('.brand'),tool:size('.toolrail button span'),layer:size('.layer-title'),panel:size('.panel h2'),prompt:size('#prompt')},docWidth:document.documentElement.scrollWidth,viewport:innerWidth};});
    assert.ok(metrics.rail.width>=68&&metrics.rail.width<=76);assert.ok(Math.abs(metrics.composer.x-metrics.canvas.x)<1);assert.ok(Math.abs(metrics.composer.right-metrics.inspector.right)<1);assert.ok(metrics.inspector.bottom<metrics.composer.y);
    const columns=[metrics.reference,metrics.prompt,metrics.model,metrics.generate];for(let i=1;i<columns.length;i++){assert.ok(columns[i].x>=columns[i-1].right,'Composer fields must not overlap');assert.ok(Math.abs(columns[i].y-columns[0].y)<2,'Composer must remain one horizontal row');}
    assert.ok(metrics.navigator.height>=95);assert.ok(metrics.layers.height<=metrics.row.height+24,'One layer should not leave a large blank area');assert.ok(metrics.font.brand>=20&&metrics.font.tool>=10&&metrics.font.layer>=13&&metrics.font.panel>=13&&metrics.font.prompt>=14);assert.equal(metrics.docWidth,metrics.viewport);
    await page.locator('#showProperties').click();assert.equal(await page.locator('#layerW').isVisible(),true);await page.locator('#layerW').fill('1000');await page.locator('#layerW').press('Tab');assert.equal(await page.locator('#layerH').inputValue(),'1000');await page.locator('#undo').click();assert.equal(await page.locator('#layerW').inputValue(),'1254');await page.locator('#showLayers').click();
    await page.locator('#projectName').click();await page.locator('#nameField').fill('Synthetic layout study');await page.locator('#confirmDialog').click();await page.locator('#prompt').fill('Synthetic layout instruction.');await page.locator('#prompt').blur();await page.locator('#fit').click();await page.locator('#toast').waitFor({state:'hidden'});
    assert.equal(await page.locator('#generate').isDisabled(),true);assert.deepEqual(errors,[]);
    await page.screenshot({path:`qa/studio-fidelity-${viewport.width}.png`});
  }finally{await page.close();}
});
