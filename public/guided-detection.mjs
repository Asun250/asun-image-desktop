// Guided selections are generated from clean source crops. Marks and uploaded
// source bytes remain editable, separate project data throughout this workflow.
import {decodeImage} from './render.mjs';
import {MAX_REGION_SIDE,MAX_REGION_RUNS,validateDetectionResult,rasterPointVisible} from './object-regions.mjs';
import {sketchSurface,sketchContentSignature,sketchWorkingCopy} from './sketch-detection.mjs';
import {documentPointToLayer,layerPointToDocument,layerBounds,normalizeRotation} from './layer-transform.mjs';

const finite=value=>typeof value==='number'&&Number.isFinite(value);
const clamp=(value,min,max)=>Math.max(min,Math.min(max,value));
const requireThat=(condition,message)=>{if(!condition)throw new Error(message);};
const identifier=()=>`guided-${globalThis.crypto.randomUUID()}`;
function intersection(a,b) {
  const x=Math.max(a.x,b.x),y=Math.max(a.y,b.y),right=Math.min(a.x+a.width,b.x+b.width),bottom=Math.min(a.y+a.height,b.y+b.height);
  return right>x&&bottom>y?{x,y,width:right-x,height:bottom-y}:null;
}
function drawingBounds(mark) {
  const drawing=mark?.drawing;
  if(mark?.kind!=='drawing'||!['pencil','highlight'].includes(drawing?.mode)||!mark.visible||!(mark.opacity>0)||!drawing.points?.length||!(drawing.baseWidth>0)||!(drawing.baseHeight>0)||!(mark.width>0)||!(mark.height>0)||!(drawing.size>0))return null;
  const sx=mark.width/drawing.baseWidth,sy=mark.height/drawing.baseHeight;
  let minX=Infinity,minY=Infinity,maxX=-Infinity,maxY=-Infinity;
  for(const point of drawing.points) {
    if(!Array.isArray(point)||point.length!==2||!point.every(finite))return null;
    const {x,y}=layerPointToDocument(mark,{x:point[0]*sx,y:point[1]*sy});
    minX=Math.min(minX,x);minY=Math.min(minY,y);maxX=Math.max(maxX,x);maxY=Math.max(maxY,y);
  }
  const angle=normalizeRotation(mark.rotation??0)*Math.PI/180,cos=Math.cos(angle),sin=Math.sin(angle);
  const rx=Math.hypot(drawing.size*sx/2*cos,drawing.size*sy/2*sin),ry=Math.hypot(drawing.size*sx/2*sin,drawing.size*sy/2*cos);
  return {x:minX-rx,y:minY-ry,width:maxX-minX+rx*2,height:maxY-minY+ry*2};
}
function clipToRaster(bounds,raster){
  let polygon=[{x:bounds.x,y:bounds.y},{x:bounds.x+bounds.width,y:bounds.y},{x:bounds.x+bounds.width,y:bounds.y+bounds.height},{x:bounds.x,y:bounds.y+bounds.height}].map(point=>documentPointToLayer(raster,point));
  for(const [key,limit,less]of [['x',0,false],['x',raster.width,true],['y',0,false],['y',raster.height,true]]){
    const output=[],inside=point=>less?point[key]<=limit:point[key]>=limit;
    for(let i=0;i<polygon.length;i++){
      const a=polygon[i],b=polygon[(i+1)%polygon.length],aIn=inside(a),bIn=inside(b);
      if(aIn)output.push(a);
      if(aIn!==bIn){const t=(limit-a[key])/(b[key]-a[key]);output.push({x:a.x+(b.x-a.x)*t,y:a.y+(b.y-a.y)*t});}
    }
    polygon=output;if(!polygon.length)return null;
  }
  let twiceArea=0;for(let i=0;i<polygon.length;i++){const a=polygon[i],b=polygon[(i+1)%polygon.length];twiceArea+=a.x*b.y-b.x*a.y;}
  if(Math.abs(twiceArea)<1e-8)return null;
  const xs=polygon.map(point=>point.x),ys=polygon.map(point=>point.y);
  return {x:Math.min(...xs),y:Math.min(...ys),width:Math.max(...xs)-Math.min(...xs),height:Math.max(...ys)-Math.min(...ys)};
}
function visibleOverlap(project,raster,bounds) {
  if(!raster.mask?.length)return true;
  // Targeting is limited to the source's visible part. Sample at working-copy
  // resolution, with extra edge/center samples for small or narrow marked areas.
  const asset=project.assets[raster.assetId],scale=Math.min(1,MAX_REGION_SIDE/Math.max(asset.width,asset.height));
  const columns=Math.max(1,Math.min(80,Math.ceil(bounds.width*asset.width/raster.width*scale)));
  const rows=Math.max(1,Math.min(80,Math.ceil(bounds.height*asset.height/raster.height*scale)));
  for(let y=0;y<rows;y++)for(let x=0;x<columns;x++) {
    if(rasterPointVisible(project,raster,{x:bounds.x+(x+.5)*bounds.width/columns,y:bounds.y+(y+.5)*bounds.height/rows}))return true;
  }
  return false;
}

