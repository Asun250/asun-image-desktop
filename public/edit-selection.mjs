import {validateRegionMask,rasterPointVisible} from './object-regions.mjs';
import {documentPointToLayer,layerPointToDocument,normalizeRotation} from './layer-transform.mjs';

// Selection masks describe source-relative pixels; the source image is never
// painted over. Keep an existing detector grid exactly as saved when refining.
export const MANUAL_SELECTION_MAX_SIDE=1024;
const finite=value=>typeof value==='number'&&Number.isFinite(value);
const clamp=(value,low,high)=>Math.max(low,Math.min(high,value));
function requireThat(condition,message){if(!condition)throw new Error(message);}
function usableRaster(project,layer){
  return Boolean(layer?.kind==='raster'&&layer.visible&&layer.opacity>0&&project.assets?.[layer.assetId]);
}

export function selectionTarget(project,selectedId=null){
  const layers=project?.layers||[],selected=layers.find(layer=>layer.id===selectedId);
  const selectedRaster=selected?.objectRegion?layers.find(layer=>layer.id===selected.objectRegion.rasterLayerId&&layer.assetId===selected.objectRegion.assetId):selected;
  if(usableRaster(project,selectedRaster))return selectedRaster;
  const surface=layers.find(layer=>layer.id===project?.sketch?.surfaceLayerId);
  if(usableRaster(project,surface))return surface;
  return layers.find(layer=>usableRaster(project,layer)&&layer.assetId===project.original?.assetId)
    ||layers.find(layer=>usableRaster(project,layer))||null;
}

function decode(mask,width,height){
  const pixels=new Uint8Array(width*height);
  if(mask){let offset=0;mask.counts.forEach((count,index)=>{if(index%2)pixels.fill(1,offset,offset+count);offset+=count;});}
  return pixels;
}

function encode(pixels,width,height){
  const counts=[];let previous=0,run=0,area=0,sumX=0,sumY=0;
  for(let offset=0;offset<pixels.length;offset++){
    const value=pixels[offset];
    if(value===previous)run++;else{counts.push(run);run=1;previous=value;}
    if(value){area++;sumX+=offset%width+.5;sumY+=Math.floor(offset/width)+.5;}
  }
  if(!area)return null;
  counts.push(run);
  const mask={width,height,counts};validateRegionMask(mask);
  const cx=sumX/area,cy=sumY/area;
  let point=[cx,cy];
  // The average may sit in a hole or between separate objects. Put the number
  // on actual selected pixels instead of the empty centre of a bounding box.
  if(!pixels[Math.floor(cy)*width+Math.floor(cx)]){
    let nearest=Infinity;
    for(let offset=0;offset<pixels.length;offset++)if(pixels[offset]){
      const x=offset%width+.5,y=Math.floor(offset/width)+.5,distance=(x-cx)**2+(y-cy)**2;
      if(distance<nearest){nearest=distance;point=[x,y];}
    }
  }
  return {mask,point};
}

function distanceSquared(x,y,a,b){
  const dx=b[0]-a[0],dy=b[1]-a[1],length=dx*dx+dy*dy;
  const t=length?clamp(((x-a[0])*dx+(y-a[1])*dy)/length,0,1):0;
  return (x-a[0]-dx*t)**2+(y-a[1]-dy*t)**2;
}

