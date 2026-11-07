import {test,before,after} from 'node:test';
import assert from 'node:assert/strict';
import {chromium} from 'playwright';
import {createServer} from '../server.mjs';
let server,browser,page;
before(async()=>{
  server=createServer();await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  browser=await chromium.launch({headless:true});page=await browser.newPage();await page.goto(`http://127.0.0.1:${server.address().port}/`);
  await page.evaluate(async()=>{
    window.core=await import('/core.mjs');window.render=await import('/render.mjs');window.erase=await import('/object-erase.mjs');
    window.fixture=()=>{
      const c=document.createElement('canvas');c.width=160;c.height=120;c.getContext('2d').fillStyle='#00ff00';c.getContext('2d').fillRect(0,0,160,120);
      const {newProject,addRaster,addText,attachObjectRegion}=window.core;
      let {project,layerId:rasterId}=addRaster(newProject(),{name:'Green.png',source:c.toDataURL(),width:160,height:120});
      const {project:withLabel,layerId:labelId}=addText(project,{content:'1',x:1,y:1,width:20,height:30,fontSize:20});
      const counts=[];let previous=0,count=0;for(let y=0;y<12;y++)for(let x=0;x<16;x++){const value=Number((x>=2&&x<6&&y>=2&&y<6&&!(x===3&&y===3))||(x>=10&&x<13&&y>=7&&y<10));if(value===previous)count++;else{counts.push(count);count=1;previous=value;}}counts.push(count);
      project=attachObjectRegion(withLabel,labelId,{version:1,assetId:project.layers[0].assetId,rasterLayerId:rasterId,sourceWidth:160,sourceHeight:120,mask:{width:16,height:12,counts},group:{areaCount:2}});
      return {project,rasterId,labelId};
    };
    window.draw=async(project,options={})=>{const c=document.createElement('canvas');await window.render.renderProject(project,c,options);return {canvas:c,pixel:(x,y)=>[...c.getContext('2d').getImageData(x,y,1,1).data]};};
  });
});
after(async()=>{await browser?.close();if(server)await new Promise(resolve=>server.close(resolve));});
test('actual pixels preserve mask holes, disconnected gaps, transformed alignment and original before view',async()=>{
  const result=await page.evaluate(async()=>{
    let {project,rasterId,labelId}=fixture();project=core.updateLayer(project,rasterId,{x:8,y:6,width:120,height:90});
    const erased=erase.eraseObjectRegions(project,[labelId]),output=await draw(erased),before=await draw(erased,{original:true});
    const pixel=(x,y)=>output.pixel(Math.floor(8+x*7.5),Math.floor(6+y*7.5));
    return {first:pixel(2.5,2.5),second:pixel(11.5,8.5),hole:pixel(3.5,3.5),gap:pixel(8.5,6.5),original:before.pixel(25,25),asset:erased.assets[project.original.assetId].source===project.assets[project.original.assetId].source};
  });
  assert.deepEqual(result,{first:[0,0,0,0],second:[0,0,0,0],hole:[0,255,0,255],gap:[0,255,0,255],original:[0,255,0,255],asset:true});
});
test('save/reopen, variants, Undo/Redo, preview and exported PNG keep precise alpha',async()=>{
  const result=await page.evaluate(async()=>{
    const {project,labelId}=fixture(),history=new core.History(project),erased=erase.eraseObjectRegions(project,[labelId]);history.commit(erased,'Erase object');
    const output=await draw(erased),undo=await draw(history.undo()),redo=await draw(history.redo());
    const saved=core.saveVariant(erased,'Removed'),reopened=core.parseProject(core.serializeProject(saved)),again=await draw(reopened);
    const restored=await draw(core.restoreVariant(core.updateLayer(reopened,reopened.layers[0].id,{mask:[]}),saved.variants[0].id));
    const blob=await render.exportImage(reopened,'png'),bitmap=await createImageBitmap(blob),exported=document.createElement('canvas');exported.width=bitmap.width;exported.height=bitmap.height;exported.getContext('2d').drawImage(bitmap,0,0);bitmap.close();
    const preview=document.createElement('canvas');await render.renderProjectPreview(erased,preview,{maxSide:80});
    return {undoAlpha:undo.pixel(25,25)[3],redoAlpha:redo.pixel(25,25)[3],reopenSame:output.canvas.toDataURL()===again.canvas.toDataURL(),variantSame:output.canvas.toDataURL()===restored.canvas.toDataURL(),pngSame:output.canvas.toDataURL()===exported.toDataURL(),previewAlpha:preview.getContext('2d').getImageData(12,12,1,1).data[3],width:exported.width,height:exported.height};
  });
  assert.deepEqual(result,{undoAlpha:255,redoAlpha:0,reopenSame:true,variantSame:true,pngSame:true,previewAlpha:0,width:160,height:120});
});
test('Restore brush and overlay visibility use the same ordered erasure alpha',async()=>{
  const result=await page.evaluate(async()=>{
    const {project,rasterId,labelId}=fixture();let erased=erase.eraseObjectRegions(project,[labelId]);
    erased=core.addMaskStroke(erased,rasterId,{mode:'restore',size:8,points:[[25,25]]});const output=await draw(erased);
    const overlay=document.createElement('canvas');overlay.width=160;overlay.height=120;
    render.drawRasterRegionOverlay(overlay.getContext('2d'),erased,erased.layers[0],project.layers[1].objectRegion.mask,{fillOpacity:1,outlineOpacity:0});
    const alpha=(x,y)=>overlay.getContext('2d').getImageData(x,y,1,1).data[3];
    return {restored:output.pixel(25,25),stillErased:output.pixel(45,45),overlayRestored:alpha(25,25),overlayHidden:alpha(45,45)};
  });
  assert.deepEqual(result,{restored:[0,255,0,255],stillErased:[0,0,0,0],overlayRestored:255,overlayHidden:0});
});
