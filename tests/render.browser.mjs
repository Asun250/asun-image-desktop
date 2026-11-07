import {test,before,after} from 'node:test';
import assert from 'node:assert/strict';
import {chromium} from 'playwright';
import {createServer} from '../server.mjs';
let server,browser,page;
before(async () => {
  server=createServer();
  await new Promise(resolve => server.listen(0,'127.0.0.1',resolve));
  browser=await chromium.launch({headless:true});
  page=await browser.newPage();
  await page.goto(`http://127.0.0.1:${server.address().port}`);
  await page.waitForFunction(()=>document.documentElement.dataset.ready==='true');
  if(await page.locator('#skipStartup').isVisible())await page.locator('#skipStartup').click();
  await page.evaluate(async () => {
    window.core=await import('/core.mjs');
    window.render=await import('/render.mjs');
    window.imageSource=await import('/image-source.mjs');
    window.fixture=(color,width=16,height=16) => {
      const canvas=document.createElement('canvas'); canvas.width=width;canvas.height=height;
      const context=canvas.getContext('2d');context.fillStyle=color;context.fillRect(0,0,width,height);
      return {name:`${color}.png`,source:canvas.toDataURL('image/png'),width,height};
    };
    window.draw=async project => {
      const canvas=document.createElement('canvas'); await window.render.renderProject(project,canvas);
      return {canvas,pixel:(x,y) => Array.from(canvas.getContext('2d').getImageData(x,y,1,1).data)};
    };
  });
});
after(async () => { if(browser) await browser.close(); if(server) await new Promise(resolve => server.close(resolve)); });
test('actual browser canvas respects layer order, visibility, move and resize',async () => {
  const result=await page.evaluate(async () => {
    const {newProject,addRaster,updateLayer,reorderLayer}=window.core;
    let {project}=addRaster(newProject(),window.fixture('#ff0000'));
    const second=addRaster(project,window.fixture('#0000ff',8,8));project=second.project;
    const initial=await window.draw(project);
    const hidden=await window.draw(updateLayer(project,second.layerId,{visible:false}));
    const reordered=await window.draw(reorderLayer(project,second.layerId,0));
    const moved=await window.draw(updateLayer(project,second.layerId,{x:0,y:0,width:4,height:4}));
    return {initial:initial.pixel(8,8),hidden:hidden.pixel(8,8),reordered:reordered.pixel(8,8),movedInside:moved.pixel(2,2),movedOutside:moved.pixel(8,8)};
  });
  assert.deepEqual(result,{initial:[0,0,255,255],hidden:[255,0,0,255],reordered:[255,0,0,255],movedInside:[0,0,255,255],movedOutside:[255,0,0,255]});
});
test('mask hide/restore and undo/redo change actual alpha without altering source',async () => {
  const result=await page.evaluate(async () => {
    const {newProject,addRaster,addMaskStroke,History}=window.core;
    const original=window.fixture('#00ff00');const {project,layerId}=addRaster(newProject(),original);
    const history=new History(project);
    const masked=addMaskStroke(project,layerId,{mode:'hide',size:8,points:[[8,8]]});
    history.commit(masked,'Mask');
    const hidden=await window.draw(masked),undone=await window.draw(history.undo()),redone=await window.draw(history.redo());
    const restored=await window.draw(addMaskStroke(masked,layerId,{mode:'restore',size:8,points:[[8,8]]}));
    return {hidden:hidden.pixel(8,8)[3],undo:undone.pixel(8,8)[3],redo:redone.pixel(8,8)[3],restore:restored.pixel(8,8)[3],sourceUnchanged:masked.assets[masked.layers[0].assetId].source===original.source};
  });
  assert.deepEqual(result,{hidden:0,undo:255,redo:0,restore:255,sourceUnchanged:true});
});
test('PNG retains transparency, JPEG uses white, and both preserve dimensions',async () => {
  const result=await page.evaluate(async () => {
    const {newProject,addRaster,updateLayer}=window.core;
    const {project,layerId}=addRaster(newProject(),window.fixture('#ff0000'));
    const empty=updateLayer(project,layerId,{visible:false});
    const outputs={};
    for(const format of ['png','jpeg']) {
      const blob=await window.render.exportImage(empty,format);
      const decoded=await createImageBitmap(blob),canvas=document.createElement('canvas');canvas.width=decoded.width;canvas.height=decoded.height;
      const context=canvas.getContext('2d');context.drawImage(decoded,0,0);
      outputs[format]={type:blob.type,width:decoded.width,height:decoded.height,pixel:Array.from(context.getImageData(8,8,1,1).data)};decoded.close();
    }
    return outputs;
  });
  assert.deepEqual(result,{png:{type:'image/png',width:16,height:16,pixel:[0,0,0,0]},jpeg:{type:'image/jpeg',width:16,height:16,pixel:[255,255,255,255]}});
});
test('save/reopen and saved variants reproduce pixels; before view retains original',async () => {
  const result=await page.evaluate(async () => {
    const {newProject,addRaster,updateLayer,serializeProject,parseProject,saveVariant,restoreVariant}=window.core;
    const {project,layerId}=addRaster(newProject(),window.fixture('#ff0000'));
    const adjusted=saveVariant(updateLayer(project,layerId,{brightness:50}),'Half brightness');
    const reopened=parseProject(serializeProject(adjusted));
    const changed=updateLayer(reopened,layerId,{brightness:150});
    const restored=restoreVariant(changed,changed.variants[0].id);
    const a=await window.draw(adjusted),b=await window.draw(reopened),c=await window.draw(restored);
    const before=document.createElement('canvas');await window.render.renderProject(reopened,before,{original:true});
    return {adjusted:a.pixel(8,8),reopened:b.pixel(8,8),variant:c.pixel(8,8),original:Array.from(before.getContext('2d').getImageData(8,8,1,1).data)};
  });
  assert.ok(Math.abs(result.adjusted[0]-127.5)<=0.5,'50% brightness rounds to a neighboring 8-bit value');
  assert.deepEqual(result.adjusted.slice(1),[0,0,255]);
  assert.deepEqual(result.reopened,result.adjusted);assert.deepEqual(result.variant,result.adjusted);
  assert.deepEqual(result.original,[255,0,0,255]);
});
test('decode errors and unsupported exports reject with useful errors',async () => {
  const result=await page.evaluate(async () => {
    const errors=[];
    try{await window.render.decodeImage('data:image/png;base64,bm90YW5pbWFnZQ==');}catch(error){errors.push(error.message);}
    try{await window.render.exportImage(window.core.newProject(),'gif');}catch(error){errors.push(error.message);}
    return errors;
  });
  assert.match(result[0],/could not be decoded/);assert.match(result[1],/Choose PNG or JPEG/);
});
test('pencil dots and strokes render at document coordinates and remain transformable',async () => {
  const result = await page.evaluate(async () => {
    const {newProject,addDrawing,updateLayer,addMaskStroke} = window.core;
    const added = addDrawing(newProject(80,80),{mode:'pencil',color:'#ff0000',size:10,points:[[30,30]]});
    const drawn = await window.draw(added.project);
    const moved = await window.draw(updateLayer(added.project,added.layerId,{x:50,y:50,width:24,height:24}));
    const local = added.project.layers[0].drawing.points[0];
    const masked = await window.draw(addMaskStroke(added.project,added.layerId,{mode:'hide',size:12,points:[local]}));
    return {center:drawn.pixel(30,30),outside:drawn.pixel(24,30),movedCenter:moved.pixel(62,62),oldPlace:moved.pixel(30,30),masked:masked.pixel(30,30)};
  });
  assert.deepEqual(result,{center:[255,0,0,255],outside:[0,0,0,0],movedCenter:[255,0,0,255],oldPlace:[0,0,0,0],masked:[0,0,0,0]});
});
test('highlight applies opacity once across stroke intersections and saved pixels',async () => {
  const result = await page.evaluate(async () => {
    const {newProject,addRaster,addDrawing,serializeProject,parseProject} = window.core;
    const {project} = addRaster(newProject(),window.fixture('#ffffff',80,80));
    const highlighted = addDrawing(project,{mode:'highlight',color:'#0000ff',size:10,points:[[10,40],[70,40],[40,10],[40,70]]}).project;
    const output = await window.draw(highlighted), reopened = await window.draw(parseProject(serializeProject(highlighted)));
    return {straight:output.pixel(20,40),crossing:output.pixel(40,40),outside:output.pixel(5,5),identical:output.canvas.toDataURL()===reopened.canvas.toDataURL()};
  });
  assert.ok(Math.abs(result.straight[0]-166)<=1);
  assert.deepEqual(result.straight.slice(0,3),[result.straight[0],result.straight[0],255]);
  assert.deepEqual(result.crossing,result.straight,'A self-crossing highlight has uniform alpha');
  assert.deepEqual(result.outside,[255,255,255,255]);
  assert.equal(result.identical,true);
});
test('editable text renders with padding and follows history, variants and PNG export',async () => {
  const result = await page.evaluate(async () => {
    const {newProject,addRaster,addText,updateText,updateLayer,saveVariant,restoreVariant,serializeProject,parseProject,History} = window.core;
    const {project} = addRaster(newProject(),window.fixture('#ffffff',220,100));
    const added = addText(project,{content:'Note',x:15,y:10,fontSize:32,color:'#ff0000',width:130,height:55});
    const history = new History(added.project);
    const changed = updateText(added.project,added.layerId,{content:'Next',color:'#0000ff'});
    history.commit(changed,'Text edit');
    const initial = await window.draw(added.project), edited = await window.draw(changed), undone = await window.draw(history.undo());
    const saved = saveVariant(added.project,'Text note'), reopened = parseProject(serializeProject(saved));
    const hidden = updateLayer(reopened,added.layerId,{visible:false}), restored = await window.draw(restoreVariant(hidden,saved.variants[0].id));
    const blob = await window.render.exportImage(reopened,'png'), image = await createImageBitmap(blob);
    const exported = document.createElement('canvas'); exported.width=image.width; exported.height=image.height; exported.getContext('2d').drawImage(image,0,0); image.close();
    const pixels = initial.canvas.getContext('2d').getImageData(0,0,220,100).data;
    let redPixels=0, minX=Infinity, minY=Infinity, maxX=0, maxY=0;
    for(let y=0;y<100;y++) for(let x=0;x<220;x++) {
      const index=(y*220+x)*4;
      if(pixels[index] > 200 && pixels[index+1]<100 && pixels[index+2]<100) {redPixels++;minX=Math.min(minX,x);minY=Math.min(minY,y);maxX=Math.max(maxX,x);maxY=Math.max(maxY,y);}
    }
    return {redPixels,bounds:[minX,minY,maxX,maxY],unchangedOnUndo:initial.canvas.toDataURL()===undone.canvas.toDataURL(),textChangesPixels:initial.canvas.toDataURL()!==edited.canvas.toDataURL(),variantSame:initial.canvas.toDataURL()===restored.canvas.toDataURL(),pngSame:initial.canvas.toDataURL()===exported.toDataURL(),type:blob.type};
  });
  assert.ok(result.redPixels>100,'Text produces visible colored glyph pixels');
  assert.ok(result.bounds[0]>=22 && result.bounds[1]>=17 && result.bounds[2]<145 && result.bounds[3]<65,'Text stays within padded layer source');
  assert.deepEqual({undo:result.unchangedOnUndo,edit:result.textChangesPixels,variant:result.variantSame,png:result.pngSame,type:result.type},{undo:true,edit:true,variant:true,png:true,type:'image/png'});
});
test('confirming text preserves the glyph position shown by the textarea preview',async () => {
  await page.evaluate(async () => {
    const {newProject,addText} = window.core;
    const preview = document.createElement('div'); preview.id='text-position-fixture';
    Object.assign(preview.style,{position:'fixed',left:'50px',top:'50px',width:'240px',height:'140px',background:'#ffffff',zIndex:'1000'});
    const textarea = document.createElement('textarea'); textarea.id='text-position-preview'; textarea.value='Note\nNext';
    Object.assign(textarea.style,{position:'absolute',left:'15px',top:'10px',width:'130px',height:'106px',padding:'8px',fontFamily:'Arial',fontWeight:'600',fontSize:'36px',lineHeight:'1.25',color:'#ff0000',background:'transparent',border:'0',outline:'0',resize:'none',overflow:'hidden',margin:'0',whiteSpace:'pre',boxSizing:'border-box',caretColor:'transparent'});
    const output=document.createElement('canvas');output.id='text-position-output';output.style.display='none';
    const project=addText(newProject(240,140),{content:'Note\nNext',x:15,y:10,fontSize:36,color:'#ff0000',width:130,height:106}).project;
    await window.render.renderProject(project,output);preview.append(output,textarea);document.body.append(preview);
  });
  const fixture=page.locator('#text-position-fixture');
  async function redBounds() {
    const screenshot=await fixture.screenshot();
    return page.evaluate(async base64 => {
      const image=new Image();image.src=`data:image/png;base64,${base64}`;await image.decode();
      const canvas=document.createElement('canvas');canvas.width=image.width;canvas.height=image.height;
      const context=canvas.getContext('2d');context.drawImage(image,0,0);const pixels=context.getImageData(0,0,canvas.width,canvas.height).data;
      const rows=[];
      for(let y=0;y<canvas.height;y++) for(let x=0;x<canvas.width;x++) {
        const index=(y*canvas.width+x)*4;
        if(pixels[index]>200&&pixels[index+1]<100&&pixels[index+2]<100) {rows.push(y);break;}
      }
      return [Math.min(...rows),Math.max(...rows)];
    },screenshot.toString('base64'));
  }
  try {
    const previewBounds=await redBounds();
    await page.evaluate(()=>{document.querySelector('#text-position-preview').hidden=true;document.querySelector('#text-position-output').style.display='block';});
    const confirmedBounds=await redBounds();
    assert.ok(previewBounds[0]<previewBounds[1],'Preview contains visible text');
    for(let index=0;index<2;index++) assert.ok(Math.abs(confirmedBounds[index]-previewBounds[index])<=1,`Confirmed glyph bounds ${confirmedBounds} match preview ${previewBounds}`);
  } finally { await page.evaluate(()=>document.querySelector('#text-position-fixture').remove()); }
});