// A horizontal slice of a round brush segment is a single interval. Binary
// search its ends rather than visiting an entire long diagonal's bounding box.
function paintSegment(pixels,width,height,project,raster,a,b,size,adding){
  const cellW=raster.width/width,cellH=raster.height/height;
  // Cover touched cells, including subpixel clicks on the bounded grid.
  const radius=size/2+Math.hypot(cellW,cellH)/2,radiusSquared=radius*radius;
  const left=clamp(Math.ceil((Math.min(a[0],b[0])-radius)/cellW-.5),0,width);
  const right=clamp(Math.floor((Math.max(a[0],b[0])+radius)/cellW-.5),-1,width-1);
  const top=clamp(Math.ceil((Math.min(a[1],b[1])-radius)/cellH-.5),0,height);
  const bottom=clamp(Math.floor((Math.max(a[1],b[1])+radius)/cellH-.5),-1,height-1);
  const simple=!normalizeRotation(raster.rotation??0)&&raster.x>=0&&raster.y>=0&&raster.x+raster.width<=project.width&&raster.y+raster.height<=project.height&&(!adding||!raster.mask?.length);
  if(right<left||bottom<top)return;
  for(let y=top;y<=bottom;y++){
    const localY=(y+.5)*cellH;
    const t=a[1]===b[1] ? .5 : clamp((localY-a[1])/(b[1]-a[1]),0,1);
    const closestX=a[0]+(b[0]-a[0])*t;
    const pivot=clamp(Math.round(closestX/cellW-.5),left,right);
    const inside=x=>distanceSquared((x+.5)*cellW,localY,a,b)<=radiusSquared;
    if(!inside(pivot))continue;
    let lo=left,hi=pivot;
    while(lo<hi){const middle=Math.floor((lo+hi)/2);if(inside(middle))hi=middle;else lo=middle+1;}
    const start=lo;lo=pivot;hi=right;
    while(lo<hi){const middle=Math.ceil((lo+hi)/2);if(inside(middle))lo=middle;else hi=middle-1;}
    if(simple)pixels.fill(adding?1:0,y*width+start,y*width+lo+1);
    else for(let x=start;x<=lo;x++){
      const documentPoint=layerPointToDocument(raster,{x:(x+.5)*cellW,y:localY});
      if(documentPoint.x<0||documentPoint.y<0||documentPoint.x>=project.width||documentPoint.y>=project.height)continue;
      if(!adding||rasterPointVisible(project,raster,documentPoint))pixels[y*width+x]=adding?1:0;
    }
  }
}

/** Paint/refine a selection with document-coordinate points and brush diameter. */
export function brushObjectSelection(project,{rasterId,mask=null,points,size,mode='add'}={}){
  requireThat(mode==='add'||mode==='subtract','Choose Add or Subtract for the selection brush.');
  requireThat(finite(size)&&size>0&&size<=1e6,'Choose a positive selection brush size.');
  requireThat(Array.isArray(points)&&points.length>0&&points.length<=50000,'Draw a selection stroke first.');
  const stroke=points.map(point=>Array.isArray(point)?point:[point?.x,point?.y]);
  requireThat(stroke.every(point=>point.length===2&&point.every(value=>finite(value)&&Math.abs(value)<=1e6)),'The selection stroke contains invalid coordinates.');
  const raster=project?.layers?.find(layer=>layer.id===rasterId),asset=project?.assets?.[raster?.assetId];
  requireThat(usableRaster(project,raster),'Select a visible image before brushing an area.');
  requireThat([project.width,project.height,raster.width,raster.height,asset.width,asset.height].every(value=>finite(value)&&value>0)&&[raster.x,raster.y].every(finite),'The selected image has invalid dimensions.');
  if(mask)validateRegionMask(mask);
  const scale=Math.min(1,MANUAL_SELECTION_MAX_SIDE/Math.max(asset.width,asset.height));
  const width=mask?.width||Math.max(1,Math.round(asset.width*scale));
  const height=mask?.height||Math.max(1,Math.round(asset.height*scale));
  const pixels=decode(mask,width,height);
  // Canvas-view rotation has already been removed by the pointer controller.
  // Inverse-rotate each document point into the layer's displayed local units.
  const localStroke=stroke.map(point=>{const local=documentPointToLayer(raster,point);return [local.x,local.y];});
  for(let index=0;index<Math.max(1,localStroke.length-1);index++)paintSegment(pixels,width,height,project,raster,localStroke[index],localStroke[Math.min(index+1,localStroke.length-1)],size,mode==='add');
  const result=encode(pixels,width,height);if(!result)return null;
  return {project,mask:result.mask,point:layerPointToDocument(raster,{x:result.point[0]*raster.width/width,y:result.point[1]*raster.height/height}),raster,asset,manual:true};
}
