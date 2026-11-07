import {test,before,after} from 'node:test';
import assert from 'node:assert/strict';
import {chromium} from 'playwright';
import {createServer} from '../server.mjs';

let server,browser,page,errors=[];
before(async()=>{
  server=createServer();await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));browser=await chromium.launch({headless:true});page=await browser.newPage();page.on('pageerror',error=>errors.push(error.message));
  const base=`http://127.0.0.1:${server.address().port}`;page.on('request',request=>{if(!request.url().startsWith(base)&&!request.url().startsWith('data:')&&!request.url().startsWith('blob:'))errors.push('Remote request: '+request.url());});await page.goto(base+'/health');
  await page.evaluate(async()=>{
    window.core=await import('/core.mjs');window.guided=await import('/guided-detection.mjs');window.regions=await import('/object-regions.mjs');window.sources=await import('/image-source.mjs');
    window.fixture=async(name,color='#008000',width=1000,height=800,type='image/png')=>{const canvas=document.createElement('canvas');canvas.width=width;canvas.height=height;const context=canvas.getContext('2d');context.fillStyle=color;context.fillRect(0,0,width,height);const source=canvas.toDataURL(type,.9),bytes=Uint8Array.from(atob(source.split(',')[1]),character=>character.charCodeAt(0));return window.sources.readOriginalImage(new File([bytes],name,{type}));};
    window.pixel=async(source,x,y)=>{const bytes=Uint8Array.from(atob(source.split(',')[1]),character=>character.charCodeAt(0)),bitmap=await createImageBitmap(new Blob([bytes],{type:source.slice(5,source.indexOf(';'))})),canvas=document.createElement('canvas');canvas.width=bitmap.width;canvas.height=bitmap.height;const context=canvas.getContext('2d');context.drawImage(bitmap,0,0);const result=[...context.getImageData(x,y,1,1).data];bitmap.close();return result;};
  });
});
after(async()=>{try{assert.deepEqual(errors,[]);}finally{await browser?.close();if(server)await new Promise(resolve=>server.close(resolve));}});

test('guided crop uses byte-preserved clean original and excludes pencil, highlights, text, filters and app masks',async()=>{
  const result=await page.evaluate(async()=>{
    const c=window.core,g=window.guided,original=await window.fixture('Source.webp','#008000',1000,800,'image/webp');let added=c.addRaster(c.newProject(),original),project=added.project,rasterId=added.layerId;
    project=c.updateLayer(project,rasterId,{brightness:20,contrast:160,saturation:10});project=c.addMaskStroke(project,rasterId,{mode:'hide',size:40,points:[[400,340]]});
    project=c.addText(project,{content:'APP ADDED TEXT',x:300,y:200,width:400,height:60,fontSize:32,color:'#ff00ff'}).project;
    project=c.addDrawing(project,{mode:'pencil',color:'#ff0000',size:40,points:[[300,300],[500,300]]}).project;
    added=c.addDrawing(project,{mode:'highlight',color:'#ffff00',size:40,points:[[340,280],[430,290]]});project=added.project;
    const before=JSON.stringify(project),working=await g.guidedWorkingCopy(project,added.layerId),preview=await window.pixel(working.request.source,Math.floor(working.request.width/2),Math.floor(working.request.height/2));
    return {unchanged:before===JSON.stringify(project),original:original.source,savedSource:project.assets[working.assetId].source,nativeSize:[project.assets[working.assetId].width,project.assets[working.assetId].height],pixel:preview,originalPixel:await window.pixel(original.source,400,280),working:{...working,source:undefined,request:{...working.request,source:undefined}},snapshots:{mark:project.layers.at(-1),raster:project.layers[0]}};
  });
  assert.equal(result.unchanged,true);assert.equal(result.savedSource,result.original);assert.deepEqual(result.nativeSize,[1000,800]);assert.deepEqual(result.pixel,result.originalPixel);
  assert.deepEqual(result.working.markSnapshot,result.snapshots.mark);assert.deepEqual(result.working.rasterSnapshot,result.snapshots.raster);
  assert.ok(result.working.request.width<=1600&&result.working.request.height<=1600);assert.match(result.original,/^data:image\/webp;/);
  assert.equal(Object.hasOwn(result.working.request.prompt,'points'),false,'Pencil outlines are a box prompt, never mislabeled foreground points');
  assert.ok(result.working.request.prompt.box[2]>result.working.request.prompt.box[0]);
});

