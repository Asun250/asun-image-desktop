import {test,before,after} from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {chromium} from 'playwright';
import {createServer} from '../server.mjs';

let server,browser,context,page,base;
const errors=[],remoteRequests=[];
before(async()=>{
  server=createServer({detection:{status:async()=>({available:false}),dispose(){}},sheets:{dispose(){}},images:{dispose(){}}});
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  base=`http://127.0.0.1:${server.address().port}`;
  browser=await chromium.launch({headless:true});context=await browser.newContext();page=await context.newPage();
  page.on('pageerror',error=>errors.push(error.message));
  await context.route('**/*',route=>{
    const url=new URL(route.request().url());
    if(url.origin!==base){remoteRequests.push(url.href);return route.abort();}
    if(url.pathname.startsWith('/api/'))return route.abort();
    return route.continue();
  });
  await page.goto(base+'/health');
  await page.evaluate(async()=>{
    const core=await import('/core.mjs'),pack=await import('/reference-pack.mjs'),scene=await import('/scene-consistency.mjs');
    const {readOriginalImage}=await import('/image-source.mjs');
    window.qa={core,pack,scene};
    window.qa.image=async(name,color,width=160,height=90)=>{
      const canvas=document.createElement('canvas');canvas.width=width;canvas.height=height;
      const ctx=canvas.getContext('2d');ctx.fillStyle=color;ctx.fillRect(0,0,width,height);
      const data=canvas.toDataURL('image/png'),bytes=Uint8Array.from(atob(data.split(',')[1]),char=>char.charCodeAt(0));
      return readOriginalImage(new File([bytes],name,{type:'image/png'}));
    };
    window.qa.mask=rectangles=>{
      const width=16,height=9,values=Array.from({length:width*height},(_,i)=>rectangles.some(([x,y,w,h])=>i%width>=x&&i%width<x+w&&Math.floor(i/width)>=y&&Math.floor(i/width)<y+h)?1:0);
      const counts=[];let current=0,count=0;
      for(const value of values){if(value===current)count++;else{counts.push(count);count=1;current=value;}}counts.push(count);
      return {width,height,counts};
    };
    window.qa.fixture=async()=>{
      const first=await window.qa.image('First import.png','#334455');
      let project=core.addRaster(core.newProject(),first).project;
      const main=await window.qa.image('Original Blender MAIN.png','#00ff00');
      const added=core.addRaster(project,main);project=added.project;const raster=project.layers.find(layer=>layer.id===added.layerId);
      project=core.addReference(project,await window.qa.image('Car material.png','#aabbcc'));
      const appearanceId=project.references.at(-1).id;
      project=core.addReference(project,await window.qa.image('Approved frame 1.png','#555566'));
      const continuityId=project.references.at(-1).id;
      for(const [label,rectangles,group] of [['1',[[4,2,4,3]],null],['2',[[10,4,2,2],[13,6,2,2]],{areaCount:2}]]){
        const text=core.addText(project,{content:label,x:2,y:2,width:15,height:15,fontSize:10,color:'#ff0000'});project=text.project;
        project=core.linkReference(project,text.layerId,appearanceId);
        project=core.attachObjectRegion(project,text.layerId,{version:1,assetId:raster.assetId,rasterLayerId:raster.id,sourceWidth:160,sourceHeight:90,mask:window.qa.mask(rectangles),...(group?{group}:{})});
      }
      project=core.addDrawing(project,{mode:'pencil',color:'#ff0000',size:3,points:[[20,20],[40,20],[35,15]]}).project;
      const settings=scene.getSceneConsistency(project);settings.enabled=true;settings.mainAssetId=raster.assetId;
      settings.groups=[{label:'1',...scene.groupPreset('card'),expectedObjectCount:5},{label:'2',...scene.groupPreset('car'),expectedObjectCount:10}];
      settings.continuity={shot:'Paris',frame:'20',camera:'Camera',previousFrame:'1',referenceIds:[continuityId],changes:'Camera raised; maintain individual cars.'};
      project.sceneConsistency=settings;
      return {project,main,first,appearanceId,continuityId,rasterId:raster.id};
    };
    window.qa.fileRecord=async file=>{
      const bytes=new Uint8Array(await file.blob.arrayBuffer());let binary='';for(const value of bytes)binary+=String.fromCharCode(value);
      return {name:file.name,base64:btoa(binary),type:file.blob.type};
    };
    window.qa.pixels=async(blob,points)=>{
      const bitmap=await createImageBitmap(blob),canvas=document.createElement('canvas');canvas.width=bitmap.width;canvas.height=bitmap.height;
      const ctx=canvas.getContext('2d');ctx.drawImage(bitmap,0,0);bitmap.close();
      return {width:canvas.width,height:canvas.height,pixels:points.map(([x,y])=>[...ctx.getImageData(x,y,1,1).data])};
    };
  });
});
after(async()=>{try{assert.deepEqual(errors,[]);assert.deepEqual(remoteRequests,[]);}finally{await browser?.close();await new Promise(resolve=>server.close(resolve));}});
const bytes=record=>Buffer.from(record.base64,'base64');
const sha=record=>createHash('sha256').update(bytes(record)).digest('hex');

