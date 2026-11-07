import {test,before,after} from 'node:test';
import assert from 'node:assert/strict';
import {chromium} from 'playwright';
import {createServer} from '../server.mjs';

let server,browser,page,errors=[];
before(async()=>{
  server=createServer();await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  browser=await chromium.launch({headless:true});page=await browser.newPage();
  page.on('pageerror',error=>errors.push(error.message));
  const base=`http://127.0.0.1:${server.address().port}`;
  page.on('request',request=>{if(!request.url().startsWith(base)&&!request.url().startsWith('data:')&&!request.url().startsWith('blob:'))errors.push('Remote request: '+request.url());});
  await page.goto(base+'/health');
  await page.evaluate(async()=>{
    window.c=await import('/core.mjs');window.b=await import('/reference-board.mjs');window.p=await import('/reference-pack.mjs');
    window.fixture=(color='#008000',width=240,height=160,name='Clean main.png')=>{const canvas=document.createElement('canvas');canvas.width=width;canvas.height=height;const context=canvas.getContext('2d');context.fillStyle=color;context.fillRect(0,0,width,height);return {name,source:canvas.toDataURL(),width,height};};
    window.main=()=>window.c.addRaster(window.c.newProject(),window.fixture()).project;
    window.comment=(project,content,text,patch={})=>{const added=window.c.addText(project,{content,x:15,y:20,width:50,height:50,fontSize:24,...patch});return {project:window.c.updateLabelComment(added.project,added.layerId,text),layerId:added.layerId};};
    window.ink=(canvas,frame,offset=1)=>{const data=canvas.getContext('2d').getImageData(Math.floor(frame.x),Math.floor(frame.y+offset*32),Math.floor(frame.width),32).data;let count=0;for(let i=0;i<data.length;i+=4)if(data[i]<80&&data[i+1]<80&&data[i+2]<80)count++;return count;};
  });
});
after(async()=>{try{assert.deepEqual(errors,[]);}finally{await browser?.close();if(server)await new Promise(resolve=>server.close(resolve));}});

function entriesOf(bytes){
  const data=Buffer.from(bytes),entries=new Map();let position=0;
  while(data.readUInt32LE(position)===0x04034b50){
    assert.equal(data.readUInt16LE(position+8),0,'Pack stores immutable original bytes without compression');
    const length=data.readUInt32LE(position+18),nameLength=data.readUInt16LE(position+26),extraLength=data.readUInt16LE(position+28);
    const name=data.subarray(position+30,position+30+nameLength).toString('utf8'),start=position+30+nameLength+extraLength;
    entries.set(name,data.subarray(start,start+length));position=start+length;
  }
  assert.equal(data.readUInt32LE(position),0x02014b50);
  return entries;
}

test('comment-only numbered board draws the instruction, saves/reopens identically and leaves source bytes unchanged',async()=>{
  const result=await page.evaluate(async()=>{
    const text='Remove the black bar.\nKeep the scene and reflections unchanged.\nCafé 日本 🌿';
    const source=window.fixture(),added=window.comment(window.main(),'1',text),project=added.project,before=JSON.stringify(project);
    const layout=window.b.referenceBoardLayout(project),tile=layout.tiles[0],output=await window.b.renderReferenceBoard(project),png=await window.b.exportReferenceBoard(project),bitmap=await createImageBitmap(png);
    const reopened=window.c.parseProject(window.c.serializeProject(project)),again=await window.b.renderReferenceBoard(reopened);
    const groups=window.b.linkedLabelComments(project);
    return {groups,photoGroups:window.b.linkedReferences(project).length,tiles:layout.tiles.length,kind:tile.kind,comment:tile.group.comment,lines:tile.noteLines,text,hasComments:layout.hasComments,totalComments:layout.totalComments,totalReferences:layout.totalReferences,background:[...output.getContext('2d').getImageData(tile.x+5,tile.y+5,1,1).data],ink:window.ink(output,tile.notesFrame),source:project.assets[project.original.assetId].source,expectedSource:source.source,same:output.toDataURL()===again.toDataURL(),type:png.type,size:[bitmap.width,bitmap.height],expectedSize:[layout.width,layout.height],stateSame:before===JSON.stringify(project)};
  });
  assert.equal(result.photoGroups,0);assert.equal(result.groups.length,1);assert.deepEqual(result.groups[0].labels,['1']);assert.equal(result.groups[0].comment,result.text);
  assert.equal(result.tiles,1);assert.equal(result.kind,'comment');assert.equal(result.comment,result.text);assert.equal(result.lines.join('\n'),result.text);assert.equal(result.hasComments,true);assert.equal(result.totalComments,1);assert.equal(result.totalReferences,0);
  assert.deepEqual(result.background,[255,244,229,255]);assert.ok(result.ink>100);assert.equal(result.same,true);assert.equal(result.stateSame,true);assert.equal(result.source,result.expectedSource);assert.equal(result.type,'image/png');assert.deepEqual(result.size,result.expectedSize);
});