test('an offset second source supplies the crop and box coordinates after drawing resize',async()=>{
  const result=await page.evaluate(async()=>{
    const c=window.core,g=window.guided,main=await window.fixture('MAIN.png','#008000'),second=await window.fixture('SECOND.png','#0000ff',400,300);let project=c.addRaster(c.newProject(),main).project,added=c.addRaster(project,second);project=c.updateLayer(added.project,added.layerId,{x:250,y:100,width:200,height:150});const rasterId=added.layerId;
    added=c.addDrawing(project,{mode:'highlight',color:'#ffff00',size:10,points:[[275,120],[285,125]]});project=added.project;const mark=project.layers.at(-1);project=c.updateLayer(project,mark.id,{x:275,y:120,width:mark.width*2,height:mark.height*2});
    const target=g.guidedMarkTarget(project,mark.id),working=await g.guidedWorkingCopy(project,mark.id);return {rasterId,working:{...working,source:undefined,request:{...working.request,source:undefined}},sourceBox:target.sourceBox,pixel:await window.pixel(working.request.source,0,0),secondSource:second.source,savedSource:project.assets[working.assetId].source};
  });
  assert.equal(result.working.rasterId,result.rasterId);assert.deepEqual(result.pixel,[0,0,255,255]);assert.equal(result.savedSource,result.secondSource);
  const {crop,request}=result.working;for(let index=0;index<4;index++){const expected=(result.sourceBox[index]-(index%2?crop.y:crop.x))*(index%2?request.height/crop.height:request.width/crop.width);assert.ok(Math.abs(expected-request.prompt.box[index])<1e-8);}
});

test('manual fallback fills closed pencil loops while open pencil and highlight keep editable stroke shapes',async()=>{
  const result=await page.evaluate(async()=>{
    const c=window.core,g=window.guided,r=window.regions,original=await window.fixture('Original.png');let project=c.addRaster(c.newProject(),original).project;
    const scenarios=[['closed pencil','pencil',[[300,200],[420,200],[420,300],[300,300],[304,204]]],['open pencil','pencil',[[300,200],[420,200],[420,300]]],['closed highlight','highlight',[[300,200],[420,200],[420,300],[300,300],[300,200]]]];
    const results=[];
    for(const [name,mode,points]of scenarios){const added=c.addDrawing(project,{mode,color:'#ffff00',size:8,points}),before=JSON.stringify(added.project),working=await g.guidedWorkingCopy(added.project,added.layerId),manual=g.manualGuidedResult(working),mapped=g.mapGuidedResult(manual,working),mask=mapped.regions[0].mask;results.push({name,model:manual.model,center:r.regionContainsPoint(mask,350,250),boundary:r.regionContainsPoint(mask,350,200),outside:r.regionContainsPoint(mask,250,250),unchanged:before===JSON.stringify(added.project),source:added.project.assets[working.assetId].source,count:manual.regions.length});}
    return {results,original:original.source};
  });
  assert.deepEqual(result.results.map(item=>item.center),[true,false,false]);
  for(const item of result.results){assert.equal(item.boundary,true);assert.equal(item.outside,false);assert.equal(item.unchanged,true);assert.equal(item.count,1);assert.equal(item.model,'Manual marked area');assert.equal(item.source,result.original);}
});

