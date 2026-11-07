import {test,before,after} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {chromium} from 'playwright';
import {createServer} from '../server.mjs';
import {prepareImageRequest} from '../desktop-image-request.mjs';

let server,browser,page;
const errors=[];
before(async()=>{
  const disconnected={dispose(){},status:async()=>({configured:false,authenticated:false,models:[]})};
  server=createServer({images:disconnected,sheets:disconnected,detection:{...disconnected,token:'sketch-test'}});
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  browser=await chromium.launch({headless:true});page=await browser.newPage();
  const base=`http://127.0.0.1:${server.address().port}`;
  await page.route('**/*',async route=>new URL(route.request().url()).origin===base&&route.request().method()==='GET'?route.continue():route.abort());
  page.on('pageerror',error=>errors.push(error.message));await page.goto(base+'/health');
  await page.evaluate(async()=>{
    window.core=await import('/core.mjs');window.requests=await import('/image-generation-request.mjs');window.pack=await import('/reference-pack.mjs');
    window.image=(color,name='Surface.png',width=320,height=200)=>{const c=document.createElement('canvas');c.width=width;c.height=height;const ctx=c.getContext('2d');ctx.fillStyle=color;ctx.fillRect(0,0,width,height);return{name,width,height,source:c.toDataURL('image/png')};};
    window.pixels=async(source,points)=>{const image=new Image();image.src=source;await image.decode();const c=document.createElement('canvas');c.width=image.width;c.height=image.height;const ctx=c.getContext('2d');ctx.drawImage(image,0,0);return points.map(([x,y])=>Array.from(ctx.getImageData(x,y,1,1).data));};
    window.makeSketch=()=>{
      const c=window.core;let project=c.addRaster(c.newProject(),window.image('#ffffff')).project;
      project.sketch={version:1,background:'#ffffff',surfaceLayerId:project.layers[0].id};
      project=c.addDrawing(project,{mode:'pencil',color:'#111111',size:8,points:[[20,50],[140,50]]}).project;
      project=c.addDrawing(project,{mode:'highlight',color:'#00ff00',size:20,points:[[40,50],[80,50]]}).project;
      project=c.addDrawing(project,{mode:'highlight',color:'#00ff00',size:20,points:[[190,100],[250,100]]}).project;
      project=c.addReference(project,window.image('#2244aa','Bird reference.png',32,32));
      const label=c.addText(project,{content:'1',x:270,y:120,width:40,height:50,fontSize:30,color:'#ff0000'});
      project=c.updateLabelComment(c.linkReferences(label.project,label.layerId,[project.references[0].id]),label.layerId,'Make the selected drawn subject look like the blue bird reference.');
      return project;
    };
  });
});
after(async()=>{try{assert.deepEqual(errors,[]);}finally{await browser?.close();if(server)await new Promise(resolve=>{server.close(resolve);server.closeAllConnections();});}});

test('generation renders actual pencil content and exact reference originals while separating highlight guides',async()=>{
  const result=await page.evaluate(async()=>{
    const project=window.makeSketch(),before=JSON.stringify(project),input=await window.requests.buildImageGenerationInput(project);
    return{input,unchanged:before===JSON.stringify(project),composition:await window.pixels(input.composition.source,[[100,50],[220,100],[5,5]]),guide:await window.pixels(input.guide.source,[[100,50],[220,100],[5,5]])};
  });
  assert.equal(result.unchanged,true);
  assert.deepEqual(result.composition,[[17,17,17,255],[255,255,255,255],[255,255,255,255]]);
  assert.deepEqual(result.guide[0],[17,17,17,255]);assert.ok(result.guide[1][1]>result.guide[1][0]+50,'Highlight is visibly present only in the guide.');
  const prepared=prepareImageRequest({...result.input,requestId:randomUUID(),model:'gpt-image-2.5-sunburst',quality:'max'});
  assert.equal(prepared.quality,'max');assert.equal(prepared.images.length,3);
  assert.equal(prepared.images[0].bytes.toString('base64'),result.input.composition.source.split(',')[1]);
  assert.equal(prepared.images[2].bytes.toString('base64'),result.input.project.references[0].source.split(',')[1]);
  assert.equal(prepared.inputRoles[0].role,'drawn scene composition');assert.match(prepared.prompt,/blue bird reference/);
});

