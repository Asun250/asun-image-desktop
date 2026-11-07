import {test,before,after} from 'node:test';
import assert from 'node:assert/strict';
import {chromium} from 'playwright';
import {createServer} from '../server.mjs';

let server,browser,page,errors=[];
before(async()=>{
  server=createServer();await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));browser=await chromium.launch({headless:true});page=await browser.newPage();page.on('pageerror',error=>errors.push(error.message));
  const base=`http://127.0.0.1:${server.address().port}`;await page.goto(base+'/health');
  await page.evaluate(async()=>{
    window.core=await import('/core.mjs');window.sketch=await import('/sketch-detection.mjs');window.guided=await import('/guided-detection.mjs');window.regions=await import('/object-regions.mjs');
    window.fixture=async()=>{
      const canvas=document.createElement('canvas');canvas.width=600;canvas.height=400;const ctx=canvas.getContext('2d');ctx.fillStyle='#ffffff';ctx.fillRect(0,0,600,400);
      const added=core.addRaster(core.newProject(),{name:'Drawing page',width:600,height:400,source:canvas.toDataURL('image/png')});let project=added.project;
      project.sketch={version:1,background:'#ffffff',surfaceLayerId:added.layerId};
      project=core.addDrawing(project,{mode:'pencil',color:'#000000',size:12,points:[[100,100],[200,100],[200,200],[100,200],[100,100]]}).project;
      return {project,surfaceId:added.layerId,pencilId:project.layers.at(-1).id};
    };
    window.pixel=async(source,x,y)=>{const img=await(await import('/render.mjs')).decodeImage(source),canvas=document.createElement('canvas');canvas.width=img.naturalWidth;canvas.height=img.naturalHeight;const ctx=canvas.getContext('2d');ctx.drawImage(img,0,0);return [...ctx.getImageData(x,y,1,1).data];};
    window.dialogFixture=()=>{document.body.innerHTML='<dialog id="guidedDetectionDialog"><h2 id="guidedDetectionTitle"></h2><p id="guidedDetectionNote"></p><div id="guidedGroupList" hidden></div><button id="closeGuidedDetection">Close</button><p id="guidedDetectionStatus"></p><p id="guidedDetectionError"></p><canvas id="guidedDetectionPreview"></canvas><label id="guidedCandidateField"><select id="guidedCandidateChoice"></select></label><button id="useMarkedArea">Use marked area</button><button id="cancelGuidedDetection">Cancel</button><button id="confirmGuidedDetection">Number this area</button></dialog>';};
  });
});
after(async()=>{try{assert.deepEqual(errors,[]);}finally{await browser?.close();if(server)await new Promise(resolve=>server.close(resolve));}});

test('clean sketch detection includes editable strokes and text, excludes selection paint and number labels',async()=>{
  const result=await page.evaluate(async()=>{
    let {project}=await fixture();project=core.addText(project,{content:'Tree',x:300,y:200,width:100,height:60,fontSize:32,color:'#000000'}).project;
    const contentText=project.layers.at(-1).id;let added=core.addDrawing(project,{mode:'highlight',color:'#ff0000',size:35,points:[[130,130],[170,170]]});project=added.project;const highlightId=added.layerId;
    added=core.addText(project,{content:'1',x:300,y:100,width:100,height:60,fontSize:40,color:'#ff0000'});project=added.project;const labelId=added.layerId,before=JSON.stringify(project),copy=await sketch.sketchWorkingCopy(project);
    return {unchanged:before===JSON.stringify(project),size:[copy.width,copy.height],line:await pixel(copy.source,150,100),marked:await pixel(copy.source,150,150),number:await pixel(copy.source,320,130),layers:sketch.sketchContentLayers(project).map(l=>l.id),contentText,highlightId,labelId};
  });
  assert.equal(result.unchanged,true);assert.deepEqual(result.size,[600,400]);assert.deepEqual(result.line,[0,0,0,255]);assert.deepEqual(result.marked,[255,255,255,255]);assert.deepEqual(result.number,[255,255,255,255]);assert.ok(result.layers.includes(result.contentText));assert.ok(!result.layers.includes(result.highlightId));assert.ok(!result.layers.includes(result.labelId));
});