test('manual single-point highlight and transformed brush map to native clipped source coordinates',async()=>{
  const result=await page.evaluate(async()=>{
    const c=window.core,g=window.guided,r=window.regions;let added=c.addRaster(c.newProject(),await window.fixture('Source.png','#008000',800,600)),project=c.updateLayer(added.project,added.layerId,{x:-100,y:-50,width:400,height:300});
    added=c.addDrawing(project,{mode:'highlight',color:'#ffff00',size:10,points:[[5,5]]});project=added.project;const mark=project.layers.at(-1);project=c.updateLayer(project,mark.id,{width:mark.width*2,height:mark.height*3});
    const working=await g.guidedWorkingCopy(project,mark.id),mapped=g.mapGuidedResult(g.manualGuidedResult(working),working),mask=mapped.regions[0].mask;return {bbox:mapped.regions[0].bbox,inside:r.regionContainsPoint(mask,230,140),outside:r.regionContainsPoint(mask,280,140),size:[mask.width,mask.height],sourceBox:g.guidedMarkTarget(project,mark.id).sourceBox};
  });
  assert.deepEqual(result.size,[800,600]);assert.equal(result.inside,true);assert.equal(result.outside,false);assert.ok(result.bbox[2]>=39&&result.bbox[2]<=43);assert.ok(result.bbox[3]>=59&&result.bbox[3]<=63);assert.ok(result.sourceBox.every(Number.isFinite));
});

test('large source crop and manual selection remain bounded while reopening retains original native bytes and dimensions',async()=>{
  const result=await page.evaluate(async()=>{
    const c=window.core,g=window.guided,r=window.regions,original=await window.fixture('Native JPEG.jpg','#008000',5000,3200,'image/jpeg');let added=c.addRaster(c.newProject(),original),project=added.project;
    added=c.addDrawing(project,{mode:'pencil',color:'#ff0000',size:12,points:[[1000,500],[4000,500],[4000,2600],[1000,2600],[1000,500]]});project=added.project;const before=JSON.stringify(project),working=await g.guidedWorkingCopy(project,added.layerId),manual=g.manualGuidedResult(working),mapped=g.mapGuidedResult(manual,working),label=c.addText(project,{content:'1',x:1000,y:500,width:40,height:60});
    project=c.attachObjectRegion(label.project,label.layerId,{version:1,assetId:working.assetId,rasterLayerId:working.rasterId,sourceWidth:working.fullWidth,sourceHeight:working.fullHeight,mask:mapped.regions[0].mask});project=c.parseProject(c.serializeProject(project));const stored=project.assets[working.assetId];return {unchanged:before===JSON.stringify(added.project),original:original.source,storedSource:stored.source,storedSize:[stored.width,stored.height],workingSize:[working.request.width,working.request.height],maskSize:[mapped.width,mapped.height],inside:r.regionContainsPoint(mapped.regions[0].mask,800,512),outside:r.regionContainsPoint(mapped.regions[0].mask,20,20),pixel:await window.pixel(working.request.source,800,500),originalPixel:await window.pixel(original.source,2500,1563),sourceBox:working.request.prompt.box,originalFile:stored.originalFile};
  });
  assert.equal(result.unchanged,true);assert.equal(result.storedSource,result.original);assert.deepEqual(result.storedSize,[5000,3200]);assert.deepEqual(result.workingSize,[1600,1024]);assert.deepEqual(result.maskSize,[1600,1024]);assert.equal(result.inside,true);assert.equal(result.outside,false);assert.deepEqual(result.pixel,result.originalPixel);assert.equal(result.originalFile.mimeType,'image/jpeg');assert.equal(Buffer.from(result.storedSource.split(',')[1],'base64').length,result.originalFile.byteLength);
});

