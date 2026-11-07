import {test} from 'node:test';
import assert from 'node:assert/strict';
import {deflateSync} from 'node:zlib';
import {createHash} from 'node:crypto';
import {newProject,addRaster,addText,addDrawing,addReference,updateLayer,addMaskStroke,attachObjectRegion,linkReferences,updateLabelComment,updateReferenceNotes,updateReferenceAnnotations,saveVariant,restoreVariant,serializeProject,parseProject,History,validateProject} from '../public/core.mjs';
import {objectRegionBounds} from '../public/object-regions.mjs';
import {originalBlob} from '../public/image-source.mjs';
import {canvasImageFitTarget,canvasImageFitChanges,fitCanvasToImage} from '../public/canvas-fit.mjs';

function crc(bytes){let value=0xffffffff;for(const byte of bytes){value^=byte;for(let bit=0;bit<8;bit++)value=(value>>>1)^((value&1)?0xedb88320:0);}return(value^0xffffffff)>>>0;}
function chunk(type,bytes){const name=Buffer.from(type),length=Buffer.alloc(4),checksum=Buffer.alloc(4);length.writeUInt32BE(bytes.length);checksum.writeUInt32BE(crc(Buffer.concat([name,bytes])));return Buffer.concat([length,name,bytes,checksum]);}
function image(width=800,height=600,name='Original.png'){
  const header=Buffer.alloc(13);header.writeUInt32BE(width);header.writeUInt32BE(height,4);header[8]=8;header[9]=2;
  const pixels=Buffer.alloc((width*3+1)*height,96);for(let row=0;row<height;row++)pixels[row*(width*3+1)]=0;
  const bytes=Buffer.concat([Buffer.from([137,80,78,71,13,10,26,10]),chunk('IHDR',header),chunk('IDAT',deflateSync(pixels)),chunk('IEND',Buffer.alloc(0))]);
  return {name,width,height,source:'data:image/png;base64,'+bytes.toString('base64'),originalFile:{name,mimeType:'image/png',byteLength:bytes.length}};
}
const main=image(),reference=image(120,90,'Reference.png'),preview=image(160,120,'Generated preview.png');
main.preview={kind:'generated-thumbnail',width:160,height:120,source:preview.source};
function fixture(){
  const raster=addRaster(newProject(),main),text=addText(raster.project,{content:'1',fontSize:30,color:'#eba76f',x:240,y:180,width:60,height:45});
  let project=attachObjectRegion(text.project,text.layerId,{version:1,assetId:raster.project.layers[0].assetId,rasterLayerId:raster.layerId,sourceWidth:800,sourceHeight:600,mask:{width:4,height:3,counts:[5,2,5]}});
  project=updateLabelComment(project,text.layerId,'Keep the object and preserve the whole scene.');
  const drawing=addDrawing(project,{mode:'pencil',color:'#ffff00',size:8,points:[[240,180],[360,210],[340,280]]});project=drawing.project;
  project=addMaskStroke(project,raster.layerId,{mode:'hide',size:24,points:[[10,20],[30,40]]});
  project=addReference(project,reference);project=linkReferences(project,text.layerId,[project.references[0].id]);project=updateReferenceNotes(project,project.references[0].id,'Use only its surface texture.');
  const refText=addText(newProject(120,90),{content:'A',fontSize:12,color:'#ff0000',x:12,y:10,width:20,height:18}).project.layers;
  project=updateReferenceAnnotations(project,project.references[0].id,refText);project.prompt='Preserve the camera.';project=saveVariant(project,'Before fit');
  return {project,rasterId:raster.layerId,textId:text.layerId,drawingId:drawing.layerId};
}
function freeze(value){if(value&&typeof value==='object'&&!Object.isFrozen(value)){Object.freeze(value);for(const child of Object.values(value))freeze(child);}return value;}
function geometry(layer){return {x:layer.x,y:layer.y,width:layer.width,height:layer.height};}
function near(actual,expected){assert.ok(Math.abs(actual-expected)<1e-9,`${actual} must equal ${expected}`);}