export function guidedMarkTarget(project,drawingId) {
  const index=project.layers.findIndex(layer=>layer.id===drawingId),mark=project.layers[index],markBounds=drawingBounds(mark);
  if(!markBounds)return null;
  // Pencil is scene artwork in the sketch workspace. Highlights are the
  // explicit selection guides; photo editing retains its pencil-loop tool.
  if(project.sketch&&mark.drawing.mode!=='highlight')return null;
  const onBoard=intersection(markBounds,{x:0,y:0,width:project.width,height:project.height});if(!onBoard)return null;
  // Photos target the closest source below the mark. Sketch marks target the
  // complete drawing page, including editable strokes and placed photos.
  const surface=sketchSurface(project);
  if(project.sketch&&!surface)return null;
  const candidates=surface?[surface]:project.layers.slice(0,index).reverse();
  for(const raster of candidates) {
    const asset=project.assets[raster.assetId];
    if(raster.kind!=='raster'||!raster.visible||!(raster.opacity>0)||!asset||!(raster.width>0)||!(raster.height>0))continue;
    const overlap=intersection(onBoard,layerBounds(raster)),local=overlap&&clipToRaster(overlap,raster);if(!local||!visibleOverlap(project,raster,overlap))continue;
    const left=clamp(local.x*asset.width/raster.width,0,asset.width),top=clamp(local.y*asset.height/raster.height,0,asset.height);
    const right=clamp((local.x+local.width)*asset.width/raster.width,0,asset.width),bottom=clamp((local.y+local.height)*asset.height/raster.height,0,asset.height);
    if(!(right>left&&bottom>top))continue;
    const marginX=Math.max(32,right-left),marginY=Math.max(32,bottom-top);
    const x=Math.max(0,Math.floor(left-marginX)),y=Math.max(0,Math.floor(top-marginY));
    const cropRight=Math.min(asset.width,Math.ceil(right+marginX)),cropBottom=Math.min(asset.height,Math.ceil(bottom+marginY));
    return {mark,raster,asset,markBounds,sourceBox:[left,top,right,bottom],crop:{x,y,width:cropRight-x,height:cropBottom-y},sketch:Boolean(surface)};
  }
  return null;
}