test('manual fallback rejects unavailable marks and hidden or off-image geometry without changing originals',async()=>{
  const result=await page.evaluate(async()=>{
    const c=window.core,g=window.guided;let project=c.addRaster(c.newProject(),await window.fixture('Source.png')).project,added=c.addDrawing(project,{mode:'pencil',size:5,points:[[200,200],[300,300]]});project=added.project;
    const failures=[];for(const changed of [c.updateLayer(project,added.layerId,{visible:false}),c.updateLayer(project,added.layerId,{x:2000,y:2000})]){const before=JSON.stringify(changed);try{await g.guidedWorkingCopy(changed,added.layerId);failures.push(null);}catch(error){failures.push({message:error.message,unchanged:before===JSON.stringify(changed)});}}
    const working=await g.guidedWorkingCopy(project,added.layerId);working.markSnapshot=null;try{g.manualGuidedResult(working);failures.push(null);}catch(error){failures.push({message:error.message,unchanged:true});}return failures;
  });
  assert.ok(result.every(item=>item?.unchanged));assert.match(result[0].message,/visible Pencil or Highlight/);assert.match(result[1].message,/visible Pencil or Highlight/);assert.match(result[2].message,/original mark/);
});

test('request snapshots capture geometry before decoding yields so in-flight edits cannot validate an old crop',async()=>{
  const result=await page.evaluate(async()=>{
    const c=window.core,g=window.guided;let added=c.addRaster(c.newProject(),await window.fixture('Source.png')),project=added.project;
    added=c.addDrawing(project,{mode:'highlight',size:8,points:[[200,200],[260,210]]});project=added.project;
    const mark=project.layers.at(-1),raster=project.layers[0],originalMark=structuredClone(mark),originalRaster=structuredClone(raster),pending=g.guidedWorkingCopy(project,mark.id);
    mark.x+=40;raster.y+=20;const working=await pending;
    return {oldMark:working.markSnapshot,oldRaster:working.rasterSnapshot,originalMark,originalRaster,currentMark:mark,currentRaster:raster};
  });
  assert.deepEqual(result.oldMark,result.originalMark);assert.deepEqual(result.oldRaster,result.originalRaster);assert.notDeepEqual(result.oldMark,result.currentMark);assert.notDeepEqual(result.oldRaster,result.currentRaster);
});