test('original PNG, JPEG and WebP import preserves every byte and exact filename with independent bounded thumbnails',async()=>{
  const results=await page.evaluate(async()=>{
    const results=[];
    for(const [format,width,height] of [['png',1536,768],['jpeg',768,1536],['webp',1536,384]]) {
      const canvas=document.createElement('canvas');canvas.width=width;canvas.height=height;const context=canvas.getContext('2d');context.fillStyle='#008000';context.fillRect(0,0,width,height);context.fillStyle='#0000ff';context.fillRect(width/2,0,width/2,height/2);
      const blob=await new Promise(resolve=>canvas.toBlob(resolve,`image/${format}`,0.77)),name='Literal original '+('雪'.repeat(300))+'.wrong-extension';
      const file=new File([blob,new TextEncoder().encode('ASUN ORIGINAL TAIL METADATA')],name,{type:'application/octet-stream'}),bytes=new Uint8Array(await file.arrayBuffer()),image=await window.imageSource.readOriginalImage(file);
      const original=new Uint8Array(await window.imageSource.originalBlob(image).arrayBuffer()),payload=Uint8Array.from(atob(image.source.split(',')[1]),character=>character.charCodeAt(0)),preview=await window.render.decodeImage(image.preview.source);
      let {project,layerId}=window.core.addRaster(window.core.newProject(),image);project=window.core.addReference(project,image);
      const history=new window.core.History(project),cropped={...window.core.updateLayer(project,layerId,{x:-30,y:-20,width:width/2,height:height/2}),width:Math.floor(width/2),height:Math.floor(height/2)},annotated=window.core.addText(cropped,{content:'Only snow caps',x:10,y:10,width:260,height:60}).project;
      history.commit(annotated,'Crop and annotate');const reopened=window.core.parseProject(window.core.serializeProject(history.redo())),asset=reopened.assets[reopened.layers[0].assetId];
      const originalCreate=document.createElement;document.createElement=function(){throw new Error('Original export must not create canvas');};let info,noCanvasBytes;
      try{info=window.imageSource.sourceFileInfo(asset);noCanvasBytes=new Uint8Array(await window.imageSource.originalBlob(asset).arrayBuffer());}finally{document.createElement=originalCreate;}
      const legacy={...image,source:image.source.replace(`data:image/${format};`,`data:image/png;`)};delete legacy.originalFile;delete legacy.preview;
      const legacyInfo=window.imageSource.sourceFileInfo(legacy);
      results.push({format,name:image.name,expectedName:name,originalFile:image.originalFile,byteLength:bytes.length,dimensions:[image.width,image.height],expectedDimensions:[width,height],bytesSame:bytes.length===original.length&&bytes.every((value,index)=>value===original[index])&&bytes.every((value,index)=>value===payload[index])&&bytes.every((value,index)=>value===noCanvasBytes[index]),preview:{width:preview.naturalWidth,height:preview.naturalHeight,kind:image.preview.kind,png:image.preview.source.startsWith('data:image/png;base64,'),independent:image.preview.source!==image.source},info,legacyInfo,assetSourceSame:asset.source===image.source,referenceSourceSame:reopened.references[0].source===image.source,filenameSame:asset.name===name&&reopened.references[0].name===name,undoSourceSame:history.undo().assets[asset.id].source===image.source});
    }
    return results;
  });
  for(const result of results) {
    assert.equal(result.name,result.expectedName);assert.deepEqual(result.originalFile,{name:result.expectedName,mimeType:`image/${result.format}`,byteLength:result.byteLength});
    assert.deepEqual(result.dimensions,result.expectedDimensions);assert.equal(result.bytesSame,true,'Original payload including trailing metadata survives without canvas transcoding');
    assert.ok(result.preview.width<=512&&result.preview.height<=512);assert.equal(Math.max(result.preview.width,result.preview.height),512);assert.equal(result.preview.kind,'generated-thumbnail');assert.equal(result.preview.png,true);assert.equal(result.preview.independent,true);
    assert.deepEqual(result.info,result.originalFile);assert.deepEqual(result.legacyInfo,result.originalFile,'Legacy declared MIME never overrides the actual byte signature');
    assert.equal(result.assetSourceSame,true);assert.equal(result.referenceSourceSame,true);assert.equal(result.filenameSame,true);assert.equal(result.undoSourceSame,true);
  }
});