test('sketch guided crop targets full drawing page even over a placed raster and retains strokes in the request',async()=>{
  const result=await page.evaluate(async()=>{
    let {project,surfaceId}=await fixture();const canvas=document.createElement('canvas');canvas.width=60;canvas.height=60;const ctx=canvas.getContext('2d');ctx.fillStyle='#0000ff';ctx.fillRect(0,0,60,60);
    let added=core.addRaster(project,{name:'Placed object',source:canvas.toDataURL('image/png'),width:60,height:60});project=core.updateLayer(added.project,added.layerId,{x:250,y:90});
    added=core.addDrawing(project,{mode:'highlight',color:'#ff0000',size:40,points:[[150,100],[280,110]]});project=added.project;
    const target=guided.guidedMarkTarget(project,added.layerId),working=await guided.guidedWorkingCopy(project,added.layerId),map=(x,y)=>[Math.floor((x-working.crop.x)*working.request.width/working.crop.width),Math.floor((y-working.crop.y)*working.request.height/working.crop.height)];
    return {surfaceId,targetId:target.raster.id,workingId:working.rasterId,line:await pixel(working.request.source,...map(150,100)),photo:await pixel(working.request.source,...map(270,110)),blank:await pixel(working.request.source,...map(220,110)),full:[working.fullWidth,working.fullHeight]};
  });
  assert.equal(result.targetId,result.surfaceId);assert.equal(result.workingId,result.surfaceId);assert.deepEqual(result.full,[600,400]);assert.deepEqual(result.line,[0,0,0,255]);assert.deepEqual(result.photo,[0,0,255,255]);assert.deepEqual(result.blank,[255,255,255,255]);
});

test('scene signature invalidates for visible content and ignores selection marks or comments',async()=>{
  const result=await page.evaluate(async()=>{
    const {project,pencilId}=await fixture(),signature=sketch.sketchContentSignature(project);
    const moved=core.updateLayer(project,pencilId,{x:120}),highlighted=core.addDrawing(project,{mode:'highlight',size:25,points:[[130,150],[170,150]]}).project,commented=structuredClone(project);commented.prompt='A different final image';commented.layers[1].referenceComment='Reference guidance';
    return {moved:signature!==sketch.sketchContentSignature(moved),highlight:signature===sketch.sketchContentSignature(highlighted),comment:signature===sketch.sketchContentSignature(commented),stable:signature===sketch.sketchContentSignature(project)};
  });
  assert.deepEqual(result,{moved:true,highlight:true,comment:true,stable:true});
});

test('sketch pencil artwork does not become a selection guide while photo pencil loops still do',async()=>{
  const result=await page.evaluate(async()=>{
    const {project,pencilId}=await fixture(),photo=structuredClone(project);delete photo.sketch;
    const highlighted=core.addDrawing(project,{mode:'highlight',size:25,points:[[130,150],[170,150]]});
    return {sketchPencil:guided.guidedMarkTarget(project,pencilId),photoPencil:Boolean(guided.guidedMarkTarget(photo,pencilId)),sketchHighlight:Boolean(guided.guidedMarkTarget(highlighted.project,highlighted.layerId))};
  });
  assert.deepEqual(result,{sketchPencil:null,photoPencil:true,sketchHighlight:true});
});

test('auto detection posts the sketch scene, excludes highlights and invalidates cached masks after a stroke edit',async()=>{
  const calls=[];await page.route('**/api/local-detection/status',route=>route.fulfill({json:{available:true,token:'sketch-test'}}));
  await page.route('**/api/local-detection',route=>{const body=route.request().postDataJSON();calls.push(body);return route.fulfill({json:{width:body.width,height:body.height,regions:[],model:'Mock local SAM',device:'test',elapsedMs:1}});});
  try{
    const result=await page.evaluate(async()=>{
      const {project,pencilId}=await fixture();window.autoProject=core.addDrawing(project,{mode:'highlight',color:'#ff0000',size:30,points:[[130,150],[170,150]]}).project;
      const auto=await import('/auto-detection.mjs'),overlay=document.createElement('canvas'),errors=[];const controller=auto.createLocalDetection({getProject:()=>window.autoProject,canHover:()=>true,overlay,onChange:()=>{},onError:m=>errors.push(m)});
      await controller.run();const ready=controller.ready;await controller.run();window.autoProject=core.updateLayer(window.autoProject,pencilId,{x:120});controller.sync();const invalidated=!controller.ready;await controller.run();controller.reset();return {ready,invalidated,errors};
    });
    assert.deepEqual(result,{ready:true,invalidated:true,errors:[]});assert.equal(calls.length,2);
    const pixels=await page.evaluate(async input=>({line:await pixel(input.source,150,100),highlight:await pixel(input.source,150,150)}),calls[0]);assert.deepEqual(pixels.line,[0,0,0,255]);assert.deepEqual(pixels.highlight,[255,255,255,255]);
  }finally{await page.unroute('**/api/local-detection/status');await page.unroute('**/api/local-detection');}
});

