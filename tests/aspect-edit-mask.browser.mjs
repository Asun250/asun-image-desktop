import {test,before,after} from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {readFile,mkdir,writeFile} from 'node:fs/promises';
import path from 'node:path';
import {chromium} from 'playwright';

let server,browser,page,base;
const errors=[],report=[],blocked=[],qa=path.resolve('qa/aspect-edit-mask');
before(async()=>{
  const publicRoot=path.resolve('public');
  server=createServer(async(request,response)=>{
    try {
      if(request.method!=='GET'){response.writeHead(405);response.end();return;}
      const pathname=new URL(request.url,'http://127.0.0.1').pathname;
      if(pathname==='/'){response.setHeader('Content-Type','text/html');response.end('<!doctype html><title>Exact edit mask QA</title>');return;}
      const filename=path.resolve(publicRoot,'.'+pathname);
      if(!filename.startsWith(publicRoot+path.sep)||!filename.endsWith('.mjs')){response.writeHead(404);response.end();return;}
      response.setHeader('Content-Type','text/javascript');response.end(await readFile(filename));
    } catch {response.writeHead(404);response.end();}
  });
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));base=`http://127.0.0.1:${server.address().port}`;
  browser=await chromium.launch({headless:true});page=await browser.newPage();page.on('pageerror',error=>errors.push(error.message));
  await page.route('**/*',route=>{const request=route.request(),url=new URL(request.url());if(url.origin===base&&request.method()==='GET'&&!url.pathname.startsWith('/api/'))return route.continue();blocked.push(request.method()+' '+url.pathname);return route.abort();});
  await page.goto(base);
  await page.evaluate(async()=>{
    window.c=await import('/core.mjs');window.g=await import('/image-generation-request.mjs');window.o=await import('/image-output-settings.mjs');window.t=await import('/layer-transform.mjs');window.packing=await import('/generation-input-packing.mjs');
    window.mask=(width,height,rectangles)=>{
      const counts=[];let previous=0,count=0;
      for(let y=0;y<height;y++)for(let x=0;x<width;x++){
        const bit=Number(rectangles.some(([left,top,w,h])=>x>=left&&x<left+w&&y>=top&&y<top+h));
        if(bit===previous)count++;else{counts.push(count);previous=bit;count=1;}
      }counts.push(count);return {width,height,counts};
    };
    window.photo=(name,width,height,draw)=>{const canvas=document.createElement('canvas');canvas.width=width;canvas.height=height;const context=canvas.getContext('2d');draw(context);const result={name,width,height,source:canvas.toDataURL('image/png')};canvas.width=canvas.height=1;return result;};
    window.fixture=(width=1536,height=1024)=>{
      const c=window.c,background=window.photo('Full canvas.png',width,height,ctx=>{ctx.fillStyle='#111111';ctx.fillRect(0,0,width,height);ctx.fillStyle='#1234ef';ctx.fillRect(0,0,20,20);ctx.fillStyle='#ef3412';ctx.fillRect(width-20,height-20,20,20);});
      let project=c.addRaster(c.newProject(width,height,'Native selected edit'),background).project;
      const original=window.photo('Two objects.png',400,240,ctx=>{ctx.fillStyle='#008000';ctx.fillRect(0,0,400,240);ctx.fillStyle='#ff0000';ctx.fillRect(40,30,70,60);ctx.fillRect(240,140,80,60);});
      const added=c.addRaster(project,original,{fitDocument:false});project=c.updateLayer(added.project,added.layerId,{x:480,y:300,width:400,height:240,rotation:90});
      const raster=project.layers.find(layer=>layer.id===added.layerId),first=window.t.layerPointToDocument(raster,{x:75,y:60}),second=window.t.layerPointToDocument(raster,{x:280,y:170}),gap=window.t.layerPointToDocument(raster,{x:180,y:110});
      const label=c.addText(project,{content:'1',x:first.x-8,y:first.y-10,width:16,height:20,fontSize:12,color:'#ff00ff'});
      project=c.attachObjectRegion(label.project,label.layerId,{version:1,assetId:raster.assetId,rasterLayerId:raster.id,sourceWidth:400,sourceHeight:240,mask:window.mask(400,240,[[40,30,70,60],[240,140,80,60]]),group:{areaCount:2}});
      project=c.updateLabelComment(project,label.layerId,'Change only the two red objects.');project.prompt='Keep everything else unchanged.';project.imageOutput={version:1,aspect:'9:16'};
      return {project,first,second,gap,original,rasterId:raster.id};
    };
    window.sample=async(source,points)=>{
      const image=new Image();image.src=source;await image.decode();const canvas=document.createElement('canvas');canvas.width=image.naturalWidth;canvas.height=image.naturalHeight;
      const context=canvas.getContext('2d');context.drawImage(image,0,0);const pixels=points.map(({x,y})=>[...context.getImageData(Math.floor(x),Math.floor(y),1,1).data]);
      const result={width:canvas.width,height:canvas.height,pixels};canvas.width=canvas.height=1;return result;
    };
  });
});
after(async()=>{
  await mkdir(qa,{recursive:true});await writeFile(path.join(qa,'report.json'),JSON.stringify({paidCalls:0,blockedRequests:blocked,errors,cases:report},null,2));
  await browser?.close();if(server)await new Promise(resolve=>server.close(resolve));assert.deepEqual(errors,[]);assert.deepEqual(blocked,[]);
});

