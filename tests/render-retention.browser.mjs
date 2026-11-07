import {test,before,after,beforeEach} from 'node:test';
import assert from 'node:assert/strict';
import {readFile,access} from 'node:fs/promises';
import path from 'node:path';
import {chromium} from 'playwright';
import {createServer} from '../server.mjs';

const baseline = process.env.ASUN_RETENTION_BASELINE_DIR;
let server,browser,page;
before(async()=>{
  if(process.env.ASUN_RETENTION_BASELINE && !baseline) throw new Error('Set ASUN_RETENTION_BASELINE_DIR to a public-source directory containing render.mjs and image-source.mjs, or unset ASUN_RETENTION_BASELINE.');
  if(baseline) for(const name of ['render.mjs','image-source.mjs']) await access(path.join(baseline,name)).catch(()=>{throw new Error(`ASUN_RETENTION_BASELINE_DIR must contain ${name}.`);});
  server=createServer({detection:{status:async()=>({available:false}),dispose(){}},sheets:{dispose(){}},images:{dispose(){}}});
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  browser=await chromium.launch({headless:true});page=await browser.newPage();
  const base=`http://127.0.0.1:${server.address().port}`;
  await page.route('**/*',async route=>{
    const url=new URL(route.request().url());assert.equal(url.origin,base,'No external requests in cache checks.');
    if(url.pathname==='/cache-retention.html')return route.fulfill({contentType:'text/html',body:'<!doctype html><title>Isolated cache retention test</title>'});
    if(baseline&&['/render.mjs','/image-source.mjs'].includes(url.pathname))return route.fulfill({contentType:'text/javascript',body:await readFile(path.join(baseline,url.pathname.slice(1)),'utf8')});
    return route.continue();
  });
  await page.goto(base+'/cache-retention.html');
  await page.evaluate(async()=>{
    const NativeImage=window.Image;window.imageDecodes=0;window.Image=class extends NativeImage{constructor(...args){super(...args);imageDecodes++;}};
    const fillRect=CanvasRenderingContext2D.prototype.fillRect;
    window.maskRows=0;CanvasRenderingContext2D.prototype.fillRect=function(...args){if(args[3]===1&&args[1]>=0&&this.canvas.width===window.maskSide)maskRows++;return fillRect.apply(this,args);};
    window.core=await import('/core.mjs');window.render=await import('/render.mjs');window.imageSource=await import('/image-source.mjs');
    window.fixture=(index=0,side=24)=>{const c=document.createElement('canvas');c.width=side;c.height=side;const x=c.getContext('2d');x.fillStyle=`rgb(${index%256}, ${(index*3)%256}, ${(index*7)%256})`;x.fillRect(0,0,side,side);return{name:`Photo ${index}.png`,source:c.toDataURL(),width:side,height:side};};
    window.maskedProject=(mask)=>{const {project}=core.addRaster(core.newProject(),fixture(1));project.layers[0].mask=[{mode:'hide',region:mask,sourceWidth:24,sourceHeight:24}];return project;};
    window.draw=async project=>{const c=document.createElement('canvas');await render.renderProject(project,c);return c;};
  });
});
beforeEach(async()=>page.evaluate(()=>{render.clearImageCache();imageSource.clearPreviewCache();window.imageDecodes=0;window.maskRows=0;window.maskSide=0;}));
after(async()=>{await browser?.close();if(server)await new Promise(resolve=>server.close(resolve));});

test('decoded originals have an LRU entry limit and re-decode the exact original after eviction',async()=>{
  const result=await page.evaluate(async()=>{
    const sources=Array.from({length:13},(_,i)=>fixture(i));
    for(const image of sources)await render.decodeImage(image.source);
    const before=imageDecodes;await render.decodeImage(sources[12].source);const recent=imageDecodes;
    const decoded=await render.decodeImage(sources[0].source),c=document.createElement('canvas');c.width=24;c.height=24;c.getContext('2d').drawImage(decoded,0,0);
    return{before,recent,after:imageDecodes,exact:c.toDataURL()===sources[0].source};
  });
  assert.equal(result.before,13);assert.equal(result.recent,13);assert.equal(result.after,14);assert.equal(result.exact,true);
});

test('decoded original pixel memory is bounded even with only three large photos',async()=>{
  const result=await page.evaluate(async()=>{
    const sources=Array.from({length:3},(_,i)=>fixture(i,4096));
    for(const image of sources)await render.decodeImage(image.source);
    const before=imageDecodes;await render.decodeImage(sources[0].source);
    return{before,after:imageDecodes};
  });
  assert.equal(result.before,3);assert.equal(result.after,4,'A third 64 MiB image evicts the oldest beyond128 MiB.');
});

test('cache reset discards erased-region canvases while preserving old Undo objects and exact alpha',async()=>{
  const result=await page.evaluate(async()=>{
    window.maskSide=16;const mask={width:16,height:16,counts:[0,256]},project=maskedProject(mask);
    const first=await draw(project),before=maskRows;await draw(project);const cached=maskRows;
    render.clearImageCache();const after=await draw(project);
    return{before,cached,after:maskRows,exact:first.toDataURL()===after.toDataURL(),alpha:after.getContext('2d').getImageData(8,8,1,1).data[3],runs:mask.counts};
  });
  assert.equal(result.before,16);assert.equal(result.cached,16);assert.equal(result.after,32);assert.equal(result.exact,true);assert.equal(result.alpha,0);assert.deepEqual(result.runs,[0,256]);
});