test('mixed comments and multiple reference photos keep photo notes distinct and include exact instructions in pack mappings',async()=>{
  const result=await page.evaluate(async()=>{
    let project=window.main();const mainSource=project.assets[project.original.assetId].source;
    project=window.c.addReference(project,window.fixture('#ff0000',80,40,'Red original.png'));project=window.c.addReference(project,window.fixture('#0000ff',40,80,'Blue original.png'));
    const [red,blue]=project.references;project=window.c.updateReferenceNotes(project,red.id,'Use only the snow caps.');
    let added=window.comment(project,'1','Replace the grass only.\nPreserve the driveway.');project=window.c.linkReferences(added.project,added.layerId,[red.id,blue.id]);
    added=window.comment(project,'2','Remove the black bar. No replacement photo is needed.');project=added.project;
    const before=JSON.stringify(project),layout=window.b.referenceBoardLayout(project),output=await window.b.renderReferenceBoard(project),direct=await window.b.exportReferenceBoard(project),zip=await window.p.exportCompleteReferencePack(project);
    const tiles=layout.tiles.map(tile=>({kind:tile.kind,label:tile.group.labels,comment:tile.group.comment||'',photoNotes:tile.group.reference?.notes||'',noteLines:tile.noteLines,background:[...output.getContext('2d').getImageData(tile.x+5,tile.y+5,1,1).data],ink:tile.notesFrame?window.ink(output,tile.notesFrame):null}));
    return {zip:[...new Uint8Array(await zip.arrayBuffer())],direct:[...new Uint8Array(await direct.arrayBuffer())],mainSource,refs:project.references.map(ref=>({id:ref.id,source:ref.source})),tiles,totalComments:layout.totalComments,totalReferences:layout.totalReferences,stateSame:before===JSON.stringify(project)};
  });
  const entries=entriesOf(result.zip),mapping=JSON.parse(entries.get('mapping.json').toString('utf8')),readme=entries.get('README.txt').toString('utf8');
  assert.deepEqual(mapping.numbers.map(number=>[number.label,number.references.length]),[['1',2],['2',0]]);
  assert.equal(mapping.numbers[0].comment,'Replace the grass only.\nPreserve the driveway.');assert.equal(mapping.numbers[1].comment,'Remove the black bar. No replacement photo is needed.');assert.equal(mapping.numbers[0].references[0].notes,'Use only the snow caps.');
  assert.ok(readme.includes(mapping.numbers[0].comment));assert.ok(readme.includes(mapping.numbers[1].comment));assert.match(readme,/instruction only \(no reference photos\)/);
  assert.deepEqual(entries.get(mapping.cleanMain.path),Buffer.from(result.mainSource.split(',')[1],'base64'));assert.deepEqual(entries.get(mapping.generatedPreviews[0].path),Buffer.from(result.direct));
  for(const ref of mapping.numbers[0].references)assert.deepEqual(entries.get(ref.path),Buffer.from(result.refs.find(original=>original.id===ref.referenceId).source.split(',')[1],'base64'));
  assert.deepEqual(result.tiles.map(tile=>tile.kind),['photo','photo','comment','comment']);assert.equal(result.tiles[0].photoNotes,'Use only the snow caps.');assert.equal(result.tiles[2].comment,mapping.numbers[0].comment);assert.equal(result.totalComments,2);assert.equal(result.totalReferences,2);assert.ok(result.tiles.filter(tile=>tile.kind==='comment').every(tile=>tile.ink>100));assert.equal(result.stateSame,true);
});

test('comment-only complete pack has zero references, a numbered board and byte-exact clean MAIN',async()=>{
  const result=await page.evaluate(async()=>{
    const added=window.comment(window.main(),'7','Only remove the black bar; preserve all other scene details.'),project=added.project;
    const zip=await window.p.exportCompleteReferencePack(project),direct=await window.b.exportReferenceBoard(project);
    return {zip:[...new Uint8Array(await zip.arrayBuffer())],direct:[...new Uint8Array(await direct.arrayBuffer())],source:project.assets[project.original.assetId].source,layerId:added.layerId};
  });
  const entries=entriesOf(result.zip),mapping=JSON.parse(entries.get('mapping.json').toString());
  assert.equal(mapping.numbers.length,1);assert.equal(mapping.numbers[0].label,'7');assert.equal(mapping.numbers[0].comment,'Only remove the black bar; preserve all other scene details.');assert.deepEqual(mapping.numbers[0].references,[]);assert.deepEqual(mapping.numbers[0].layerIds,[result.layerId]);assert.deepEqual(mapping.unassignedReferences,[]);
  assert.deepEqual(entries.get(mapping.cleanMain.path),Buffer.from(result.source.split(',')[1],'base64'));assert.deepEqual(entries.get(mapping.generatedPreviews[0].path),Buffer.from(result.direct));assert.equal(entries.size,4);assert.ok(entries.has('README.txt'));
});

