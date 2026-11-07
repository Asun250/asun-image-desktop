import {test,before,after} from 'node:test';
import assert from 'node:assert/strict';
import {chromium} from 'playwright';
import {createServer} from '../server.mjs';
let server,browser,page;
before(async()=>{
  server=createServer();await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));browser=await chromium.launch({headless:true});page=await browser.newPage();await page.goto(`http://127.0.0.1:${server.address().port}/health`);
  await page.evaluate(async()=>{
    window.core=await import('/core.mjs');window.render=await import('/render.mjs');window.geometry=await import('/layer-transform.mjs');window.erase=await import('/object-erase.mjs');window.fit=await import('/canvas-fit.mjs');
    window.fixture=()=>{
      const c=document.createElement('canvas');c.width=80;c.height=40;const ctx=c.getContext('2d');ctx.fillStyle='#ff0000';ctx.fillRect(0,0,40,40);ctx.fillStyle='#0000ff';ctx.fillRect(40,0,40,40);
      const added=core.addRaster(core.newProject(200,160),{name:'Two colors.png',source:c.toDataURL(),width:80,height:40},{fitDocument:false});
      let project=core.updateLayer(added.project,added.layerId,{x:60,y:60});
      const text=core.addText(project,{content:'1',x:60,y:60,width:12,height:15,fontSize:10});
      project=core.attachObjectRegion(text.project,text.layerId,{version:1,assetId:added.project.layers[0].assetId,rasterLayerId:added.layerId,sourceWidth:80,sourceHeight:40,mask:{width:8,height:4,counts:[8,2,4,2,2,2,4,2,6]}});
      return {project,rasterId:added.layerId,labelId:text.layerId};
    };
    window.draw=async(project,options={})=>{const canvas=document.createElement('canvas');await render.renderProject(project,canvas,options);return {canvas,pixel:(x,y)=>[...canvas.getContext('2d').getImageData(x,y,1,1).data]};};
  });
});
after(async()=>{await browser?.close();if(server)await new Promise(resolve=>server.close(resolve));});
test('rotated raster output shows clockwise pixels and source-coordinate masking at the correct location',async()=>{
  const result=await page.evaluate(async()=>{
    let {project,rasterId,labelId}=fixture();project=core.updateLayer(project,labelId,{visible:false});project=core.updateLayer(project,rasterId,{rotation:90});
    const rotated=await draw(project),masked=await draw(core.addMaskStroke(project,rasterId,{mode:'hide',size:10,points:[[10,20]]}));
    return {top:rotated.pixel(100,50),bottom:rotated.pixel(100,110),outside:rotated.pixel(70,80),mask:masked.pixel(100,50),untouched:masked.pixel(100,110)};
  });
  assert.deepEqual({top:result.top,bottom:result.bottom,outside:result.outside,mask:result.mask,untouched:result.untouched},{top:[255,0,0,255],bottom:[0,0,255,255],outside:[0,0,0,0],mask:[0,0,0,0],untouched:[0,0,255,255]});
});
test('exact grouped-region erase and clipped overlays rotate together without erasing the gap',async()=>{
  const result=await page.evaluate(async()=>{
    let {project,rasterId,labelId}=fixture();project=core.updateLayer(project,rasterId,{rotation:37});const raster=project.layers[0];
    const erased=erase.eraseObjectRegions(project,[labelId]),output=await draw(erased);
    const coords=(x,y)=>{const p=geometry.layerPointToDocument(raster,{x,y});return [Math.round(p.x),Math.round(p.y)];};
    const first=coords(10,15),second=coords(70,15),gap=coords(40,15);
    const overlay=document.createElement('canvas');overlay.width=200;overlay.height=160;render.drawRasterRegionOverlay(overlay.getContext('2d'),project,raster,project.layers[1].objectRegion.mask,{color:'#00ff00',fillOpacity:1,outlineOpacity:0});
    const clipped=document.createElement('canvas');clipped.width=200;clipped.height=160;render.drawRasterRegionOverlay(clipped.getContext('2d'),erased,erased.layers[0],project.layers[1].objectRegion.mask,{fillOpacity:1,outlineOpacity:0});
    const alpha=(canvas,point)=>canvas.getContext('2d').getImageData(...point,1,1).data[3];
    return {first:output.pixel(...first)[3],second:output.pixel(...second)[3],gap:output.pixel(...gap)[3],overlayFirst:alpha(overlay,first),overlayGap:alpha(overlay,gap),clippedFirst:alpha(clipped,first)};
  });
  assert.deepEqual(result,{first:0,second:0,gap:255,overlayFirst:255,overlayGap:0,clippedFirst:0});
});
test('rotation survives exact PNG export, bounded preview, native reopen, variants and undo',async()=>{
  const result=await page.evaluate(async()=>{
    let {project,rasterId,labelId}=fixture();project=core.updateLayer(project,labelId,{visible:false});const history=new core.History(project),rotated=core.updateLayer(project,rasterId,{rotation:90});history.commit(rotated,'Rotate');
    const output=await draw(rotated),undo=await draw(history.undo()),redo=await draw(history.redo());
    const saved=core.saveVariant(rotated,'90 degrees'),reopened=core.parseProject(core.serializeProject(saved)),again=await draw(reopened),variant=await draw(core.restoreVariant(core.updateLayer(reopened,rasterId,{rotation:0}),reopened.variants[0].id));
    const blob=await render.exportImage(reopened,'png'),bitmap=await createImageBitmap(blob),canvas=document.createElement('canvas');canvas.width=bitmap.width;canvas.height=bitmap.height;canvas.getContext('2d').drawImage(bitmap,0,0);bitmap.close();
    const preview=document.createElement('canvas');await render.renderProjectPreview(reopened,preview,{maxSide:100});
    return {undo:undo.pixel(100,50)[3],redo:redo.pixel(100,50),reopenSame:output.canvas.toDataURL()===again.canvas.toDataURL(),variantSame:output.canvas.toDataURL()===variant.canvas.toDataURL(),pngSame:output.canvas.toDataURL()===canvas.toDataURL(),preview:[...preview.getContext('2d').getImageData(50,25,1,1).data],originalSame:JSON.stringify(project.assets)===JSON.stringify(rotated.assets)};
  });
  assert.deepEqual(result,{undo:0,redo:[255,0,0,255],reopenSame:true,variantSame:true,pngSame:true,preview:[255,0,0,255],originalSame:true});
});
test('Fit canvas exports every rotated edge at native size',async()=>{
  const result=await page.evaluate(async()=>{
    const {project,rasterId,labelId}=fixture(),rotated=core.updateLayer(core.updateLayer(project,labelId,{visible:false}),rasterId,{rotation:90}),fitted=fit.fitCanvasToImage(rotated,rasterId),output=await draw(fitted);
    return {size:[output.canvas.width,output.canvas.height],top:output.pixel(20,1),bottom:output.pixel(20,78),left:output.pixel(1,20),right:output.pixel(38,60),corners:[output.pixel(0,0)[3],output.pixel(39,79)[3]]};
  });
  assert.deepEqual(result,{size:[40,80],top:[255,0,0,255],bottom:[0,0,255,255],left:[255,0,0,255],right:[0,0,255,255],corners:[255,255]});
});
test('thin nonuniform previews keep rotated selection paint aligned with the raster',async()=>{
  const result=await page.evaluate(async()=>{
    // Height clamps to one output pixel: x scales by .05 while y stays 1.
    // Rotating already-scaled bounds would incorrectly make this selection
    // forty pixels wide, while the real rotated image is only two pixels wide.
    const source=document.createElement('canvas');source.width=200;source.height=40;source.getContext('2d').fillStyle='#00ff00';source.getContext('2d').fillRect(0,0,200,40);
    const added=core.addRaster(core.newProject(1000,1),{name:'Green.png',width:200,height:40,source:source.toDataURL()},{fitDocument:false});
    let project=core.updateLayer(added.project,added.layerId,{x:400,y:-19.5,width:200,height:40,rotation:90});
    const text=core.addText(project,{content:'1',x:0,y:100,width:4,height:4,fontSize:2,color:'#ff0000'});
    project=core.attachObjectRegion(text.project,text.layerId,{version:1,assetId:added.project.layers[0].assetId,rasterLayerId:added.layerId,sourceWidth:200,sourceHeight:40,mask:{width:20,height:4,counts:[0,80]}});
    const preview=document.createElement('canvas');await render.renderProjectPreview(project,preview,{maxSide:50});
    const ctx=preview.getContext('2d'),pixel=x=>[...ctx.getImageData(x,0,1,1).data];
    return {width:preview.width,height:preview.height,left:pixel(10),right:pixel(40),inside:pixel(25)};
  });
  assert.equal(result.width,50);assert.equal(result.height,1);assert.deepEqual(result.left,[0,0,0,0]);assert.deepEqual(result.right,[0,0,0,0]);
  assert.equal(result.inside[3],255);assert.ok(result.inside[0]>0&&result.inside[1]>0,'The selection tint appears over the actual green image');
});