test('sketch pack includes a clean composition and editable master instead of describing blank paper as MAIN',async()=>{
  const result=await page.evaluate(async()=>{
    const project=window.makeSketch(),before=JSON.stringify(project),{files,mapping}=await window.pack.completeReferencePackFiles(project);
    const original=files.find(file=>file.name===mapping.cleanMain.path),sketch=files.find(file=>file.name===mapping.sketch.composition.path);
    const dataURL=blob=>new Promise(resolve=>{const reader=new FileReader();reader.onload=()=>resolve(reader.result);reader.readAsDataURL(blob);});
    const restored=window.core.parseProject(await files.find(file=>file.name===mapping.sketch.editableProject).blob.text());
    return{mapping,names:files.map(file=>file.name),masterEqual:JSON.stringify(restored)===before,unchanged:JSON.stringify(project)===before,
      cleanOriginal:await dataURL(original.blob),originalSource:project.assets[project.original.assetId].source,
      pixels:await window.pixels(await dataURL(sketch.blob),[[100,50],[220,100],[5,5]]),readme:await files.find(file=>file.name==='README.txt').blob.text()};
  });
  assert.equal(result.unchanged,true);assert.equal(result.masterEqual,true,'All source strokes and reference bindings survive editable project export.');
  assert.equal(result.cleanOriginal,result.originalSource,'Original surface bytes remain byte-exact.');
  assert.deepEqual(result.pixels,[[17,17,17,255],[255,255,255,255],[255,255,255,255]]);
  assert.ok(result.names.includes('generated-previews/sketch-composition.png'));assert.ok(result.names.includes('editable-sketch.asun'));
  assert.match(result.readme,/NOT the scene composition/);assert.match(result.readme,/white surface is drawing paper, not a required final white background/);
  assert.equal(result.mapping.sketch.composition.width,320);assert.equal(result.mapping.sketch.composition.height,200);
  assert.equal(result.mapping.sketch.composition.role,'drawn scene composition');
  assert.ok(result.names.includes('START-HERE.txt'));
  assert.equal(result.mapping.agentWorkflow.source.selection,'sketch-composition');
  assert.equal(result.mapping.agentWorkflow.source.image.path,result.mapping.sketch.composition.path);
  assert.equal(result.mapping.agentWorkflow.source.image.sha256,result.mapping.sketch.composition.sha256);
  assert.notEqual(result.mapping.agentWorkflow.source.image.path,result.mapping.cleanMain.path);
  assert.equal(result.mapping.agentWorkflow.reviewStatus,'not-run');
});

test('disconnected selected sketch subjects preserve separate white mask components and their shared reference mapping',async()=>{
  const result=await page.evaluate(async()=>{
    let project=window.makeSketch();const label=project.layers.find(layer=>layer.kind==='text'),surface=project.layers.find(layer=>layer.id===project.sketch.surfaceLayerId);
    project=window.core.attachObjectRegion(project,label.id,{version:1,assetId:surface.assetId,rasterLayerId:surface.id,sourceWidth:320,sourceHeight:200,mask:{width:8,height:5,counts:[9,1,4,1,25]},group:{areaCount:2}});
    const input=await window.requests.buildImageGenerationInput(project);
    return{input,pixels:await window.pixels(input.areaMasks[0].image.source,[[60,60],[260,60],[160,60],[5,5]])};
  });
  assert.deepEqual(result.pixels,[[255,255,255,255],[255,255,255,255],[0,0,0,255],[0,0,0,255]]);
  const prepared=prepareImageRequest({...result.input,requestId:randomUUID(),model:'gpt-image-2.5-sunburst'});
  assert.equal(prepared.images.length,4);
  assert.equal(prepared.inputRoles.at(-1).groupAreaCount,2);
  assert.equal(prepared.inputRoles.at(-1).role,'area selection mask');
  assert.match(prepared.prompt,/every white component, not the gaps/);
  assert.match(prepared.prompt,/"groupAreaCount": 2/);
});

test('edit summary shows clean drawn subject thumbnails and refreshes them after a pencil edit',async()=>{
  const result=await page.evaluate(async()=>{
    const {createEditSummary}=await import('/edit-summary.mjs');
    let project=window.makeSketch();const label=project.layers.find(layer=>layer.kind==='text'),surface=project.layers.find(layer=>layer.id===project.sketch.surfaceLayerId),pencil=project.layers.find(layer=>layer.drawing?.mode==='pencil');
    project=window.core.attachObjectRegion(project,label.id,{version:1,assetId:surface.assetId,rasterLayerId:surface.id,sourceWidth:320,sourceHeight:200,mask:{width:8,height:5,counts:[8,4,28]}});
    const panel=document.createElement('aside');panel.innerHTML='<div id="editSummaryCount"></div><div id="editSummaryPrompt"></div><div id="editSummaryContent"><div id="editSummaryList"></div></div>';document.body.append(panel);
    const summary=createEditSummary(panel),stats=async()=>{
      let image;for(let i=0;i<100;i++){image=panel.querySelector('.edit-summary-source-preview img');if(image?.src&&image.complete)break;await new Promise(resolve=>setTimeout(resolve,10));}
      if(!image?.src)throw new Error('Sketch summary preview did not appear.');await image.decode();
      const c=document.createElement('canvas');c.width=image.naturalWidth;c.height=image.naturalHeight;const ctx=c.getContext('2d');ctx.drawImage(image,0,0);const pixels=ctx.getImageData(0,0,c.width,c.height).data;let dark=0,green=0;
      for(let i=0;i<pixels.length;i+=4){if(pixels[i]<80&&pixels[i+1]<80&&pixels[i+2]<80)dark++;if(pixels[i+1]>pixels[i]+30&&pixels[i+1]>pixels[i+2]+30)green++;}
      return{width:c.width,height:c.height,dark,green,source:image.src,title:image.title};
    };
    summary.update(project,label.id);const first=await stats();
    project=window.core.updateLayer(project,pencil.id,{visible:false});summary.update(project,label.id);const second=await stats();
    summary.dispose();panel.remove();return{first,second};
  });
  assert.ok(result.first.dark>50,'The selected sketch subject is visible instead of blank surface.');
  assert.equal(result.first.green,0,'Selection highlighting is not baked into the subject thumbnail.');
  assert.ok(result.first.width<=160&&result.first.height<=112,'Only thumbnail-sized pixels are retained.');
  assert.match(result.first.title,/editable drawing retained/);
  assert.equal(result.second.dark,0,'The preview updates when the editable pencil content changes.');
  assert.notEqual(result.first.source,result.second.source);
});
