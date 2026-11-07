import {test,before,after} from 'node:test';
import assert from 'node:assert/strict';
import {chromium} from 'playwright';
import {createServer} from '../server.mjs';
let server,browser,page;
before(async()=>{
  server=createServer();await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  browser=await chromium.launch({headless:true});page=await browser.newPage();await page.goto(`http://127.0.0.1:${server.address().port}`);
  await page.evaluate(async()=>{
    window.core=await import('/core.mjs');window.board=await import('/reference-board.mjs');
    window.fixture=(color,width=16,height=16)=>{const canvas=document.createElement('canvas');canvas.width=width;canvas.height=height;const context=canvas.getContext('2d');context.fillStyle=color;context.fillRect(0,0,width,height);return {name:`${color}.png`,source:canvas.toDataURL(),width,height};};
    window.pixel=(canvas,x,y)=>Array.from(canvas.getContext('2d').getImageData(Math.floor(x),Math.floor(y),1,1).data);
  });
});
after(async()=>{if(browser)await browser.close();if(server)await new Promise(resolve=>server.close(resolve));});
test('board PNG contains annotated MAIN pixels and two mapped photos with a shared-reference group',async()=>{
  const result=await page.evaluate(async()=>{
    const {newProject,addRaster,addText,addDrawing,addReference,linkReference,serializeProject,parseProject}=window.core;
    let {project}=addRaster(newProject(),window.fixture('#008000',240,160));
    project=addReference(addReference(project,window.fixture('#ff0000',16,16)),window.fixture('#0000ff',16,32));
    const [red,blue]=project.references;
    for(const [content,x,referenceId] of [['1',24,red.id],['2',100,blue.id],['3',170,red.id]]) {
      const added=addText(project,{content,x,y:30,fontSize:24,color:'#ff0000',width:50,height:44});project=linkReference(added.project,added.layerId,referenceId);
    }
    project=addDrawing(project,{mode:'pencil',color:'#ff8000',size:8,points:[[170,130],[200,130]]}).project;
    const before=JSON.stringify(project),layout=window.board.referenceBoardLayout(project),target=document.createElement('canvas');
    const output=await window.board.renderReferenceBoard(project,target),blob=await window.board.exportReferenceBoard(project),image=await createImageBitmap(blob);
    const exported=document.createElement('canvas');exported.width=image.width;exported.height=image.height;exported.getContext('2d').drawImage(image,0,0);image.close();
    const reopened=await window.board.renderReferenceBoard(parseProject(serializeProject(project)));
    const scale=layout.main.width/project.width;
    return {sameTarget:output===target,groups:window.board.linkedReferences(project).map(group=>group.labels),white:window.pixel(output,5,5),scene:window.pixel(output,layout.main.x+10*scale,layout.main.y+10*scale),pencil:window.pixel(output,layout.main.x+185*scale,layout.main.y+130*scale),references:layout.tiles.map(tile=>window.pixel(output,tile.image.x+tile.image.width/2,tile.image.y+tile.image.height/2)),type:blob.type,width:exported.width,height:exported.height,pngSame:output.toDataURL()===exported.toDataURL(),reopenedSame:output.toDataURL()===reopened.toDataURL(),unchanged:before===JSON.stringify(project)};
  });
  assert.equal(result.sameTarget,true);assert.deepEqual(result.groups,[['1','3'],['2']]);
  assert.deepEqual(result.white,[255,255,255,255]);assert.deepEqual(result.scene,[0,128,0,255]);assert.deepEqual(result.pencil,[255,128,0,255]);
  assert.deepEqual(result.references,[[255,0,0,255],[0,0,255,255]]);
  assert.equal(result.type,'image/png');assert.equal(result.width,2000);assert.ok(result.height>1000);
  assert.equal(result.pngSame,true);assert.equal(result.reopenedSame,true);assert.equal(result.unchanged,true);
});
test('transparent MAIN becomes white and unlinked/hidden/outside reference photos are excluded',async()=>{
  const result=await page.evaluate(async()=>{
    const {newProject,addText,addReference,linkReference,updateLayer}=window.core;
    let project=addReference(addReference(newProject(64,64),window.fixture('#0000ff')),window.fixture('#ffff00'));
    const [blue,yellow]=project.references;
    const visible=addText(project,{content:'1',x:10,y:10,fontSize:16,color:'#ff0000',width:30,height:28});project=linkReference(visible.project,visible.layerId,blue.id);
    for(const patch of [{visible:false},{opacity:0},{x:64}]) {
      const hidden=addText(project,{content:'Unused',x:10,y:10,fontSize:16,width:30,height:28});project=updateLayer(linkReference(hidden.project,hidden.layerId,yellow.id),hidden.layerId,patch);
    }
    const layout=window.board.referenceBoardLayout(project),output=await window.board.renderReferenceBoard(project);
    return {groups:window.board.linkedReferences(project).map(group=>group.reference.id),wanted:blue.id,tiles:layout.tiles.length,blank:window.pixel(output,layout.main.x+layout.main.width*.05,layout.main.y+layout.main.height*.05),photo:window.pixel(output,layout.tiles[0].image.x+layout.tiles[0].image.width/2,layout.tiles[0].image.y+layout.tiles[0].image.height/2)};
  });
  assert.deepEqual(result.groups,[result.wanted]);assert.equal(result.tiles,1);assert.deepEqual(result.blank,[255,255,255,255]);assert.deepEqual(result.photo,[0,0,255,255]);
});
test('twelve photos, long labels and extreme canvas shapes keep bounded, uncropped layouts',async()=>{
  const results=await page.evaluate(()=>{
    const {newProject,addReference,addText,linkReference}=window.core,results=[];
    for(const [width,height] of [[1,8192],[8192,1],[4000,8000],[64,64]]) {
      let project=newProject(width,height);
      for(let index=0;index<12;index++) {
        project=addReference(project,{...window.fixture('#ff0000',16,index%2?64:16),name:'Reference '+index+' '+('very long filename '.repeat(20))});
        const added=addText(project,{content:`${index+1} ${'description '.repeat(400)}`,x:0,y:0,width:60,height:60});project=linkReference(added.project,added.layerId,project.references.at(-1).id);
      }
      const layout=window.board.referenceBoardLayout(project);
      results.push({width:layout.width,height:layout.height,sceneRatio:layout.main.width/layout.main.height,originalRatio:width/height,tiles:layout.tiles.length,labelsBounded:layout.tiles.every(tile=>tile.labelLines.length<=10&&tile.nameLines.length<=2),photosUncropped:layout.tiles.every(tile=>Math.abs(tile.image.width/tile.image.height-tile.group.reference.width/tile.group.reference.height)<1e-6),within:layout.tiles.every(tile=>tile.x>=0&&tile.y>=0&&tile.x+tile.width<=layout.width&&tile.y+tile.height<=layout.height)});
    }
    return results;
  });
  for(const result of results) {
    assert.ok(result.width<=8192&&result.height<=8192&&result.width*result.height<=32_000_000);
    assert.ok(Math.abs(result.sceneRatio-result.originalRatio)<1e-6);assert.equal(result.tiles,12);assert.equal(result.labelsBounded,true);assert.equal(result.photosUncropped,true);assert.equal(result.within,true);
  }
});
test('a tall MAIN keeps its top and bottom pixels inside the original aspect ratio',async()=>{
  const result=await page.evaluate(async()=>{
    const {newProject,addRaster,updateLayer,addReference,addText,linkReference}=window.core;
    let {project}=addRaster(newProject(),window.fixture('#008000',160,640));
    const top=addRaster(project,window.fixture('#ff0000',160,20));project=updateLayer(top.project,top.layerId,{x:0,y:0});
    const bottom=addRaster(project,window.fixture('#0000ff',160,20));project=updateLayer(bottom.project,bottom.layerId,{x:0,y:620});
    project=addReference(project,window.fixture('#808080',16,64));
    const label=addText(project,{content:'1',x:50,y:100,width:60,height:60});project=linkReference(label.project,label.layerId,project.references[0].id);
    const layout=window.board.referenceBoardLayout(project),output=await window.board.renderReferenceBoard(project),scale=layout.main.height/project.height;
    return {ratio:layout.main.width/layout.main.height,top:window.pixel(output,layout.main.x+80*scale,layout.main.y+10*scale),middle:window.pixel(output,layout.main.x+80*scale,layout.main.y+350*scale),bottom:window.pixel(output,layout.main.x+80*scale,layout.main.y+630*scale),photo:window.pixel(output,layout.tiles[0].image.x+layout.tiles[0].image.width/2,layout.tiles[0].image.y+layout.tiles[0].image.height/2)};
  });
  assert.equal(result.ratio,0.25);assert.deepEqual(result.top,[255,0,0,255]);assert.deepEqual(result.middle,[0,128,0,255]);assert.deepEqual(result.bottom,[0,0,255,255]);assert.deepEqual(result.photo,[128,128,128,255]);
});
test('no visible linked label produces an actionable export error',async()=>{
  const errors=await page.evaluate(async()=>{
    const errors=[];try{await window.board.exportReferenceBoard(window.core.newProject());}catch(error){errors.push(error.message);}
    let project=window.core.addReference(window.core.newProject(),window.fixture('#0000ff'));
    const text=window.core.addText(project,{content:'1',x:10,y:10,width:60,height:60});
    project=window.core.updateLayer(window.core.linkReference(text.project,text.layerId,project.references[0].id),text.layerId,{visible:false});
    try{await window.board.renderReferenceBoard(project);}catch(error){errors.push(error.message);}return errors;
  });
  assert.equal(errors.length,2);for(const error of errors)assert.match(error,/Link a visible text label/);
});
test('shared labels can reuse one photo but ambiguous labels stop board export',async()=>{
  const result=await page.evaluate(async()=>{
    const {newProject,addText,addReference,linkReference,updateLayer}=window.core;
    let project=addReference(addReference(newProject(160,100),window.fixture('#ff0000')),window.fixture('#0000ff'));
    const [red,blue]=project.references;
    const first=addText(project,{content:' 1 ',x:10,y:10,width:60,height:60});project=linkReference(first.project,first.layerId,red.id);
    const second=addText(project,{content:'1',x:80,y:10,width:60,height:60});project=linkReference(second.project,second.layerId,red.id);
    const shared=window.board.referenceBoardLayout(project).tiles.map(tile=>tile.group.labels);
    const ambiguous=linkReference(project,second.layerId,blue.id),errors=[];
    try{await window.board.exportReferenceBoard(ambiguous);}catch(error){errors.push(error.message);}
    const hidden=updateLayer(ambiguous,second.layerId,{visible:false});
    return {shared,errors,ambiguousLinkSaved:ambiguous.layers.at(-1).referenceIds.includes(blue.id),hiddenWorks:window.board.referenceBoardLayout(hidden).tiles.length===1};
  });
  assert.deepEqual(result.shared,[['1']]);assert.equal(result.ambiguousLinkSaved,true);assert.equal(result.hiddenWorks,true);
  assert.deepEqual(result.errors,['Label “1” is linked to different photos. Use a different number or the same reference photo.']);
});
test('reference text, pencil and highlights appear in board pixels and stay editable after reopen',async()=>{
  const result=await page.evaluate(async()=>{
    const {newProject,addRaster,addReference,addText,addDrawing,linkReferences,referenceProject,updateReferenceAnnotations,serializeProject,parseProject}=window.core;
    let {project}=addRaster(newProject(),window.fixture('#ffffff',160,120));project=addReference(project,window.fixture('#008000',160,120));
    const reference=project.references[0];let edit=referenceProject(reference);
    edit=addText(edit,{content:'Detail',x:10,y:10,fontSize:24,color:'#ff0000',width:110,height:40}).project;
    edit=addDrawing(edit,{mode:'pencil',color:'#0000ff',size:8,points:[[30,80],[120,80]]}).project;
    edit=addDrawing(edit,{mode:'highlight',color:'#ffff00',size:12,points:[[140,100]]}).project;
    project=updateReferenceAnnotations(project,reference.id,edit.layers.filter(layer=>layer.kind!=='raster'));
    const label=addText(project,{content:'1',x:10,y:10,width:50,height:50});project=linkReferences(label.project,label.layerId,[reference.id]);
    const before=JSON.stringify(project),layout=window.board.referenceBoardLayout(project),output=await window.board.renderReferenceBoard(project),tile=layout.tiles[0],scale=tile.image.width/reference.width;
    const reopened=parseProject(serializeProject(project)),reopenedOutput=await window.board.renderReferenceBoard(reopened);
    const data=output.getContext('2d').getImageData(Math.floor(tile.image.x),Math.floor(tile.image.y),Math.ceil(tile.image.width),Math.ceil(tile.image.height)).data;
    let red=0;for(let index=0;index<data.length;index+=4)if(data[index]>200&&data[index+1]<80&&data[index+2]<80)red++;
    return {pencil:window.pixel(output,tile.image.x+80*scale,tile.image.y+80*scale),highlight:window.pixel(output,tile.image.x+140*scale,tile.image.y+100*scale),plain:window.pixel(output,tile.image.x+140*scale,tile.image.y+20*scale),red,editableKinds:reopened.references[0].annotations.map(layer=>layer.kind),sourceSame:reopened.references[0].source===reference.source,pixelsSame:output.toDataURL()===reopenedOutput.toDataURL(),stateSame:before===JSON.stringify(project)};
  });
  assert.deepEqual(result.pencil,[0,0,255,255]);assert.deepEqual(result.plain,[0,128,0,255]);assert.ok(Math.abs(result.highlight[0]-89)<=1&&Math.abs(result.highlight[1]-172)<=1&&result.highlight[2]===0);
  assert.ok(result.red>100,'Reference text glyphs are visible in the tile');assert.deepEqual(result.editableKinds,['text','drawing','drawing']);assert.equal(result.sourceSame,true);assert.equal(result.pixelsSame,true);assert.equal(result.stateSame,true);
});
test('twenty photos linked to one label export across two pages without omissions or ambiguity',async()=>{
  const result=await page.evaluate(async()=>{
    const {newProject,addRaster,addReference,addText,linkReferences}=window.core;
    let {project}=addRaster(newProject(),window.fixture('#008000',240,160));
    for(let index=0;index<20;index++)project=addReference(project,window.fixture(`#${index.toString(16).padStart(2,'0')}4000`));
    const ids=project.references.map(reference=>reference.id),first=addText(project,{content:'1',x:10,y:10,width:60,height:60});project=linkReferences(first.project,first.layerId,ids);
    const repeated=addText(project,{content:'1',x:100,y:10,width:60,height:60});project=linkReferences(repeated.project,repeated.layerId,[...ids].reverse());
    const before=JSON.stringify(project),pages=window.board.referenceBoardPages(project),blobs=await window.board.exportReferenceBoards(project),pixels=[],scenes=[];
    for(const [index,blob] of blobs.entries()) {
      const bitmap=await createImageBitmap(blob),canvas=document.createElement('canvas');canvas.width=bitmap.width;canvas.height=bitmap.height;canvas.getContext('2d').drawImage(bitmap,0,0);bitmap.close();
      pixels.push(pages[index].tiles.map(tile=>window.pixel(canvas,tile.image.x+tile.image.width/2,tile.image.y+tile.image.height/2)));
      const main=pages[index].main,scale=main.width/project.width;scenes.push(window.pixel(canvas,main.x+20*scale,main.y+130*scale));
    }
    const second=await window.board.exportReferenceBoard(project,1),bitmap=await createImageBitmap(second);const selected=document.createElement('canvas');selected.width=bitmap.width;selected.height=bitmap.height;selected.getContext('2d').drawImage(bitmap,0,0);bitmap.close();
    const last=pages[1].tiles.at(-1),errors=[];try{await window.board.exportReferenceBoard(project,2);}catch(error){errors.push(error.message);}
    return {groups:window.board.linkedReferences(project).length,pages:pages.map(layout=>({page:layout.page,pageNumber:layout.pageNumber,pageCount:layout.pageCount,totalReferences:layout.totalReferences,tiles:layout.tiles.length,width:layout.width,height:layout.height})),allIds:pages.flatMap(layout=>layout.tiles.map(tile=>tile.group.reference.id)),wantedIds:ids,pixels,scenes,selectedLast:window.pixel(selected,last.image.x+last.image.width/2,last.image.y+last.image.height/2),errors,stateSame:before===JSON.stringify(project)};
  });
  assert.equal(result.groups,20);assert.deepEqual(result.allIds,result.wantedIds);assert.deepEqual(result.pages.map(page=>[page.page,page.pageNumber,page.pageCount,page.totalReferences,page.tiles]),[[0,1,2,20,12],[1,2,2,20,8]]);
  for(const page of result.pages)assert.ok(page.width<=8192&&page.height<=8192&&page.width*page.height<=32_000_000);
  assert.deepEqual(result.pixels.flat(),Array.from({length:20},(_,index)=>[index,64,0,255]));assert.deepEqual(result.scenes,[[0,128,0,255],[0,128,0,255]]);assert.deepEqual(result.selectedLast,[19,64,0,255]);assert.match(result.errors[0],/available reference board page/);assert.equal(result.stateSame,true);
});