export async function guidedWorkingCopy(project,drawingId) {
  const target=guidedMarkTarget(project,drawingId);
  requireThat(target,'Select a visible Pencil or Highlight mark over an image before detecting the marked area.');
  const {mark,raster,asset,sourceBox,crop,sketch}=target;
  // Capture identities before image decoding yields. An edit during decoding
  // must not make an old crop appear to belong to the newly transformed mark.
  const markSnapshot=structuredClone(mark),rasterSnapshot=structuredClone(raster),source=sketch?sketchContentSignature(project):asset.source;
  const rendered=sketch?await sketchWorkingCopy(project,{crop,maxSide:MAX_REGION_SIDE}):null;
  const image=await decodeImage(rendered?.source||asset.source);
  requireThat(sketch||(image.naturalWidth===asset.width&&image.naturalHeight===asset.height),'The marked image does not match its saved original dimensions.');
  const scale=Math.min(1,MAX_REGION_SIDE/Math.max(crop.width,crop.height)),canvas=document.createElement('canvas');
  canvas.width=Math.max(1,Math.round(crop.width*scale));canvas.height=Math.max(1,Math.round(crop.height*scale));
  const context=canvas.getContext('2d');context.fillStyle='#fff';context.fillRect(0,0,canvas.width,canvas.height);
  if(sketch)context.drawImage(image,0,0,canvas.width,canvas.height);
  else context.drawImage(image,crop.x,crop.y,crop.width,crop.height,0,0,canvas.width,canvas.height);
  const sx=canvas.width/crop.width,sy=canvas.height/crop.height;
  const box=[clamp((sourceBox[0]-crop.x)*sx,0,canvas.width),clamp((sourceBox[1]-crop.y)*sy,0,canvas.height),clamp((sourceBox[2]-crop.x)*sx,0,canvas.width),clamp((sourceBox[3]-crop.y)*sy,0,canvas.height)];
  requireThat(box[2]>box[0]&&box[3]>box[1],'The marked area falls outside the source image.');
  return {request:{source:canvas.toDataURL('image/png'),width:canvas.width,height:canvas.height,prompt:{box}},rasterId:rasterSnapshot.id,assetId:asset.id,source,markId:markSnapshot.id,markSnapshot,rasterSnapshot,crop:{...crop},fullWidth:asset.width,fullHeight:asset.height};
}

function encodedIntervals(rows,width,height) {
  const counts=[];let offset=0;
  for(let y=0;y<height;y++) {
    const intervals=rows.get(y);if(!intervals?.length)continue;
    intervals.sort((a,b)=>a[0]-b[0]||a[1]-b[1]);
    let start=intervals[0][0],end=intervals[0][1];
    const append=()=>{
      const next=y*width+start,stop=y*width+end,gap=next-offset;
      if(counts.length&&gap===0)counts[counts.length-1]+=stop-next;
      else counts.push(gap,stop-next);
      offset=stop;
      requireThat(counts.length<=MAX_REGION_RUNS,'The marked selection contains too much detail. Use a simpler mark or choose a smaller area.');
    };
    for(let index=1;index<intervals.length;index++) {
      if(intervals[index][0]<=end)end=Math.max(end,intervals[index][1]);
      else {append();[start,end]=intervals[index];}
    }
    append();
  }
  if(!counts.length)return null;
  if(offset<width*height)counts.push(width*height-offset);
  return {width,height,counts};
}
function mappedMask(mask,working,width,height) {
  const rows=new Map(),crop=working.crop,sx=width/working.fullWidth,sy=height/working.fullHeight;
  let offset=0;
  for(let index=0;index<mask.counts.length;index++) {
    const count=mask.counts[index];
    if(index%2) {
      let start=offset,stop=offset+count;
      while(start<stop) {
        const y=Math.floor(start/mask.width),x=start%mask.width,length=Math.min(stop-start,mask.width-x);
        // Cover every destination cell touched by a source mask pixel. Thin
        // frames must not vanish when the full-raster grid is smaller than ROI.
        const left=clamp(Math.floor((crop.x+x*crop.width/mask.width)*sx),0,width);
        const right=clamp(Math.ceil((crop.x+(x+length)*crop.width/mask.width)*sx),0,width);
        const top=clamp(Math.floor((crop.y+y*crop.height/mask.height)*sy),0,height);
        const bottom=clamp(Math.ceil((crop.y+(y+1)*crop.height/mask.height)*sy),0,height);
        if(right>left)for(let row=top;row<bottom;row++){if(!rows.has(row))rows.set(row,[]);rows.get(row).push([left,right]);}
        start+=length;
      }
    }
    offset+=count;
  }
  return encodedIntervals(rows,width,height);
}

