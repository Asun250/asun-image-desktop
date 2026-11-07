import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {deflateSync} from 'node:zlib';
import {newProject,addRaster,addText,attachObjectRegion,updateLabelComment} from '../public/core.mjs';
import {objectRemovalRequest} from '../public/object-removal-request.mjs';
import {imageGenerationCanvasDimensions,imageGenerationPreviewDimensions} from '../public/image-generation-request.mjs';
import {prepareImageRequest} from '../desktop-image-request.mjs';
import {planGenerationInputPacking} from '../public/generation-input-packing.mjs';

function png(width,height,color=128) {
  const crc=bytes=>{let value=0xffffffff;for(const byte of bytes){value^=byte;for(let i=0;i<8;i++)value=(value>>>1)^((value&1)?0xedb88320:0);}return(value^0xffffffff)>>>0;};
  const chunk=(kind,bytes)=>{const content=Buffer.concat([Buffer.from(kind),bytes]),length=Buffer.alloc(4),check=Buffer.alloc(4);length.writeUInt32BE(bytes.length);check.writeUInt32BE(crc(content));return Buffer.concat([length,content,check]);};
  const header=Buffer.alloc(13);header.writeUInt32BE(width);header.writeUInt32BE(height,4);header[8]=8;header[9]=2;
  const row=Buffer.alloc(width*3+1,color);row[0]=0;
  return Buffer.concat([Buffer.from([137,80,78,71,13,10,26,10]),chunk('IHDR',header),chunk('IDAT',deflateSync(Buffer.concat(Array.from({length:height},()=>row)))),chunk('IEND',Buffer.alloc(0))]);
}
const photo=(width,height,color=128)=>({name:'Native canvas.png',width,height,source:'data:image/png;base64,'+png(width,height,color).toString('base64')});
function fixture(width=1536,height=1024) {
  const composition=photo(width,height);let project=addRaster(newProject(width,height),composition).project;
  const label=addText(project,{content:'1',x:0,y:0,width:60,height:80,fontSize:32});
  project=attachObjectRegion(label.project,label.layerId,{version:1,assetId:project.original.assetId,rasterLayerId:project.layers[0].id,sourceWidth:width,sourceHeight:height,mask:{width:16,height:16,counts:[0,1,254,1]},group:{areaCount:2}});
  project=updateLabelComment(project,label.layerId,'Change only these two selected objects.');project.imageOutput={version:1,aspect:'9:16'};
  return {project,labelId:label.layerId,composition,request:{requestId:randomUUID(),model:'gpt-image-2.5-sunburst',quality:'max',project,composition,guide:composition,areaMasks:[{id:label.layerId,image:photo(width,height,255)}]}};
}

test('selected edits and remove-fill preserve exact canvas pixels despite a remembered portrait preference',()=>{
  const f=fixture(),before=JSON.stringify(f.project);
  for(const project of [f.project,objectRemovalRequest(f.project,[f.labelId])]){
    const prepared=prepareImageRequest({...f.request,project});assert.equal(prepared.size,'1536x1024');assert.equal(prepared.quality,'max');assert.equal(prepared.model,'gpt-image-2.5-sunburst');
    assert.equal(prepared.images[0].width,1536);assert.equal(prepared.images[0].height,1024);assert.deepEqual(prepared.images[0].bytes,png(1536,1024));
    assert.match(prepared.prompt,/1536 × 1024/);assert.equal(project.imageOutput.aspect,'9:16');
  }
  assert.equal(JSON.stringify(f.project),before);
});

test('native large edit inputs are required rather than old 2600px composition or masks',()=>{
  const f=fixture(2160,3840),prepared=prepareImageRequest(f.request);assert.equal(prepared.size,'2160x3840');assert.deepEqual(imageGenerationCanvasDimensions(f.project),{width:2160,height:3840});
  assert.deepEqual(imageGenerationPreviewDimensions(2160,3840),{width:1463,height:2600});
  const reduced=photo(1463,2600);
  assert.throws(()=>prepareImageRequest({...f.request,composition:reduced}),/composition.*canvas dimensions/i);
  assert.throws(()=>prepareImageRequest({...f.request,guide:reduced}),/annotation guide.*canvas dimensions/i);
  assert.throws(()=>prepareImageRequest({...f.request,areaMasks:[{id:f.labelId,image:reduced}]}),/selection mask.*canvas dimensions/i);
});

test('unsupported exact edit dimensions fail before attempting to decode missing input previews',()=>{
  const f=fixture(1080,1920);
  assert.throws(()=>prepareImageRequest({...f.request,composition:null,guide:null,areaMasks:[]}),error=>/1080|16|exact|unsupported/i.test(error.message)&&!/composition image.*missing/i.test(error.message));
  const older=fixture(2160,3840);
  assert.throws(()=>prepareImageRequest({...older.request,model:'gpt-image-1.5',quality:'high',composition:null,guide:null,areaMasks:[]}),error=>/1024.*1536|exact|unsupported/i.test(error.message)&&!/composition image.*missing/i.test(error.message));
});

test('area selection masks never move into reference boards; excessive mandatory inputs fail without omissions',()=>{
  const images=Array.from({length:24},()=>({width:1536,height:1024})),roles=[{image:1,role:'current composition'},{image:2,role:'canvas annotation guide'},...[3,4,5,6].map(image=>({image,role:'area selection mask'}))];
  const plan=planGenerationInputPacking(images,roles);assert.equal(plan.packed,true);for(const index of [1,2,3,4,5,6])assert.ok(plan.slots.some(slot=>slot.kind==='single'&&slot.sourceIndex===index));
  assert.throws(()=>planGenerationInputPacking(images,Array.from({length:17},(_,index)=>({image:index+1,role:'area selection mask'}))),/Too many.*inputs/i);
});