test('multiline reference notes are drawn beside the unchanged photo and survive project reopening',async()=>{
  const result=await page.evaluate(async()=>{
    const {newProject,addRaster,addReference,addText,linkReference,updateReferenceNotes,serializeProject,parseProject}=window.core;
    let {project}=addRaster(newProject(),window.fixture('#008000',240,160));project=addReference(project,window.fixture('#0000ff'));
    const referenceId=project.references[0].id,label=addText(project,{content:'1',x:10,y:10,width:60,height:60});project=linkReference(label.project,label.layerId,referenceId);
    const notes='Only apply snow caps.\nKeep the existing glass clear.\nDo not change the desk.';
    project=updateReferenceNotes(project,referenceId,notes);const before=JSON.stringify(project),layout=window.board.referenceBoardLayout(project),tile=layout.tiles[0],drawn=[];
    const original=CanvasRenderingContext2D.prototype.fillText;
    CanvasRenderingContext2D.prototype.fillText=function(text,x,y,...rest){drawn.push(String(text));return original.call(this,text,x,y,...rest);};
    let output;try{output=await window.board.renderReferenceBoard(project);}finally{CanvasRenderingContext2D.prototype.fillText=original;}
    const frame=tile.notesFrame,data=output.getContext('2d').getImageData(Math.floor(frame.x),Math.floor(frame.y),Math.floor(frame.width),Math.ceil(frame.height)).data;
    const dark=Array(tile.noteLines.length+1).fill(0);for(let y=0;y<frame.height;y++)for(let x=0;x<Math.floor(frame.width);x++){const offset=(y*Math.floor(frame.width)+x)*4;if(data[offset]<80&&data[offset+1]<80&&data[offset+2]<80)dark[Math.floor(y/32)]++;}
    const reopened=await window.board.renderReferenceBoard(parseProject(serializeProject(project)));
    return {noteLines:tile.noteLines,drawn:drawn.filter(text=>text==='Notes:'||notes.split('\n').includes(text)),guidance:drawn.find(text=>text.includes('written notes')),dark,frameWithin:frame.x>=tile.x&&frame.x+frame.width<=tile.x+tile.width&&frame.y>=tile.imageFrame.y+tile.imageFrame.height&&frame.y+frame.height<=tile.y+tile.height,photo:window.pixel(output,tile.image.x+tile.image.width/2,tile.image.y+tile.image.height/2),reopenedSame:output.toDataURL()===reopened.toDataURL(),stateSame:before===JSON.stringify(project),sourceSame:project.references[0].source===window.fixture('#0000ff').source};
  });
  assert.deepEqual(result.noteLines,['Only apply snow caps.','Keep the existing glass clear.','Do not change the desk.']);
  assert.deepEqual(result.drawn,['Notes:',...result.noteLines]);assert.match(result.guidance,/written notes/);
  assert.ok(result.dark.every(count=>count>100),'Heading and each instruction line have actual rendered glyph pixels');
  assert.equal(result.frameWithin,true);assert.deepEqual(result.photo,[0,0,255,255]);assert.equal(result.reopenedSame,true);assert.equal(result.stateSame,true);assert.equal(result.sourceSame,true);
});