test('landscape selected edit ignores stored portrait preference and keeps rotated disconnected masks on the native pixel grid',async()=>{
  const result=await page.evaluate(async()=>{
    const f=window.fixture(),before=JSON.stringify(f.project),input=await window.g.buildImageGenerationInput(f.project),output=window.o.resolveImageOutput(f.project,'gpt-image-2.5-sunburst');
    const points=[f.first,f.second,f.gap,{x:5,y:5},{x:1531,y:1019}];
    return {output,composition:await window.sample(input.composition.source,points),mask:await window.sample(input.areaMasks[0].image.source,points),guide:[input.guide.width,input.guide.height],unchanged:before===JSON.stringify(f.project),aspect:f.project.imageOutput.aspect,canvas:[f.project.width,f.project.height],maskRleUnchanged:JSON.stringify(window.g.imageGenerationPlan(input.project).maskAreas[0].selection.mask)===JSON.stringify(f.project.layers.find(layer=>layer.objectRegion).objectRegion.mask)};
  });
  assert.equal(result.output.size,'1536x1024');assert.equal(result.aspect,'9:16');assert.deepEqual(result.canvas,[1536,1024]);
  assert.equal(result.composition.width,1536);assert.equal(result.composition.height,1024);assert.deepEqual(result.guide,[1536,1024]);
  assert.equal(result.mask.width,1536);assert.equal(result.mask.height,1024);
  assert.deepEqual(result.composition.pixels,[[255,0,0,255],[255,0,0,255],[0,128,0,255],[18,52,239,255],[239,52,18,255]]);
  assert.deepEqual(result.mask.pixels,[[255,255,255,255],[255,255,255,255],[0,0,0,255],[0,0,0,255],[0,0,0,255]]);
  assert.equal(result.unchanged,true);assert.equal(result.maskRleUnchanged,true);report.push({name:'native landscape rotation and disconnected regions',...result});
});

test('large selected edit keeps 2160x3840 composition, guide and masks while separate reference annotations stay capped',async()=>{
  const result=await page.evaluate(async()=>{
    const f=window.fixture(2160,3840),c=window.c;
    const reference=window.photo('Tall appearance reference.png',800,3200,ctx=>{ctx.fillStyle='#2468ac';ctx.fillRect(0,0,800,3200);});
    f.project=c.addReference(f.project,reference);const ref=f.project.references[0],annotation=c.addText(c.referenceProject(ref),{content:'Use this finish',x:30,y:30,width:500,height:100,fontSize:32});
    f.project=c.updateReferenceAnnotations(f.project,ref.id,annotation.project.layers.slice(1));
    const before=JSON.stringify(f.project),input=await window.g.buildImageGenerationInput(f.project),points=[f.first,f.second,f.gap,{x:5,y:5},{x:2155,y:3835}];
    return {size:window.o.resolveImageOutput(f.project,'gpt-image-2.5-sunburst').size,composition:await window.sample(input.composition.source,points),mask:await window.sample(input.areaMasks[0].image.source,points),guide:[input.guide.width,input.guide.height],referencePreview:[input.referencePreviews[0].image.width,input.referencePreviews[0].image.height],referenceOriginal:[input.project.references[0].width,input.project.references[0].height],unchanged:before===JSON.stringify(f.project)};
  });
  assert.equal(result.size,'2160x3840');assert.equal(result.composition.width,2160);assert.equal(result.composition.height,3840);assert.deepEqual(result.guide,[2160,3840]);
  assert.equal(result.mask.width,2160);assert.equal(result.mask.height,3840);assert.deepEqual(result.mask.pixels,[[255,255,255,255],[255,255,255,255],[0,0,0,255],[0,0,0,255],[0,0,0,255]]);
  assert.deepEqual(result.composition.pixels.at(-1),[239,52,18,255]);assert.deepEqual(result.referencePreview,[650,2600]);assert.deepEqual(result.referenceOriginal,[800,3200]);assert.equal(result.unchanged,true);report.push({name:'large native edit and independent reference preview',...result});
});

test('overflow packing keeps every full-canvas selection mask standalone',async()=>{
  const result=await page.evaluate(()=>{
    const images=Array.from({length:24},()=>({width:1536,height:1024})),roles=[{image:1,role:'current composition'},{image:2,role:'canvas annotation guide'},...[3,4,5,6].map(image=>({image,role:'area selection mask'}))];
    const plan=window.packing.planGenerationInputPacking(images,roles);return {standalone:plan.slots.filter(slot=>slot.kind==='single').map(slot=>slot.sourceIndex),packed:plan.packed,physical:plan.physicalInputCount};
  });
  assert.equal(result.packed,true);assert.equal(result.physical,16);for(const index of [1,2,3,4,5,6])assert.ok(result.standalone.includes(index));report.push({name:'standalone masks with overflow references',...result});
});