export function mapGuidedResult(raw,working) {
  const result=validateDetectionResult(raw),{crop,fullWidth,fullHeight,request}=working;
  requireThat(Number.isInteger(fullWidth)&&Number.isInteger(fullHeight)&&fullWidth>0&&fullHeight>0&&fullWidth<=8192&&fullHeight<=8192&&crop&&[crop.x,crop.y,crop.width,crop.height].every(Number.isInteger)&&crop.x>=0&&crop.y>=0&&crop.width>0&&crop.height>0&&crop.x+crop.width<=fullWidth&&crop.y+crop.height<=fullHeight,'The marked selection has invalid source coordinates.');
  requireThat(result.width===request.width&&result.height===request.height,'The local model returned an incompatible marked image size.');
  const scale=Math.min(1,MAX_REGION_SIDE/Math.max(fullWidth,fullHeight)),width=Math.max(1,Math.round(fullWidth*scale)),height=Math.max(1,Math.round(fullHeight*scale));
  const regions=[],seen=new Set();
  for(const region of result.regions) {
    const mask=mappedMask(region.mask,working,width,height);if(!mask)continue;
    const key=mask.counts.join(',');if(seen.has(key))continue;seen.add(key);
    regions.push({id:identifier(),mask});
  }
  return validateDetectionResult({...result,width,height,regions});
}

export function manualGuidedResult(working) {
  const {markSnapshot:mark,rasterSnapshot:raster,crop,request,fullWidth,fullHeight}=working;
  requireThat(drawingBounds(mark)&&raster?.kind==='raster'&&crop&&request,'The original mark is unavailable. Draw or highlight the area again.');
  const canvas=document.createElement('canvas');canvas.width=request.width;canvas.height=request.height;
  const context=canvas.getContext('2d'),drawing=mark.drawing;
  const sx=mark.width/drawing.baseWidth,sy=mark.height/drawing.baseHeight;
  const workingPoint=(x,y)=>{
    const documentPoint=layerPointToDocument(mark,{x:x*sx,y:y*sy}),local=documentPointToLayer(raster,documentPoint);
    return {x:(local.x*fullWidth/raster.width-crop.x)*request.width/crop.width,y:(local.y*fullHeight/raster.height-crop.y)*request.height/crop.height};
  };
  const origin=workingPoint(0,0),axisX=workingPoint(1,0),axisY=workingPoint(0,1);
  context.setTransform(axisX.x-origin.x,axisX.y-origin.y,axisY.x-origin.x,axisY.y-origin.y,origin.x,origin.y);
  context.lineCap='round';context.lineJoin='round';context.lineWidth=drawing.size;context.strokeStyle='#fff';context.fillStyle='#fff';
  context.beginPath();context.moveTo(...drawing.points[0]);
  if(drawing.points.length===1)context.lineTo(drawing.points[0][0]+.01,drawing.points[0][1]);
  else for(let index=1;index<drawing.points.length;index++)context.lineTo(...drawing.points[index]);
  const first=drawing.points[0],last=drawing.points.at(-1),bounds=drawingBounds(mark),distance=Math.hypot((last[0]-first[0])*sx,(last[1]-first[1])*sy);
  const tolerance=Math.max(drawing.size*Math.max(sx,sy)*2,Math.hypot(bounds.width,bounds.height)*.15);
  if(drawing.mode==='pencil'&&drawing.points.length>=3&&distance<=tolerance){context.closePath();context.fill();}
  context.stroke();
  const pixels=context.getImageData(0,0,canvas.width,canvas.height).data,rows=new Map();
  for(let y=0;y<canvas.height;y++) {
    const intervals=[];let start=-1;
    for(let x=0;x<canvas.width;x++) {
      const marked=pixels[(y*canvas.width+x)*4+3]>0;
      if(marked&&start<0)start=x;
      if(!marked&&start>=0){intervals.push([start,x]);start=-1;}
    }
    if(start>=0)intervals.push([start,canvas.width]);if(intervals.length)rows.set(y,intervals);
  }
  const mask=encodedIntervals(rows,canvas.width,canvas.height);
  requireThat(mask,'The mark falls outside the source image. Draw or highlight a visible area.');
  return validateDetectionResult({width:canvas.width,height:canvas.height,regions:[{id:identifier(),mask}],model:'Manual marked area',device:'This computer',elapsedMs:0});
}