test('missing and blank reference notes keep the existing no-note board pixels and geometry',async()=>{
  const result=await page.evaluate(async()=>{
    const {newProject,addRaster,addReference,addText,linkReference,updateReferenceNotes}=window.core;
    let {project}=addRaster(newProject(),window.fixture('#008000',240,160));project=addReference(project,window.fixture('#ff0000'));
    const label=addText(project,{content:'1',x:10,y:10,width:60,height:60});project=linkReference(label.project,label.layerId,project.references[0].id);
    const blank=await window.board.renderReferenceBoard(project),layout=window.board.referenceBoardLayout(project);delete project.references[0].notes;
    const missing=await window.board.renderReferenceBoard(project),spaces=await window.board.renderReferenceBoard(updateReferenceNotes(project,project.references[0].id,' \n\t '));
    return {height:layout.height,imageFrame:layout.tiles[0].imageFrame,tileHeight:layout.tiles[0].height,notesFrame:layout.tiles[0].notesFrame,noteLines:layout.tiles[0].noteLines,same:blank.toDataURL()===missing.toDataURL()&&blank.toDataURL()===spaces.toDataURL()};
  });
  assert.equal(result.height,2165);assert.equal(result.tileHeight,559);assert.deepEqual(result.imageFrame,{x:72,y:1693,width:1856,height:400});
  assert.equal(result.notesFrame,null);assert.deepEqual(result.noteLines,[]);assert.equal(result.same,true);
});