test('original import validates signature and original limits while legacy thumbnail generation never changes its source',async()=>{
  const result=await page.evaluate(async()=>{
    const errors=[];for(const file of [new File(['GIF89a'],'fake.png',{type:'image/png'}),new File([Uint8Array.from([137,80,78,71,13,10,26,10])],'broken.png'),new File(['x'],'x'.repeat(501)),{name:'large.png',size:50*1024*1024+1}])try{await window.imageSource.readOriginalImage(file);}catch(error){errors.push(error.message);}
    const tooWide=window.fixture('#ff0000',8193,1),wideBlob=window.imageSource.originalBlob(tooWide);try{await window.imageSource.readOriginalImage(new File([wideBlob],'wide.png'));}catch(error){errors.push(error.message);}
    const legacy=window.fixture('#0000ff',1200,600),before=JSON.stringify(legacy),first=await window.imageSource.previewSource(legacy),second=await window.imageSource.previewSource(legacy),preview=await window.render.decodeImage(first);
    window.imageSource.clearPreviewCache();const afterClear=await window.imageSource.previewSource(legacy);
    return {errors,width:preview.naturalWidth,height:preview.naturalHeight,cachedSame:first===second,afterClearSame:first===afterClear,unchanged:before===JSON.stringify(legacy),storedPreview:await window.imageSource.previewSource({...legacy,preview:{source:'stored-thumbnail'}})};
  });
  assert.match(result.errors[0],/original PNG, JPEG or WebP/);assert.match(result.errors[1],/could not be decoded/);assert.match(result.errors[2],/filename up to 500/);assert.match(result.errors[3],/under 50 MB/);assert.match(result.errors[4],/8192/);
  assert.deepEqual([result.width,result.height],[512,256]);assert.equal(result.cachedSame,true);assert.equal(result.afterClearSame,true);assert.equal(result.unchanged,true);assert.equal(result.storedPreview,'stored-thumbnail');
});