test('erased-region canvases have entry and memory limits even when Undo retains every mask',async()=>{
  const result=await page.evaluate(async()=>{
    window.maskSide=16;const small=Array.from({length:9},()=>({width:16,height:16,counts:[0,256]}));
    for(const mask of small)await draw(maskedProject(mask));const smallBefore=maskRows;await draw(maskedProject(small[0]));const smallAfter=maskRows;
    render.clearImageCache();window.maskSide=1600;window.maskRows=0;
    const large=Array.from({length:4},()=>({width:1600,height:1600,counts:[0,2560000]}));
    for(const mask of large)await draw(maskedProject(mask));const largeBefore=maskRows;await draw(maskedProject(large[0]));
    return{smallBefore,smallAfter,largeBefore,largeAfter:maskRows};
  });
  assert.equal(result.smallAfter-result.smallBefore,16,'Ninth distinct mask evicts oldest of eight.');
  assert.equal(result.largeAfter-result.largeBefore,1600,'Four1600² masks exceed32 MiB.');
});

test('pending decodes survive reset without returning stale cache entries or dropping callers',async()=>{
  const result=await page.evaluate(async()=>{
    const source=fixture(32).source,first=render.decodeImage(source);render.clearImageCache();const second=render.decodeImage(source);
    const [a,b]=await Promise.all([first,second]);const again=await render.decodeImage(source);
    return{decodes:imageDecodes,separate:a!==b,current:b===again,dimensions:[a.naturalWidth,b.naturalWidth]};
  });
  assert.deepEqual(result,{decodes:2,separate:true,current:true,dimensions:[24,24]});
});

test('thumbnail cache budget includes full original keys and handles concurrent previews across reset',async()=>{
  const result=await page.evaluate(async()=>{
    // Legal PNG padding creates a large source string without a large pixel allocation.
    // This emulates old projects without saved thumbnails whose original keys are large.
    const source=fixture(10).source,header=source.slice(0,source.indexOf(',')+1),payload=atob(source.slice(source.indexOf(',')+1));
    const images=Array.from({length:3},(_,index)=>({source:header+btoa(payload+String(index)+'\0'.repeat(5*1024*1024))}));
    let previews=0;const old=HTMLCanvasElement.prototype.toDataURL;HTMLCanvasElement.prototype.toDataURL=function(...args){previews++;return old.apply(this,args);};
    for(const image of images)await imageSource.previewSource(image);const before=previews;await imageSource.previewSource(images[0]);const after=previews;
    imageSource.clearPreviewCache();const first=imageSource.previewSource(images[0]);imageSource.clearPreviewCache();const second=imageSource.previewSource(images[0]);const values=await Promise.all([first,second]);const afterPending=previews;await imageSource.previewSource(images[0]);
    HTMLCanvasElement.prototype.toDataURL=old;
    return{before,after,afterPending,final:previews,equal:values[0]===values[1]};
  });
  assert.equal(result.before,3);assert.equal(result.after,4,'Three large source keys exceed32 MiB.');assert.equal(result.afterPending,6);assert.equal(result.final,6);assert.equal(result.equal,true);
});

test('paint frames release their private mask copies immediately while keeping cached source pixels',async()=>{
  const result=await page.evaluate(async()=>{
    const {project,layerId}=core.addRaster(core.newProject(),fixture(10));const original=await draw(project);
    const masked=core.addMaskStroke(project,layerId,{mode:'hide',size:8,points:[[12,12]]});
    const nativeCreate=document.createElement,created=[];
    document.createElement=function(...args){const result=nativeCreate.apply(this,args);if(args[0]==='canvas')created.push(result);return result;};
    let painted;try{painted=await draw(masked);}finally{document.createElement=nativeCreate;}
    const privateBuffers=created.filter(item=>item!==painted);
    const again=await draw(project);
    return{privateCount:privateBuffers.length,released:privateBuffers.every(item=>item.width===0&&item.height===0),alpha:painted.getContext('2d').getImageData(12,12,1,1).data[3],originalSame:original.toDataURL()===again.toDataURL(),decodes:imageDecodes};
  });
  assert.equal(result.privateCount,2);assert.equal(result.released,true);assert.equal(result.alpha,0);assert.equal(result.originalSame,true);assert.equal(result.decodes,1);
});

test('in-flight reset and failed masking release only private working canvases',async()=>{
  const result=await page.evaluate(async()=>{
    const {project}=core.addRaster(core.newProject(),fixture(18));
    const nativeCreate=document.createElement,created=[];
    document.createElement=function(...args){const result=nativeCreate.apply(this,args);if(args[0]==='canvas')created.push(result);return result;};
    let output;try{const pending=draw(project);render.clearImageCache();output=await pending;}finally{document.createElement=nativeCreate;}
    const unshared=created.filter(item=>item!==output).map(item=>[item.width,item.height]);
    await draw(project);created.length=0;const bad={...project,layers:[{...project.layers[0],mask:[{mode:'hide',size:8,points:[]}]}]};
    let failed=false;document.createElement=function(...args){const result=nativeCreate.apply(this,args);if(args[0]==='canvas')created.push(result);return result;};
    try{await draw(bad);}catch{failed=true;}finally{document.createElement=nativeCreate;}
    const failedBuffers=created.slice(1).map(item=>[item.width,item.height]);const next=await draw(project);
    return{unshared,failed,failedBuffers,originalSame:output.toDataURL()===next.toDataURL()};
  });
  assert.deepEqual(result.unshared,[[0,0]]);assert.equal(result.failed,true);assert.deepEqual(result.failedBuffers,[[0,0],[0,0]]);assert.equal(result.originalSame,true);
});