test('long Unicode words and newline-heavy comments paginate without omitted characters or cut-off final lines',async()=>{
  const result=await page.evaluate(async()=>{
    const word='Ω日本🌿'.repeat(150),text='X\n'.repeat(999)+'Z';
    const wordProject=window.comment(window.main(),'1',word).project,wordLayout=window.b.referenceBoardLayout(wordProject),measure=document.createElement('canvas').getContext('2d');measure.font='24px Arial';
    const project=window.comment(window.main(),'2',text).project,pages=window.b.referenceBoardPages(project),last=pages.at(-1),tile=last.tiles[0],output=await window.b.renderReferenceBoard(project,undefined,last.page),blobs=await window.b.exportReferenceBoards(project),pack=await window.p.completeReferencePackFiles(project);
    return {word,wordLines:wordLayout.tiles[0].noteLines,wordFits:wordLayout.tiles[0].noteLines.every(line=>measure.measureText(line).width<=wordLayout.tiles[0].notesFrame.width),text,exportedText:pages.flatMap(layout=>layout.tiles[0].noteLines).join('\n'),pageCount:pages.length,blobCount:blobs.length,packBoardCount:pack.mapping.generatedPreviews.length,packComment:pack.mapping.numbers[0].comment,parts:pages.map(layout=>[layout.tiles[0].notePart,layout.tiles[0].notePartCount]),bounded:pages.every(layout=>layout.height<=8192&&layout.width*layout.height<=32_000_000&&layout.tiles[0].notesFrame.y+layout.tiles[0].notesFrame.height<=layout.tiles[0].y+layout.tiles[0].height),lastLine:tile.noteLines.at(-1),ink:window.ink(output,tile.notesFrame,tile.noteLines.length),totals:pages.map(layout=>[layout.totalReferences,layout.totalComments])};
  });
  assert.equal(result.wordLines.join(''),result.word);assert.equal(result.wordFits,true);assert.equal(result.exportedText,result.text);assert.ok(result.pageCount>1);assert.equal(result.blobCount,result.pageCount);assert.equal(result.packBoardCount,result.pageCount);assert.equal(result.packComment,result.text);assert.deepEqual(result.parts,Array.from({length:result.pageCount},(_,index)=>[index+1,result.pageCount]));assert.equal(result.bounded,true);assert.equal(result.lastLine,'Z');assert.ok(result.ink>40);assert.deepEqual(result.totals,Array.from({length:result.pageCount},()=>[0,1]));
});

test('identical duplicate labels dedupe comments but conflicting comments or photo assignments stop board and pack exports',async()=>{
  const result=await page.evaluate(async()=>{
    let project=window.main(),first=window.comment(project,' 3 ','Remove only the black bar.');project=first.project;const second=window.comment(project,'3','Remove only the black bar.',{x:90});project=second.project;
    const layout=window.b.referenceBoardLayout(project),mapping=(await window.p.completeReferencePackFiles(project)).mapping;
    const conflicting=window.c.updateLabelComment(project,second.layerId,'Replace the black bar instead.');
    let photoConflict=window.c.addReference(project,window.fixture('#ff0000'));photoConflict=window.c.linkReference(photoConflict,second.layerId,photoConflict.references[0].id);
    const failures=[];for(const candidate of [conflicting,photoConflict])for(const exporter of [window.b.exportReferenceBoard,window.p.exportCompleteReferencePack]){const before=JSON.stringify(candidate);try{await exporter(candidate);failures.push(null);}catch(error){failures.push({message:error.message,unchanged:before===JSON.stringify(candidate)});}}
    return {tiles:layout.tiles.length,groups:window.b.linkedLabelComments(project),number:mapping.numbers[0],failures};
  });
  assert.equal(result.tiles,1);assert.equal(result.groups.length,1);assert.equal(result.groups[0].layerIds.length,2);assert.equal(result.number.layerIds.length,2);assert.deepEqual(result.number.literalLabels,[' 3 ','3']);assert.equal(result.number.comment,'Remove only the black bar.');assert.ok(result.failures.every(failure=>failure?.unchanged));assert.ok(result.failures.slice(0,2).every(failure=>/different instructions/.test(failure.message)));assert.ok(result.failures.slice(2).every(failure=>/different photos/.test(failure.message)));
});

test('hidden, transparent, off-canvas and blank comments are excluded; removing comment restores absent-export state',async()=>{
  const result=await page.evaluate(async()=>{
    let project=window.main();for(const patch of [{visible:false},{opacity:0},{x:240},{x:-50}]){const added=window.comment(project,'hidden','Do not export this.',patch);project=window.c.updateLayer(added.project,added.layerId,patch);}
    let added=window.comment(project,'blank','   ');project=added.project;const groups=window.b.linkedLabelComments(project),failures=[];
    for(const exporter of [window.b.exportReferenceBoard,window.p.exportCompleteReferencePack])try{await exporter(project);}catch(error){failures.push(error.message);}
    added=window.comment(project,'5','Visible instruction.');project=added.project;const visibleGroups=window.b.linkedLabelComments(project).length;project=window.c.updateLabelComment(project,added.layerId,'');
    return {groups,failures,visibleGroups,removedGroups:window.b.linkedLabelComments(project).length};
  });
  assert.deepEqual(result.groups,[]);assert.equal(result.failures.length,2);assert.ok(result.failures.every(message=>/visible/.test(message)));assert.equal(result.visibleGroups,1);assert.equal(result.removedGroups,0);
});