test('bounded composite previews keep native mask, pencil, highlight and text coordinates without using stored thumbnails',async()=>{
  const result=await page.evaluate(async()=>{
    const image={...window.fixture('#008000',4096,2048),preview:{source:window.fixture('#ff00ff',16,16).source,width:16,height:16,kind:'generated-thumbnail'}};
    let {project,layerId}=window.core.addRaster(window.core.newProject(),image);
    project=window.core.addMaskStroke(project,layerId,{mode:'hide',size:300,points:[[1000,800]]});
    project=window.core.addDrawing(project,{mode:'pencil',color:'#0000ff',size:80,points:[[2000,1200],[2400,1200]]}).project;
    project=window.core.addDrawing(project,{mode:'highlight',color:'#ffff00',size:160,points:[[3000,1000]]}).project;
    project=window.core.addText(project,{content:'Snow only',x:1500,y:200,fontSize:160,color:'#ff0000',width:1300,height:250}).project;
    const before=JSON.stringify(project),created=[],originalCreate=document.createElement;
    document.createElement=function(tag,...rest){const item=originalCreate.call(this,tag,...rest);if(tag==='canvas')created.push(item);return item;};
    let output;try{output=await window.render.renderProjectPreview(project,undefined,{maxSide:640});}finally{document.createElement=originalCreate;}
    const context=output.getContext('2d'),pixel=(x,y)=>Array.from(context.getImageData(Math.floor(x*output.width/project.width),Math.floor(y*output.height/project.height),1,1).data),data=context.getImageData(0,0,output.width,output.height).data;
    let red=0;for(let index=0;index<data.length;index+=4)if(data[index]>200&&data[index+1]<80&&data[index+2]<80)red++;
    const errors=[];for(const maxSide of [0,Infinity,8193,2.5])try{await window.render.renderProjectPreview(project,undefined,{maxSide});}catch(error){errors.push(error.message);}
    return {width:output.width,height:output.height,plain:pixel(100,100),mask:pixel(1000,800),pencil:pixel(2200,1200),highlight:pixel(3000,1000),red,buffersBounded:created.every(item=>item.width<=640&&item.height<=640),unchanged:before===JSON.stringify(project),sourceSame:project.assets[project.layers[0].assetId].source===image.source,errors};
  });
  assert.deepEqual([result.width,result.height],[640,320]);assert.deepEqual(result.plain,[0,128,0,255]);assert.equal(result.mask[3],0);assert.deepEqual(result.pencil,[0,0,255,255]);assert.ok(Math.abs(result.highlight[0]-89)<=1&&Math.abs(result.highlight[1]-172)<=1&&result.highlight[2]===0);assert.ok(result.red>100);
  assert.equal(result.buffersBounded,true);assert.equal(result.unchanged,true);assert.equal(result.sourceSame,true);assert.equal(result.errors.length,4);for(const error of result.errors)assert.match(error,/preview size/);
});
