import {test,before,after} from 'node:test';
import assert from 'node:assert/strict';
import {mkdir,writeFile} from 'node:fs/promises';
import path from 'node:path';
import {chromium} from 'playwright';
import {createServer} from '../server.mjs';

let server,browser,page,base;const errors=[],report=[],qa=path.resolve('qa','rotation');
before(async()=>{
  await mkdir(qa,{recursive:true});server=createServer({detection:{status:async()=>({available:false}),dispose(){}},sheets:{dispose(){}},images:{dispose(){}}});await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));base=`http://127.0.0.1:${server.address().port}`;
  browser=await chromium.launch({headless:true});page=await browser.newPage();page.on('pageerror',error=>errors.push(error.message));await page.route('**/*',route=>new URL(route.request().url()).origin===base?route.continue():route.abort());await page.goto(base+'/health');
  await page.evaluate(async()=>{
    window.core=await import('/core.mjs');window.geom=await import('/layer-transform.mjs');window.regions=await import('/object-regions.mjs');window.guided=await import('/guided-detection.mjs');window.generations=await import('/image-generation-request.mjs');
    window.fixture=()=>{const canvas=document.createElement('canvas');canvas.width=400;canvas.height=200;const ctx=canvas.getContext('2d');ctx.fillStyle='#008000';ctx.fillRect(0,0,400,200);ctx.fillStyle='#ff0000';ctx.fillRect(50,40,60,70);return {name:'Rotated source.png',source:canvas.toDataURL(),width:400,height:200};};
    window.rectangle=(width,height,x,y,w,h)=>{const counts=[];let previous=0,count=0;for(let row=0;row<height;row++)for(let col=0;col<width;col++){const bit=Number(col>=x&&col<x+w&&row>=y&&row<y+h);if(bit===previous)count++;else{counts.push(count);previous=bit;count=1;}}counts.push(count);return {width,height,counts};};
    window.pixel=async(source,x,y)=>{const image=new Image();image.src=source;await image.decode();const canvas=document.createElement('canvas');canvas.width=image.width;canvas.height=image.height;const ctx=canvas.getContext('2d');ctx.drawImage(image,0,0);return [...ctx.getImageData(Math.floor(x),Math.floor(y),1,1).data];};
  });
});
after(async()=>{await writeFile(path.join(qa,'selection-alignment-report.json'),JSON.stringify({paidCalls:0,errors,cases:report},null,2));await browser?.close();if(server)await new Promise(resolve=>server.close(resolve));assert.deepEqual(errors,[]);});

test('rotated guided manual fallback maps document strokes back onto the exact source pixels',async()=>{
  const result=await page.evaluate(async()=>{
    const c=window.core,g=window.guided,t=window.geom,original=window.fixture(),added=c.addRaster(c.newProject(600,500),original,{fitDocument:false});let project=c.updateLayer(added.project,added.layerId,{x:100,y:100,width:400,height:200,rotation:90});const raster=project.layers[0];
    const first=t.layerPointToDocument(raster,{x:70,y:60}),last=t.layerPointToDocument(raster,{x:90,y:80}),marked=c.addDrawing(project,{mode:'highlight',size:10,points:[[first.x,first.y],[last.x,last.y]]});project=marked.project;
    const before=JSON.stringify(project),working=await g.guidedWorkingCopy(project,marked.layerId),mapped=g.mapGuidedResult(g.manualGuidedResult(working),working),mask=mapped.regions[0].mask;
    return {inside:window.regions.regionContainsPoint(mask,80,70),outside:window.regions.regionContainsPoint(mask,200,70),wrongUnrotated:window.regions.regionContainsPoint(mask,first.x-raster.x,first.y-raster.y),sourceUnchanged:project.assets[raster.assetId].source===original.source&&before===JSON.stringify(project),sourceBox:g.guidedMarkTarget(project,marked.layerId).sourceBox};
  });
  assert.equal(result.inside,true);assert.equal(result.outside,false);assert.equal(result.wrongUnrotated,false);assert.equal(result.sourceUnchanged,true);report.push({name:'guided manual rotated raster',...result});
});

