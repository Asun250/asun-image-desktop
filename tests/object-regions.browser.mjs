import {test,before,after} from 'node:test';
import assert from 'node:assert/strict';
import {chromium} from 'playwright';
import {createServer} from '../server.mjs';
let server,browser,page;
before(async()=> {
  server=createServer();await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));browser=await chromium.launch({headless:true});page=await browser.newPage();await page.goto(`http://127.0.0.1:${server.address().port}`);
  await page.evaluate(async()=> {
    window.core=await import('/core.mjs');window.render=await import('/render.mjs');window.regions=await import('/object-regions.mjs');
    window.sampleMask=()=> { const width=10,height=8,counts=[];let previous=0,count=0;for(let y=0;y<height;y++)for(let x=0;x<width;x++) {const value=Number(x>=2&&x<8&&y>=2&&y<6&&!(x>=4&&x<6&&y>=3&&y<5));if(value===previous)count++;else {counts.push(count);count=1;previous=value;}}counts.push(count);return {width,height,counts};};
    window.fixture=()=> {
      const canvas=document.createElement('canvas');canvas.width=100;canvas.height=80;const context=canvas.getContext('2d');context.fillStyle='#ffffff';context.fillRect(0,0,100,80);
      const image={name:'White.png',source:canvas.toDataURL('image/png'),width:100,height:80};let {project,layerId:rasterLayerId}=window.core.addRaster(window.core.newProject(),image);
      const added=window.core.addText(project,{content:'1',x:0,y:0,width:20,height:20,fontSize:12,color:'#ff0000'});project=window.core.attachObjectRegion(added.project,added.layerId,{version:1,assetId:project.layers[0].assetId,rasterLayerId,sourceWidth:100,sourceHeight:80,mask:window.sampleMask()});
      return {project,rasterLayerId,labelId:added.layerId,image};
    };
    window.draw=async(project,options={})=> { const canvas=document.createElement('canvas');await window.render.renderProject(project,canvas,options);return {canvas,pixel:(x,y)=>Array.from(canvas.getContext('2d').getImageData(x,y,1,1).data)};};
  });
});
after(async()=> {if(browser)await browser.close();if(server)await new Promise(resolve=>server.close(resolve));});
test('selection fill and outline follow irregular mask while holes and clean-original view stay clean',async()=> {
  const result=await page.evaluate(async()=> {
    const {project,image}=window.fixture(),drawn=await window.draw(project),clean=await window.draw(project,{original:true});
    return {inside:drawn.pixel(65,35),outside:drawn.pixel(90,70),hole:drawn.pixel(50,40),edge:drawn.pixel(20,25),holeEdge:drawn.pixel(40,35),clean:clean.pixel(65,35),sourceUnchanged:project.assets[project.original.assetId].source===image.source};
  });
  assert.equal(result.inside[0],255);assert.ok(result.inside[1]>=225&&result.inside[1]<250);assert.deepEqual(result.inside.slice(1),[result.inside[1],result.inside[1],255]);
  assert.deepEqual(result.outside,[255,255,255,255]);assert.deepEqual(result.hole,[255,255,255,255]);assert.ok(result.edge[1]<100);assert.ok(result.holeEdge[1]<100);assert.deepEqual(result.clean,[255,255,255,255]);assert.equal(result.sourceUnchanged,true);
});
test('source-bound region follows raster transforms and crop even when label moves separately',async()=> {
  const result=await page.evaluate(async()=> {
    let {project,rasterLayerId,labelId}=window.fixture();project=window.core.updateLayer(project,rasterLayerId,{x:-10,y:-10,width:50,height:40});project.width=40;project.height=30;project=window.core.updateLayer(project,labelId,{x:30,y:20});
    const drawn=await window.draw(project),reopened=await window.draw(window.core.parseProject(window.core.serializeProject(project)));
    return {inside:drawn.pixel(5,3),hole:drawn.pixel(15,10),outside:drawn.pixel(35,5),bbox:window.regions.objectRegionBounds(project,project.layers.at(-1)),identical:drawn.canvas.toDataURL()===reopened.canvas.toDataURL()};
  });
  assert.ok(result.inside[1]<250&&result.inside[1]>=225);assert.deepEqual(result.hole,[255,255,255,255]);assert.deepEqual(result.outside,[255,255,255,255]);assert.deepEqual(result.bbox,{x:0,y:0,width:30,height:20});assert.equal(result.identical,true);
});
test('region uses updated number color and respects raster and label visibility without contaminating originals',async()=> {
  const result=await page.evaluate(async()=> {
    const {project,labelId,rasterLayerId}=window.fixture(),blue=window.core.updateText(project,labelId,{color:'#0000ff'});
    const recolored=await window.draw(blue),hiddenLabel=await window.draw(window.core.updateLayer(blue,labelId,{visible:false})),hiddenRaster=await window.draw(window.core.updateLayer(blue,rasterLayerId,{visible:false}));
    const canvas=window.regions.maskToCanvas(blue.layers.at(-1).objectRegion.mask,'#0000ff');
    return {color:recolored.pixel(20,25),hiddenLabel:hiddenLabel.pixel(20,25),hiddenRaster:hiddenRaster.pixel(20,25),maskInside:Array.from(canvas.getContext('2d').getImageData(6,3,1,1).data),maskHole:Array.from(canvas.getContext('2d').getImageData(5,4,1,1).data)};
  });
  assert.ok(result.color[0]<100&&result.color[1]<100&&result.color[2]===255);assert.deepEqual(result.hiddenLabel,[255,255,255,255]);assert.deepEqual(result.hiddenRaster,[0,0,0,0]);assert.deepEqual(result.maskInside,[0,0,255,255]);assert.deepEqual(result.maskHole,[0,0,0,0]);
});
test('bounded board previews and PNG exports retain selection outlines and clean sources',async()=> {
  const result=await page.evaluate(async()=> {
    const {project,image}=window.fixture(),full=await window.draw(project),preview=document.createElement('canvas');await window.render.renderProjectPreview(project,preview,{maxSide:50});
    const blob=await window.render.exportImage(project),decoded=await createImageBitmap(blob),output=document.createElement('canvas');output.width=decoded.width;output.height=decoded.height;output.getContext('2d').drawImage(decoded,0,0);decoded.close();
    const hover=document.createElement('canvas');hover.width=100;hover.height=80;const context=hover.getContext('2d');window.regions.drawRegionOverlay(context,window.sampleMask(),{x:0,y:0,width:100,height:80},{color:'#00ff00',fillOpacity:0});
    return {previewSize:[preview.width,preview.height],previewEdge:Array.from(preview.getContext('2d').getImageData(10,12,1,1).data),same:full.canvas.toDataURL()===output.toDataURL(),sourceUnchanged:project.assets[project.original.assetId].source===image.source,hoverEdge:Array.from(context.getImageData(20,25,1,1).data),hoverInside:Array.from(context.getImageData(65,35,1,1).data)};
  });
  assert.deepEqual(result.previewSize,[50,40]);assert.ok(result.previewEdge[1]<150);assert.equal(result.same,true);assert.equal(result.sourceUnchanged,true);assert.ok(result.hoverEdge[3]>200);assert.deepEqual(result.hoverInside,[0,0,0,0]);
});
test('native Mask/Restore strokes clip saved outlines and hover without changing clean source pixels',async()=> {
  const result=await page.evaluate(async()=> {
    const {project,labelId,rasterLayerId,image}=window.fixture();
    const hidden=window.core.addMaskStroke(project,rasterLayerId,{mode:'hide',size:20,points:[[25,25]]});
    const restored=window.core.addMaskStroke(hidden,rasterLayerId,{mode:'restore',size:8,points:[[25,25]]});
    const a=await window.draw(hidden),b=await window.draw(restored),clean=await window.draw(hidden,{original:true});
    const hover=document.createElement('canvas');hover.width=100;hover.height=80;window.render.drawRasterRegionOverlay(hover.getContext('2d'),hidden,hidden.layers[0],hidden.layers.at(-1).objectRegion.mask,{color:'#ff0000'});
    const preview=document.createElement('canvas');await window.render.renderProjectPreview(hidden,preview,{maxSide:50});
    return {hidden:a.pixel(25,25),restored:b.pixel(25,25),clean:clean.pixel(25,25),hoverAlpha:hover.getContext('2d').getImageData(25,25,1,1).data[3],previewAlpha:preview.getContext('2d').getImageData(12,12,1,1).data[3],hiddenHit:window.regions.objectRegionContains(hidden,hidden.layers.find(layer=>layer.id===labelId),{x:25,y:25}),restoredHit:window.regions.objectRegionContains(restored,restored.layers.find(layer=>layer.id===labelId),{x:25,y:25}),sameSource:hidden.assets[hidden.original.assetId].source===image.source};
  });
  assert.deepEqual(result.hidden,[0,0,0,0]);assert.ok(result.restored[3]===255&&result.restored[0]===255&&result.restored[1]<250);assert.deepEqual(result.clean,[255,255,255,255]);assert.equal(result.hoverAlpha,0);assert.equal(result.previewAlpha,0);assert.equal(result.hiddenHit,false);assert.equal(result.restoredHit,true);assert.equal(result.sameSource,true);
});
