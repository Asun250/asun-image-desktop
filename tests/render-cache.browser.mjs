import {test,before,after,beforeEach} from 'node:test';
import assert from 'node:assert/strict';
import {chromium} from 'playwright';
import {createServer} from '../server.mjs';
let server,browser,page;
before(async()=>{
  server=createServer({detection:{status:async()=>({available:false}),dispose(){}},sheets:{dispose(){}},images:{dispose(){}}});await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));browser=await chromium.launch({headless:true});page=await browser.newPage();
  const base=`http://127.0.0.1:${server.address().port}`;await page.route('**/*',route=>{const url=new URL(route.request().url());if(url.origin!==base)throw new Error('Unexpected external request.');if(url.pathname==='/cache-test.html')return route.fulfill({contentType:'text/html',body:'<!doctype html><title>Isolated raster rendering test</title>'});return route.continue();});await page.goto(base+'/cache-test.html');
  await page.evaluate(async()=>{
    window.core=await import('/core.mjs');window.render=await import('/render.mjs');
    window.fixture=(color='#e04020',width=64,height=64)=>{const canvas=document.createElement('canvas');canvas.width=width;canvas.height=height;const x=canvas.getContext('2d');x.fillStyle=color;x.fillRect(0,0,width,height);return{name:'Source.png',source:canvas.toDataURL(),width,height};};
    window.draw=async(project,preview=null)=>{const target=document.createElement('canvas');if(preview)await window.render.renderProjectPreview(project,target,{maxSide:preview});else await window.render.renderProject(project,target);return target;};
    window.pixel=(canvas,x,y)=>[...canvas.getContext('2d').getImageData(x,y,1,1).data];
    const drawImage=CanvasRenderingContext2D.prototype.drawImage;CanvasRenderingContext2D.prototype.drawImage=function(...args){if(args[0] instanceof HTMLImageElement)window.sourceDraws++;return drawImage.apply(this,args);};
  });
});
beforeEach(async()=>page.evaluate(()=>{window.render.clearImageCache();window.sourceDraws=0;}));
after(async()=>{await browser?.close();if(server)await new Promise(resolve=>server.close(resolve));});

test('repeated mask edits reuse prepared pixels without changing the source or other renders',async()=>{
  const result=await page.evaluate(async()=>{
    const {project,layerId}=core.addRaster(core.newProject(),fixture()),source=project.assets[project.layers[0].assetId].source;
    const original=await draw(project),masked=core.addMaskStroke(project,layerId,{mode:'hide',size:16,points:[[30,30],[38,30]]}),hidden=await draw(masked),restored=core.addMaskStroke(masked,layerId,{mode:'restore',size:18,points:[[30,30],[38,30]]}),shown=await draw(restored),again=await draw(project);
    return{sourceDraws,sourceUnchanged:masked.assets[masked.layers[0].assetId].source===source,original:pixel(original,34,30),hidden:pixel(hidden,34,30),restored:pixel(shown,34,30),unchanged:original.toDataURL()===again.toDataURL()};
  });
  assert.equal(result.sourceDraws,1,'Painting does not repeatedly filter/decode the unchanged raster.');assert.equal(result.sourceUnchanged,true);assert.equal(result.unchanged,true);assert.equal(result.hidden[3],0);assert.deepEqual(result.original,result.restored);
});

test('source, filters, preview size and cache reset cannot return stale raster pixels',async()=>{
  const result=await page.evaluate(async()=>{
    const {project,layerId}=core.addRaster(core.newProject(),fixture('#ff0000'));
    const original=await draw(project),dark=await draw(core.updateLayer(project,layerId,{brightness:50})),replacement=structuredClone(project);replacement.assets[replacement.layers[0].assetId].source=fixture('#0000ff').source;
    const blue=await draw(replacement),small=await draw(replacement,16),native=await draw(replacement),beforeClear=sourceDraws;render.clearImageCache();const afterClear=await draw(replacement);
    return{original:pixel(original,20,20),dark:pixel(dark,20,20),blue:pixel(blue,20,20),small:[small.width,small.height,...pixel(small,8,8)],native:[native.width,native.height,...pixel(native,20,20)],clearMatch:blue.toDataURL()===afterClear.toDataURL(),beforeClear,afterClear:sourceDraws};
  });
  assert.deepEqual(result.original,[255,0,0,255]);assert(Math.abs(result.dark[0]-127.5)<=.5);assert.deepEqual(result.blue,[0,0,255,255]);assert.deepEqual(result.small,[16,16,0,0,255,255]);assert.deepEqual(result.native,[64,64,0,0,255,255]);assert.equal(result.clearMatch,true);assert.equal(result.afterClear,result.beforeClear+1);
});

test('concurrent original and masked renders never share writable mask pixels',async()=>{
  const result=await page.evaluate(async()=>{
    const {project,layerId}=core.addRaster(core.newProject(),fixture('#00bb66')),masked=core.addMaskStroke(project,layerId,{mode:'hide',size:20,points:[[30,30]]});
    const [a,b,c]=await Promise.all([draw(project),draw(masked),draw(project)]);
    return{original:pixel(a,30,30),mask:pixel(b,30,30),other:pixel(c,30,30),sourceDraws};
  });
  assert.deepEqual(result.original,[0,187,102,255]);assert.equal(result.mask[3],0);assert.deepEqual(result.other,result.original);assert.equal(result.sourceDraws,1);
});

test('retained raster buffers are bounded by entry count and pixel memory',async()=>{
  const result=await page.evaluate(async()=>{
    const small=core.addRaster(core.newProject(),fixture());for(let n=0;n<13;n++)await draw(core.updateLayer(small.project,small.layerId,{brightness:100+n}));const countBefore=sourceDraws;await draw(small.project);const countAfter=sourceDraws;
    render.clearImageCache();window.sourceDraws=0;
    const large=core.addRaster(core.newProject(64,64),fixture('#bb8844',2048,2048),{fitDocument:false});large.project=core.updateLayer(large.project,large.layerId,{width:64,height:64});
    for(let n=0;n<5;n++)await draw(core.updateLayer(large.project,large.layerId,{brightness:100+n}));const bytesBefore=sourceDraws;await draw(large.project);const bytesAfter=sourceDraws;
    return{countBefore,countAfter,bytesBefore,bytesAfter};
  });
  assert.equal(result.countAfter,result.countBefore+1,'A 13th distinct entry evicts the oldest prepared buffer.');assert.equal(result.bytesAfter,result.bytesBefore+1,'A fifth 16MiB buffer evicts the oldest before exceeding 64MiB.');
});