test('eligibility chooses a selected visible photo or the sole photo among editable annotations',()=>{
  const {project,rasterId,textId}=fixture();
  assert.equal(canvasImageFitTarget(project,rasterId).id,rasterId);
  assert.equal(canvasImageFitTarget(project,textId).id,rasterId);
  assert.equal(canvasImageFitTarget(project,null).id,rasterId);
  assert.equal(canvasImageFitTarget(newProject(),null),null);
  const other=addRaster(project,image(100,100,'Another.png'));
  assert.equal(canvasImageFitTarget(other.project,null),null);
  assert.equal(canvasImageFitTarget(other.project,textId),null);
  assert.equal(canvasImageFitTarget(other.project,other.layerId).id,other.layerId);
  const hidden=updateLayer(project,rasterId,{visible:false}),transparent=updateLayer(project,rasterId,{opacity:0});
  assert.equal(canvasImageFitTarget(hidden,rasterId),null);assert.equal(canvasImageFitTarget(transparent,null),null);
});

test('fitting a padded canvas restores native size, translates all current layers and preserves source-bound content',()=>{
  const {project,rasterId}=fixture();let padded=structuredClone(project);padded.width=1400;padded.height=1000;
  padded.layers.forEach(layer=>{layer.x+=123;layer.y+=67;});validateProject(padded);
  const before=serializeProject(padded),fitted=fitCanvasToImage(freeze(padded),rasterId);
  assert.deepEqual([fitted.width,fitted.height],[800,600]);
  assert.deepEqual(fitted.layers.map(geometry),project.layers.map(geometry));
  for(let index=0;index<fitted.layers.length;index++){
    const {x,y,width,height,...rest}=fitted.layers[index],{x:a,y:b,width:c,height:d,...saved}=padded.layers[index];assert.deepEqual(rest,saved);
  }
  assert.deepEqual(fitted.assets,padded.assets);assert.deepEqual(fitted.original,padded.original);assert.deepEqual(fitted.references,padded.references);assert.deepEqual(fitted.variants,padded.variants);assert.equal(fitted.prompt,padded.prompt);assert.equal(fitted.version,padded.version);assert.equal(serializeProject(padded),before);
  assert.deepEqual(objectRegionBounds(fitted,fitted.layers[1]),objectRegionBounds(project,project.layers[1]));
});

test('fractional uniform transforms fit without rounding borders and retain exact annotation alignment',()=>{
  const {project,rasterId}=fixture(),scaled=structuredClone(project),scale=.73125,offsetX=31.375,offsetY=-8.125;
  scaled.width=1200;scaled.height=900;
  scaled.layers.forEach(layer=>{layer.x=layer.x*scale+offsetX;layer.y=layer.y*scale+offsetY;layer.width*=scale;layer.height*=scale;});validateProject(scaled);
  const fitted=fitCanvasToImage(scaled,rasterId);
  assert.deepEqual(geometry(fitted.layers[0]),{x:0,y:0,width:800,height:600});assert.deepEqual([fitted.width,fitted.height],[800,600]);
  fitted.layers.forEach((layer,index)=>Object.entries(geometry(layer)).forEach(([key,value])=>near(value,project.layers[index][key])));
  assert.deepEqual(fitted.layers[1].text,project.layers[1].text);assert.deepEqual(fitted.layers[2].drawing,project.layers[2].drawing);assert.deepEqual(fitted.layers[0].mask,project.layers[0].mask);assert.deepEqual(fitted.layers[1].objectRegion,project.layers[1].objectRegion);
});

test('native aspect restoration maps a skewed photo and all annotation transforms together',()=>{
  const {project,rasterId}=fixture(),skewed=structuredClone(project),scaleX=.625,scaleY=1.2;
  skewed.width=1400;skewed.height=1000;
  skewed.layers.forEach(layer=>{layer.x=layer.x*scaleX-14.5;layer.y=layer.y*scaleY+42.25;layer.width*=scaleX;layer.height*=scaleY;});validateProject(skewed);
  const fitted=fitCanvasToImage(skewed,rasterId);assert.deepEqual(geometry(fitted.layers[0]),{x:0,y:0,width:800,height:600});
  fitted.layers.forEach((layer,index)=>Object.entries(geometry(layer)).forEach(([key,value])=>near(value,project.layers[index][key])));
  assert.equal(fitted.width/fitted.height,main.width/main.height);assert.deepEqual(fitted.references,skewed.references);assert.deepEqual(fitted.variants,skewed.variants);
});