test('twelve long notes paginate dynamically with every photo and full instruction text preserved',async()=>{
  const result=await page.evaluate(async()=>{
    const {newProject,addReference,addText,linkReferences,updateReferenceNotes}=window.core;
    let project=newProject(160,640);
    for(let index=0;index<12;index++) {
      project=addReference(project,window.fixture(`#${index.toString(16).padStart(2,'0')}4000`));
      const notes=('Only apply snow caps. Keep glass clear. '.repeat(52)).slice(0,1970)+` END PHOTO ${index}.`;
      project=updateReferenceNotes(project,project.references.at(-1).id,notes);
    }
    const ids=project.references.map(reference=>reference.id),label=addText(project,{content:'1',x:10,y:10,width:60,height:60});project=linkReferences(label.project,label.layerId,ids);
    const before=JSON.stringify(project),pages=window.board.referenceBoardPages(project),blobs=await window.board.exportReferenceBoards(project),photos=[],lastLineInk=[];
    for(const [index,blob] of blobs.entries()) {
      const bitmap=await createImageBitmap(blob),output=document.createElement('canvas');output.width=bitmap.width;output.height=bitmap.height;output.getContext('2d').drawImage(bitmap,0,0);bitmap.close();
      for(const tile of pages[index].tiles) {
        photos.push(window.pixel(output,tile.image.x+tile.image.width/2,tile.image.y+tile.image.height/2));
        const frame=tile.notesFrame,data=output.getContext('2d').getImageData(Math.floor(frame.x),Math.floor(frame.y+tile.noteLines.length*32),Math.floor(frame.width),32).data;
        let dark=0;for(let offset=0;offset<data.length;offset+=4)if(data[offset]<80&&data[offset+1]<80&&data[offset+2]<80)dark++;lastLineInk.push(dark);
      }
    }
    const measure=document.createElement('canvas').getContext('2d');measure.font='24px Arial';
    return {
      pageCount:pages.length,blobCount:blobs.length,ids:pages.flatMap(layout=>layout.tiles.map(tile=>tile.group.reference.id)),wantedIds:ids,photos,lastLineInk,
      notesComplete:pages.every(layout=>layout.tiles.every(tile=>tile.noteLines.join('').replace(/\s/g,'')===(tile.group.reference.notes||'').replace(/\s/g,''))),
      linesFit:pages.every(layout=>layout.tiles.every(tile=>tile.noteLines.every(line=>measure.measureText(line).width<=tile.notesFrame.width))),
      bounded:pages.every(layout=>layout.width<=8192&&layout.height<=8192&&layout.width*layout.height<=32_000_000&&layout.tiles.length<=12&&layout.tiles.every(tile=>tile.notesFrame.y+tile.notesFrame.height<=tile.y+tile.height&&tile.y+tile.height<=layout.height)),
      stateSame:before===JSON.stringify(project)
    };
  });
  assert.ok(result.pageCount>1);assert.equal(result.blobCount,result.pageCount);assert.deepEqual(result.ids,result.wantedIds);
  assert.deepEqual(result.photos,Array.from({length:12},(_,index)=>[index,64,0,255]));assert.ok(result.lastLineInk.every(count=>count>50));
  assert.equal(result.notesComplete,true);assert.equal(result.linesFit,true);assert.equal(result.bounded,true);assert.equal(result.stateSame,true);
});