test('scene-only area rules export a guide and masks without legacy comments or linked photos',async()=>{
  const result=await page.evaluate(async()=>{
    const f=await window.qa.fixture();f.project.prompt='';
    for(const layer of f.project.layers){delete layer.referenceIds;delete layer.referenceComment;}
    const output=await window.qa.pack.completeReferencePackFiles(f.project);
    return {mapping:output.mapping,names:output.files.map(file=>file.name)};
  });
  assert.equal(result.mapping.numbers.length,2);assert.equal(result.mapping.selectionMasks.length,2);
  assert.ok(result.names.includes('generated-previews/canvas-annotation-guide.png'));
  assert.ok(result.names.includes('SCENE-CONSISTENCY.txt'));
});

test('scene pack binds selected MAIN, context references and object rules while preserving original bytes',async()=>{
  const result=await page.evaluate(async()=>{
    const f=await window.qa.fixture(),before=JSON.stringify(f.project),output=await window.qa.pack.completeReferencePackFiles(f.project);
    const masks=await Promise.all(output.mapping.selectionMasks.map(async record=>({record,samples:await window.qa.pixels(output.files.find(file=>file.name===record.path).blob,record.label==='1'?[[50,30],[5,5],[90,30]]:[[105,45],[135,65],[125,45]])})));
    return {mapping:output.mapping,files:await Promise.all(output.files.map(window.qa.fileRecord)),masks,unchanged:before===JSON.stringify(f.project),main:f.main.source,first:f.first.source,mainId:f.project.sceneConsistency.mainAssetId,continuityId:f.continuityId};
  });
  const {mapping}=result,files=new Map(result.files.map(file=>[file.name,file]));
  assert.equal(result.unchanged,true);
  assert.equal(mapping.agentWorkflow.source.selection,'user-selected-original');
  assert.equal(mapping.agentWorkflow.source.image.assetId,result.mainId);
  assert.notEqual(mapping.cleanMain.assetId,result.mainId);
  assert.equal(mapping.agentWorkflow.reviewStatus,'not-run');
  assert.equal(mapping.sceneConsistency.enabled,true);
  assert.deepEqual(mapping.sceneConsistency.groups.map(group=>group.expectedObjectCount),[5,10]);
  assert.equal(mapping.numbers[0].selections[0].group,undefined,'Ungrouped masks are preserved as selections.');
  assert.equal(mapping.numbers[1].selections[0].group.areaCount,2);
  assert.equal(mapping.selectionMasks.length,2,'One PNG per selected numbered layer, not one per physical object.');
  assert.equal(mapping.continuityReferences.length,1);assert.equal(mapping.continuityReferences[0].referenceId,result.continuityId);
  assert.ok(files.has(mapping.continuityReferences[0].path));
  const chosen=mapping.mainImages.find(item=>item.assetId===result.mainId);
  assert.deepEqual(bytes(files.get(chosen.path)),Buffer.from(result.main.split(',')[1],'base64'));
  assert.deepEqual(bytes(files.get(mapping.cleanMain.path)),Buffer.from(result.first.split(',')[1],'base64'));
  for(const original of [...mapping.mainImages,...mapping.numbers.flatMap(number=>number.references),...mapping.unassignedReferences])assert.equal(sha(files.get(original.path)),original.sha256);
  const instructions=bytes(files.get('START-HERE.txt')).toString();
  assert.match(instructions,/SAVED SCENE CONSISTENCY REQUIREMENTS/);assert.match(instructions,/individual rank, suit/);assert.match(instructions,/selection-mask regions is never the physical object count/);
  assert.match(bytes(files.get('SCENE-CONSISTENCY.txt')).toString(),/mask does not guarantee/);
  assert.ok(mapping.sceneConsistencyPreflight.warnings.some(message=>message.includes('10 physical objects')));
  for(const mask of result.masks){assert.equal(mask.record.sha256,sha(files.get(mask.record.path)));assert.deepEqual([mask.samples.width,mask.samples.height],[160,90]);assert.deepEqual([mask.record.canvasWidth,mask.record.canvasHeight],[160,90]);}
  assert.deepEqual(result.masks[0].samples.pixels,[[255,255,255,255],[0,0,0,255],[0,0,0,255]]);
  assert.deepEqual(result.masks[1].samples.pixels,[[255,255,255,255],[255,255,255,255],[0,0,0,255]]);
});