test('offline sketch highlights can be confirmed as one manual group with the same original reference handoff',async()=>{
  await page.route('**/api/local-detection/status',route=>route.fulfill({json:{available:false,message:'Test detector offline'}}));
  try{
    const result=await page.evaluate(async()=>{
      let {project,surfaceId}=await fixture();project=core.addDrawing(project,{mode:'highlight',color:'#ffff00',size:30,points:[[120,150],[180,150]]}).project;let added=core.addDrawing(project,{mode:'highlight',color:'#ffff00',size:30,points:[[350,150],[400,150]]});project=added.project;
      dialogFixture();const mod=await import('/guided-selection.mjs'),errors=[];let confirmed;const ctrl=mod.createGuidedSelection({getProject:()=>project,getSelected:()=>added.layerId,canRun:()=>true,onError:e=>errors.push(e),onConfirm:hit=>confirmed=hit});await ctrl.run();
      const error=document.querySelector('#guidedDetectionError').textContent;document.querySelector('#useMarkedArea').click();const manual=document.querySelector('#guidedDetectionStatus').textContent;document.querySelector('#confirmGuidedDetection').click();
      return {errors,error,manual,confirmed:confirmed?{rasterId:confirmed.raster.id,manual:confirmed.manual,group:confirmed.group,markIds:confirmed.markIds,one:regions.regionContainsPoint(confirmed.mask,150,150),two:regions.regionContainsPoint(confirmed.mask,375,150),gap:regions.regionContainsPoint(confirmed.mask,275,150)}:null,surfaceId,closed:!document.querySelector('#guidedDetectionDialog').open};
    });
    assert.deepEqual(result.errors,[]);assert.match(result.error,/offline/);assert.match(result.manual,/Manual/);assert.equal(result.confirmed.rasterId,result.surfaceId);assert.equal(result.confirmed.manual,true);assert.equal(result.confirmed.group.areaCount,2);assert.equal(result.confirmed.markIds.length,2);assert.equal(result.confirmed.one,true);assert.equal(result.confirmed.two,true);assert.equal(result.confirmed.gap,false);assert.equal(result.closed,true);
  }finally{await page.unroute('**/api/local-detection/status');}
});

test('single highlighted subjects expose their consumed mark so consecutive selections stay independent',async()=>{
  await page.route('**/api/local-detection/status',route=>route.fulfill({json:{available:false,message:'Test detector offline'}}));
  try{
    const result=await page.evaluate(async()=>{
      let {project}=await fixture(),selected;dialogFixture();const mod=await import('/guided-selection.mjs'),confirmed=[],counts=[],errors=[];
      const ctrl=mod.createGuidedSelection({getProject:()=>project,getSelected:()=>selected,canRun:()=>true,onError:error=>errors.push(error),onConfirm:hit=>{
        confirmed.push({markIds:hit.markIds,mask:hit.mask,group:hit.group||null});
        // The editor keeps the source mark editable but hides it once numbered.
        for(const markId of hit.markIds)project=core.updateLayer(project,markId,{visible:false});
      }});
      for(const points of [[[120,150],[180,150]],[[350,150],[400,150]]]){
        const added=core.addDrawing(project,{mode:'highlight',color:'#ffff00',size:30,points});project=added.project;selected=added.layerId;counts.push(ctrl.count());await ctrl.run();document.querySelector('#useMarkedArea').click();document.querySelector('#confirmGuidedDetection').click();
      }
      return {counts,errors,marks:confirmed.map(hit=>hit.markIds),groups:confirmed.map(hit=>hit.group),visibleHighlights:project.layers.filter(l=>l.kind==='drawing'&&l.drawing.mode==='highlight'&&l.visible).length,retainedHighlights:project.layers.filter(l=>l.kind==='drawing'&&l.drawing.mode==='highlight').length,secondOnly:regions.regionContainsPoint(confirmed[1].mask,375,150)&&!regions.regionContainsPoint(confirmed[1].mask,150,150)};
    });
    assert.deepEqual(result.errors,[]);assert.deepEqual(result.counts,[1,1]);assert.ok(result.marks.every(ids=>ids.length===1));assert.notEqual(result.marks[0][0],result.marks[1][0]);assert.deepEqual(result.groups,[null,null]);assert.equal(result.visibleHighlights,0);assert.equal(result.retainedHighlights,2);assert.equal(result.secondOnly,true);
  }finally{await page.unroute('**/api/local-detection/status');}
});