test('long unbroken words and newline-heavy notes remain readable without truncation or omissions',async()=>{
  const result=await page.evaluate(async()=>{
    const {newProject,addReference,addText,linkReference,updateReferenceNotes}=window.core;
    let project=addReference(newProject(64,64),window.fixture('#ff0000'));
    const referenceId=project.references[0].id,label=addText(project,{content:'1',x:10,y:10,width:60,height:60});project=linkReference(label.project,label.layerId,referenceId);
    const word='i '+('W'.repeat(1998)),wordLayout=window.board.referenceBoardLayout(updateReferenceNotes(project,referenceId,word)),measure=document.createElement('canvas').getContext('2d');measure.font='24px Arial';
    const note='X\n'.repeat(999)+'Z';project=updateReferenceNotes(project,referenceId,note);
    const pages=window.board.referenceBoardPages(project),last=pages.at(-1),tile=last.tiles[0],output=await window.board.renderReferenceBoard(project,undefined,last.page),frame=tile.notesFrame;
    const data=output.getContext('2d').getImageData(Math.floor(frame.x),Math.floor(frame.y+tile.noteLines.length*32),Math.floor(frame.width),32).data;let dark=0;for(let offset=0;offset<data.length;offset+=4)if(data[offset]<80&&data[offset+1]<80&&data[offset+2]<80)dark++;
    return {wordComplete:wordLayout.tiles[0].noteLines.join('')===word,wordFits:wordLayout.tiles[0].noteLines.every(line=>measure.measureText(line).width<=wordLayout.tiles[0].notesFrame.width),pageCount:pages.length,parts:pages.map(layout=>[layout.tiles[0].notePart,layout.tiles[0].notePartCount]),text:pages.flatMap(layout=>layout.tiles[0].noteLines).join('\n'),uniqueCounts:pages.map(layout=>layout.totalReferences),samePhoto:pages.every(layout=>layout.tiles[0].group.reference.id===referenceId),bounded:pages.every(layout=>layout.height<=8192&&layout.width*layout.height<=32_000_000),lastLine:tile.noteLines.at(-1),dark,photo:window.pixel(output,tile.image.x+tile.image.width/2,tile.image.y+tile.image.height/2)};
  });
  assert.equal(result.wordComplete,true);assert.equal(result.wordFits,true);assert.ok(result.pageCount>1);
  assert.deepEqual(result.parts,Array.from({length:result.pageCount},(_,index)=>[index+1,result.pageCount]));assert.equal(result.text,'X\n'.repeat(999)+'Z');
  assert.deepEqual(result.uniqueCounts,Array(result.pageCount).fill(1));assert.equal(result.samePhoto,true);assert.equal(result.bounded,true);assert.equal(result.lastLine,'Z');assert.ok(result.dark>40);assert.deepEqual(result.photo,[255,0,0,255]);
});