test('controller preview and confirmation use the same canonical full-source thin mask and collapse duplicate ROI candidates',async()=>{
  const setup=await page.evaluate(async()=>{
    const c=window.core,g=window.guided,source=await window.fixture('Controller native.png','#008000',5000,3200);let added=c.addRaster(c.newProject(),source),project=added.project;
    added=c.addDrawing(project,{mode:'highlight',color:'#ffff00',size:4,points:[[2000,1500],[2080,1510]]});project=added.project;const working=await g.guidedWorkingCopy(project,added.layerId),{width,height}=working.request,y=Math.floor(height/2);
    const candidate=x=>({id:'pixel-'+x,mask:{width,height,counts:[y*width+x,1,width*height-y*width-x-1]}});
    let first,second;
    for(let x=Math.floor(width/3);x<width/3+25;x++){const a=candidate(x),b=candidate(x+1),map=value=>g.mapGuidedResult({width,height,regions:[value]},working).regions[0].mask.counts.join(',');if(map(a)===map(b)){first=a;second=b;break;}}
    if(!first)throw new Error('The high-resolution fixture needs two ROI pixels mapping to one normalized cell.');
    const raw={width,height,regions:[first,second,candidate(Number(first.id.split('-')[1])+30)],model:'Thin ROI fixture',device:'test',elapsedMs:1},mapped=g.mapGuidedResult(raw,working);
    document.body.innerHTML='<dialog id="guidedDetectionDialog"><h2 id="guidedDetectionTitle"></h2><p id="guidedDetectionNote"></p><div id="guidedGroupList" hidden></div><button id="closeGuidedDetection">Close</button><p id="guidedDetectionStatus"></p><p id="guidedDetectionError"></p><canvas id="guidedDetectionPreview"></canvas><label id="guidedCandidateField"><select id="guidedCandidateChoice"></select></label><button id="useMarkedArea">Use marked area</button><button id="cancelGuidedDetection">Cancel</button><button id="confirmGuidedDetection">Number this area</button></dialog>';
    const selection=await import('/guided-selection.mjs');window.controllerProject=project;window.controllerWorking=working;window.controllerExpected=mapped;window.controllerRaw=raw;window.controllerErrors=[];
    window.controller=selection.createGuidedSelection({getProject:()=>window.controllerProject,getSelected:()=>added.layerId,canRun:()=>true,onError:message=>window.controllerErrors.push(message),onConfirm:hit=>{window.controllerConfirmed=hit;}});
    return raw;
  });
  await page.route('**/api/local-detection/status',route=>route.fulfill({json:{available:true,token:'browser-proof',busy:false}}));
  await page.route('**/api/local-detection',route=>route.fulfill({json:setup}));
  try {
    await page.evaluate(()=>window.controller.run());
    const preview=await page.evaluate(async()=>{
      const canvas=document.querySelector('#guidedDetectionPreview'),actual=canvas.getContext('2d').getImageData(0,0,canvas.width,canvas.height).data,working=window.controllerWorking;
      const image=await (await import('/render.mjs')).decodeImage(working.request.source),regions=window.regions;
      const expected=document.createElement('canvas');expected.width=canvas.width;expected.height=canvas.height;const context=expected.getContext('2d');context.drawImage(image,0,0);
      const sx=canvas.width/working.crop.width,sy=canvas.height/working.crop.height;
      regions.drawRegionOverlay(context,window.controllerExpected.regions[0].mask,{x:-working.crop.x*sx,y:-working.crop.y*sy,width:working.fullWidth*sx,height:working.fullHeight*sy},{color:'#ff0000',fillOpacity:.19,lineWidth:2});
      const canonical=context.getImageData(0,0,canvas.width,canvas.height).data;let mismatch=0;for(let i=0;i<actual.length;i++)if(actual[i]!==canonical[i])mismatch++;
      const rawPreview=document.createElement('canvas');rawPreview.width=canvas.width;rawPreview.height=canvas.height;const rawContext=rawPreview.getContext('2d');rawContext.drawImage(image,0,0);regions.drawRegionOverlay(rawContext,window.controllerRaw.regions[0].mask,{x:0,y:0,width:canvas.width,height:canvas.height},{color:'#ff0000',fillOpacity:.19,lineWidth:2});
      const roi=rawContext.getImageData(0,0,canvas.width,canvas.height).data;let differsFromRaw=0;for(let i=0;i<actual.length;i++)if(actual[i]!==roi[i])differsFromRaw++;
      const previewId=canvas.dataset.candidateId;document.querySelector('#confirmGuidedDetection').click();
      return {options:document.querySelector('#guidedCandidateChoice').options.length,mismatch,differsFromRaw,previewId,expected:window.controllerExpected.regions[0].mask,confirmed:window.controllerConfirmed?.mask,rasterId:window.controllerConfirmed?.raster.id,expectedRasterId:working.rasterId,errors:window.controllerErrors};
    });
    assert.equal(preview.options,2,'Different raw ROI pixels collapsing to one canonical mask give one choice');assert.equal(preview.mismatch,0,'Every preview pixel renders the canonical full-raster mask');assert.ok(preview.differsFromRaw>0,'The thin ROI fixture exposes the previous raw-mask preview discrepancy');assert.deepEqual(preview.confirmed,preview.expected,'Confirmation saves the exact geometry rendered in the preview');assert.equal(preview.rasterId,preview.expectedRasterId);assert.match(preview.previewId,/^guided-/);assert.deepEqual(preview.errors,[]);
  } finally {
    await page.unroute('**/api/local-detection/status');await page.unroute('**/api/local-detection');
  }
});