test('composition, annotation guide and AI area mask preserve the same layer rotation',async()=>{
  const result=await page.evaluate(async()=>{
    const c=window.core,t=window.geom,original=window.fixture(),added=c.addRaster(c.newProject(600,500),original,{fitDocument:false});let project=c.updateLayer(added.project,added.layerId,{x:100,y:100,width:400,height:200,rotation:90});const raster=project.layers[0],p=t.layerPointToDocument(raster,{x:80,y:70});
    const label=c.addText(project,{content:'1',x:p.x-8,y:p.y-8,width:16,height:20,fontSize:12,color:'#ff00ff'});project=c.attachObjectRegion(label.project,label.layerId,{version:1,assetId:raster.assetId,rasterLayerId:raster.id,sourceWidth:400,sourceHeight:200,mask:window.rectangle(400,200,50,40,60,70)});project=c.updateLabelComment(project,label.layerId,'Remove this red object only.');
    const before=JSON.stringify(project),input=await window.generations.buildImageGenerationInput(project),mask=input.areaMasks[0].image;
    return {composition:await window.pixel(input.composition.source,p.x,p.y),selected:await window.pixel(mask.source,p.x,p.y),outside:await window.pixel(mask.source,180,170),guide:await window.pixel(input.guide.source,p.x,p.y),unchanged:before===JSON.stringify(project),bounds:window.generations.imageGenerationPlan(project).areas[0].selection.bounds,images:{composition:input.composition.source,mask:mask.source}};
  });
  assert.deepEqual(result.composition,[255,0,0,255]);assert.deepEqual(result.selected,[255,255,255,255]);assert.deepEqual(result.outside,[0,0,0,255]);assert.notDeepEqual(result.guide,result.composition);assert.equal(result.unchanged,true);
  await writeFile(path.join(qa,'rotated-generation-composition.png'),Buffer.from(result.images.composition.split(',')[1],'base64'));await writeFile(path.join(qa,'rotated-generation-area-mask.png'),Buffer.from(result.images.mask.split(',')[1],'base64'));delete result.images;report.push({name:'rotated generation guides',...result});
});

test('cached automatic detection picks and overlays the rotated source object instead of its old location',async()=>{
  await page.route('**/api/local-detection/status',route=>route.fulfill({json:{available:true,token:'rotation-qa'}}));await page.route('**/api/local-detection',async route=>{const request=route.request().postDataJSON(),mask=await page.evaluate(({width,height})=>window.rectangle(width,height,50,40,60,70),request);await route.fulfill({json:{width:request.width,height:request.height,regions:[{id:'red object',mask}]}});});
  const result=await page.evaluate(async()=>{
    const c=window.core,t=window.geom,added=c.addRaster(c.newProject(600,500),window.fixture(),{fitDocument:false}),project=c.updateLayer(added.project,added.layerId,{x:100,y:100,width:400,height:200,rotation:90}),raster=project.layers[0],overlay=document.createElement('canvas'),messages=[];
    const detection=(await import('/auto-detection.mjs')).createLocalDetection({getProject:()=>project,canHover:()=>true,overlay,onChange:()=>{},onError:message=>messages.push(message)});await detection.run();const correct=t.layerPointToDocument(raster,{x:80,y:70}),hit=detection.pick(correct),wrong=detection.pick({x:180,y:170});detection.hover(correct);
    return {id:hit?.region?.id,wrong:wrong?.region?.id||null,visible:!overlay.hidden,alpha:overlay.getContext('2d').getImageData(correct.x,correct.y,1,1).data[3],messages};
  });
  assert.equal(result.id,'red object');assert.equal(result.wrong,null);assert.equal(result.visible,true);assert(result.alpha>0);assert.deepEqual(result.messages,[]);report.push({name:'rotated detector hit and overlay',...result});
});