test('fitting a selected photo among several changes only current geometry and preserves editable outside content',()=>{
  const {project,rasterId}=fixture(),other=addRaster(project,image(1200,900,'Selected.png'));
  const selected=updateLayer(other.project,other.layerId,{x:100,y:75,width:400,height:300}),before=structuredClone(selected),fitted=fitCanvasToImage(selected,other.layerId);
  assert.deepEqual([fitted.width,fitted.height],[1200,900]);assert.deepEqual(geometry(fitted.layers.at(-1)),{x:0,y:0,width:1200,height:900});
  assert.deepEqual(geometry(fitted.layers[0]),{x:-300,y:-225,width:2400,height:1800});assert.equal(fitted.layers[0].id,rasterId);
  assert.equal(fitted.layers.length,selected.layers.length);assert.deepEqual(fitted.original,selected.original);assert.deepEqual(fitted.assets,selected.assets);assert.deepEqual(fitted.variants,selected.variants);assert.deepEqual(selected,before);
});

test('original files remain byte-identical across fit, serialization, undo redo and saved variant restoration',async()=>{
  const {project,rasterId}=fixture(),padded=structuredClone(project);padded.width=1200;padded.height=900;padded.layers.forEach(layer=>{layer.x+=120;layer.y+=90;});
  const fitted=fitCanvasToImage(padded,rasterId),reopened=parseProject(serializeProject(fitted)),history=new History(padded);
  assert.equal(history.commit(fitted,'Fit canvas to image'),true);assert.deepEqual(history.undo(),padded);assert.deepEqual(history.redo(),fitted);assert.deepEqual(reopened,fitted);
  const digest=async asset=>createHash('sha256').update(Buffer.from(await originalBlob(asset).arrayBuffer())).digest('hex');
  assert.equal(await digest(reopened.assets[reopened.original.assetId]),await digest(main));assert.equal(await digest(reopened.references[0]),await digest(reference));
  const restored=restoreVariant(reopened,reopened.variants[0].id);assert.deepEqual(restored.layers,project.layers);assert.deepEqual([restored.width,restored.height],[800,600]);assert.deepEqual(restored.assets,project.assets);assert.deepEqual(restored.references,project.references);
});

test('an already fitted photo is an identity no-op and does not create history',()=>{
  const {project,rasterId}=fixture(),history=new History(project);
  assert.equal(canvasImageFitChanges(project,rasterId),false);assert.equal(fitCanvasToImage(freeze(project),rasterId),project);assert.equal(history.commit(project,'Fit canvas to image'),false);
  const padded={...project,width:801};assert.equal(canvasImageFitChanges(padded,rasterId),true);assert.equal(canvasImageFitChanges(project,'missing'),false);
});

test('missing, invalid or unavailable sources and invalid target choices are rejected without mutation',()=>{
  const {project,rasterId,textId}=fixture(),sourceId=project.layers[0].assetId;
  for(const mutate of [value=>delete value.assets[sourceId],value=>value.assets[sourceId].source='https://example.com/image.png',value=>value.assets[sourceId].source='data:image/png;base64,AAAA',value=>value.assets[sourceId].width=9000,value=>value.assets[sourceId].originalFile.byteLength++,value=>value.layers[0].visible=false,value=>value.layers[0].opacity=0]){
    const invalid=structuredClone(project);mutate(invalid);const before=JSON.stringify(invalid);assert.equal(canvasImageFitTarget(invalid,rasterId),null);assert.equal(canvasImageFitChanges(invalid,rasterId),false);assert.throws(()=>fitCanvasToImage(invalid,rasterId));assert.equal(JSON.stringify(invalid),before);
  }
  assert.throws(()=>fitCanvasToImage(project,textId),/visible image layer/);assert.throws(()=>fitCanvasToImage(project,'missing'),/visible image layer/);assert.deepEqual(project,parseProject(serializeProject(project)));
  const metadataChanged=structuredClone(project);assert.ok(canvasImageFitTarget(metadataChanged,rasterId));metadataChanged.assets[sourceId].originalFile.byteLength++;assert.equal(canvasImageFitTarget(metadataChanged,rasterId),null,'Eligibility does not reuse a cached source check after same-object metadata changes');
});

test('fits that exceed editable transform limits are rejected rather than rounding or clamping layers',()=>{
  const {project,rasterId,textId}=fixture();
  for(const patch of [{width:1,height:1},{width:32768,height:32768},{x:999000,y:999000}]){
    let invalid=updateLayer(project,rasterId,patch);
    if(patch.x)invalid=updateLayer(invalid,textId,{x:-999999,y:-999999});
    const before=serializeProject(invalid);assert.equal(canvasImageFitTarget(invalid,rasterId),null);assert.equal(canvasImageFitChanges(invalid,rasterId),false);assert.throws(()=>fitCanvasToImage(invalid,rasterId),/beyond the editor limits/);assert.equal(serializeProject(invalid),before);
  }
});