test('board renders bounded separate composites at fitted reference resolution while preserving original image sources',async()=>{
  const result=await page.evaluate(async()=>{
    const {newProject,addRaster,addReference,addText,addDrawing,linkReference,referenceProject,updateReferenceAnnotations}=window.core;
    let {project}=addRaster(newProject(),window.fixture('#008000',4000,2000));project=addReference(project,window.fixture('#0000ff',6000,500));
    const reference=project.references[0],edited=addDrawing(referenceProject(reference),{mode:'pencil',color:'#ff0000',size:80,points:[[2900,250],[3100,250]]}).project;
    project=updateReferenceAnnotations(project,reference.id,edited.layers.filter(layer=>layer.kind!=='raster'));
    const label=addText(project,{content:'1',x:100,y:100,fontSize:80,width:160,height:130});project=linkReference(label.project,label.layerId,reference.id);
    const before=JSON.stringify(project),created=[],originalCreate=document.createElement;
    document.createElement=function(tag,...rest){const item=originalCreate.call(this,tag,...rest);if(tag==='canvas')created.push(item);return item;};
    let output;try{output=await window.board.renderReferenceBoard(project);}finally{document.createElement=originalCreate;}
    const layout=window.board.referenceBoardLayout(project),tile=layout.tiles[0],scale=tile.image.width/reference.width;
    return {buffers:created.filter(item=>item!==output).map(item=>[item.width,item.height]),wantedReferenceWidth:Math.ceil(tile.image.width),main:window.pixel(output,layout.main.x+layout.main.width/2,layout.main.y+layout.main.height/2),reference:window.pixel(output,tile.image.x+1000*scale,tile.image.y+250*scale),annotation:window.pixel(output,tile.image.x+3000*scale,tile.image.y+250*scale),stateSame:before===JSON.stringify(project),sourceSizes:[project.assets[project.original.assetId].width,project.assets[project.original.assetId].height,project.references[0].width,project.references[0].height]};
  });
  assert.ok(result.buffers.every(([width,height])=>width<=2600&&height<=2600),'No original-sized intermediate composite canvas is allocated');
  assert.ok(result.buffers.some(([width])=>width===result.wantedReferenceWidth),'Wide reference composite uses the fitted1856px bounds rather than a400px thumbnail');
  assert.deepEqual(result.main,[0,128,0,255]);assert.deepEqual(result.reference,[0,0,255,255]);assert.deepEqual(result.annotation,[255,0,0,255]);assert.equal(result.stateSame,true);assert.deepEqual(result.sourceSizes,[4000,2000,6000,500]);
});