test('selection PNG follows current raster transform and keeps a full-canvas coordinate frame',async()=>{
  const result=await page.evaluate(async()=>{
    const f=await window.qa.fixture();f.project=window.qa.core.updateLayer(f.project,f.rasterId,{x:20,y:10,width:80,height:45});
    const output=await window.qa.pack.completeReferencePackFiles(f.project),mask=output.mapping.selectionMasks.find(item=>item.label==='1');
    return {mask,samples:await window.qa.pixels(output.files.find(file=>file.name===mask.path).blob,[[45,25],[70,30],[5,5]])};
  });
  assert.deepEqual([result.samples.width,result.samples.height],[160,90]);
  assert.deepEqual(result.samples.pixels,[[255,255,255,255],[0,0,0,255],[0,0,0,255]]);
});

test('disabled scene rules keep ordinary packs and missing continuity sources fail before export',async()=>{
  const result=await page.evaluate(async()=>{
    const f=await window.qa.fixture();f.project.sceneConsistency.enabled=false;
    const output=await window.qa.pack.completeReferencePackFiles(f.project);
    f.project.sceneConsistency.enabled=true;f.project.sceneConsistency.continuity.referenceIds=['missing'];
    const before=JSON.stringify(f.project);let error='';try{await window.qa.pack.completeReferencePackFiles(f.project);}catch(cause){error=cause.message;}
    return {mapping:output.mapping,names:output.files.map(file=>file.name),error,unchanged:before===JSON.stringify(f.project)};
  });
  assert.equal(result.mapping.sceneConsistency.enabled,false);assert.equal(result.mapping.selectionMasks,undefined);
  assert.equal(result.mapping.sceneConsistencyInstructions,undefined);assert.equal(result.mapping.agentWorkflow.source.selection,'identify-original-main');
  assert.ok(!result.names.includes('SCENE-CONSISTENCY.txt'));assert.ok(!result.names.some(name=>name.startsWith('selection-masks/')));
  assert.match(result.error,/Continuity reference.*missing/);assert.equal(result.unchanged,true);
});
