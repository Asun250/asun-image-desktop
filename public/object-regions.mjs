// SAM masks are editable annotation data. They never replace a source image.
import {normalizeRotation,documentPointToLayer,layerPointToDocument} from './layer-transform.mjs';
export const DEFAULT_OBJECT_LABEL_SIZE = 180;
export const DEFAULT_OBJECT_COLOR = '#ff0000';
export const MAX_REGION_SIDE = 1600;
export const MAX_REGION_RUNS = 512001;
export const MAX_DETECTION_REGIONS = 256;
// Undo retains old RLE masks, so weak keys do not limit the expanded row/path
// memory across edits. Budget derived geometry independently of saved masks.
const details = new Map();
const MAX_MASK_DETAIL_BYTES=64*1024*1024,MAX_MASK_DETAIL_ENTRIES=256;
let detailBytes=0;
export function clearRegionCache(){details.clear();detailBytes=0;}
const finite = value => typeof value === 'number' && Number.isFinite(value);
function requireThat(condition,message) { if(!condition)throw new Error(message); }
function keys(value,allowed) { return value && typeof value==='object' && !Array.isArray(value) && Object.keys(value).every(key=>allowed.includes(key)); }
export function validateRegionMask(mask) {
  requireThat(keys(mask,['width','height','counts']) && Number.isInteger(mask.width) && Number.isInteger(mask.height) && mask.width>=1 && mask.height>=1 && mask.width<=MAX_REGION_SIDE && mask.height<=MAX_REGION_SIDE,'Invalid object selection mask dimensions.');
  requireThat(Array.isArray(mask.counts) && mask.counts.length>=2 && mask.counts.length<=MAX_REGION_RUNS,'Invalid object selection mask runs.');
  let total=0,area=0;
  for(let index=0;index<mask.counts.length;index++) {
    const count=mask.counts[index];
    requireThat(Number.isInteger(count) && count>=0 && (index===0 || count>0),'Invalid object selection mask run.');
    total+=count;if(index%2)area+=count;
    requireThat(total<=mask.width*mask.height,'Object selection mask exceeds its dimensions.');
  }
  requireThat(total===mask.width*mask.height && area>0,'Object selection mask does not match its dimensions.');
  return mask;
}
function maskDetails(mask) {
  if(details.has(mask)){const hit=details.get(mask);details.delete(mask);details.set(mask,hit);return hit;}
  validateRegionMask(mask);
  const rows=Array.from({length:mask.height},()=>[]);
  let offset=0,area=0,minX=mask.width,minY=mask.height,maxX=-1,maxY=-1,intervals=0;
  for(let index=0;index<mask.counts.length;index++) {
    const count=mask.counts[index];
    if(index%2) {
      area+=count;
      let start=offset,end=offset+count;
      while(start<end) {
        const y=Math.floor(start/mask.width),x=start%mask.width,length=Math.min(end-start,mask.width-x);
        rows[y].push([x,x+length]);intervals++;minX=Math.min(minX,x);maxX=Math.max(maxX,x+length-1);minY=Math.min(minY,y);maxY=Math.max(maxY,y);start+=length;
      }
    }
    offset+=count;
  }
  // Include a conservative allowance for the boundary commands created later.
  // Keep one unusually complex current mask usable instead of recalculating it
  // for every hover; older masks remain editable RLE and are expanded on demand.
  const bytes=mask.height*32+intervals*128;
  const result={rows,area,bbox:[minX,minY,maxX-minX+1,maxY-minY+1],path:null,bytes};details.set(mask,result);detailBytes+=bytes;
  while(details.size>1&&(details.size>MAX_MASK_DETAIL_ENTRIES||detailBytes>MAX_MASK_DETAIL_BYTES)){
    const key=details.keys().next().value,old=details.get(key);details.delete(key);detailBytes-=old.bytes;
  }
  return result;
}
export function regionMaskInfo(mask) { const {area,bbox}=maskDetails(mask);return {area,bbox:[...bbox]}; }
export function regionContainsPoint(mask,x,y) {
  if(!finite(x)||!finite(y)||x<0||y<0||x>=mask.width||y>=mask.height)return false;
  const row=maskDetails(mask).rows[Math.floor(y)],point=Math.floor(x);
  let low=0,high=row.length-1;
  while(low<=high) { const index=(low+high)>>1,[start,end]=row[index];if(point<start)high=index-1;else if(point>=end)low=index+1;else return true; }
  return false;
}
export function validateDetectionResult(result) {
  requireThat(result && Number.isInteger(result.width) && Number.isInteger(result.height) && result.width>=1 && result.height>=1 && result.width<=MAX_REGION_SIDE && result.height<=MAX_REGION_SIDE,'The object detector returned invalid image dimensions.');
  requireThat(Array.isArray(result.regions) && result.regions.length<=MAX_DETECTION_REGIONS,'The object detector returned too many selections.');
  const ids=new Set();let totalRuns=0;
  const regions=result.regions.map(region=> {
    requireThat(region && typeof region.id==='string' && region.id.length>0 && region.id.length<=200 && !ids.has(region.id),'The object detector returned a duplicate or invalid selection.');ids.add(region.id);
    const mask=validateRegionMask(region.segmentation || region.mask);
    requireThat(mask.width===result.width && mask.height===result.height,'The object detector returned a selection for a different image.');
    totalRuns+=mask.counts.length;requireThat(totalRuns<=4_000_000,'The object detector returned too much selection data.');
    return {id:region.id,...regionMaskInfo(mask),mask:structuredClone(mask)};
  });
  return {width:result.width,height:result.height,regions,model:typeof result.model==='string'?result.model.slice(0,200):'',device:typeof result.device==='string'?result.device.slice(0,100):'',elapsedMs:finite(result.elapsedMs)&&result.elapsedMs>=0?result.elapsedMs:0};
}
export function pickRegion(regions,x,y,alternative=0) {
  const matches=regions.filter(region=>regionContainsPoint(region.mask || region.segmentation,x,y));
  matches.sort((a,b)=>regionMaskInfo(a.mask || a.segmentation).area-regionMaskInfo(b.mask || b.segmentation).area || String(a.id).localeCompare(String(b.id)));
  return matches.length ? matches[((Number.isInteger(alternative)?alternative:0)%matches.length+matches.length)%matches.length] : null;
}
export function regionMask(region) { return region?.mask || region?.segmentation || null; }
export function validateObjectRegion(region,assets,layers) {
  requireThat(keys(region,['version','assetId','rasterLayerId','sourceWidth','sourceHeight','mask','group']) && region.version===1 && typeof region.assetId==='string' && typeof region.rasterLayerId==='string','Invalid detected object selection.');
  const asset=assets[region.assetId],raster=layers.find(layer=>layer.id===region.rasterLayerId);
  requireThat(asset && raster?.kind==='raster' && raster.assetId===region.assetId,'The detected object is missing its source image layer.');
  requireThat(region.sourceWidth===asset.width && region.sourceHeight===asset.height,'The detected object does not match its original image dimensions.');
  if(Object.hasOwn(region,'group'))requireThat(keys(region.group,['areaCount']) && Number.isInteger(region.group.areaCount) && region.group.areaCount>=1 && region.group.areaCount<=100,'Invalid grouped object selection.');
  validateRegionMask(region.mask);return region;
}
export function rasterRegionBounds(project,labelOrRegion) {
  const region=labelOrRegion?.objectRegion || labelOrRegion;
  const raster=project.layers.find(layer=>layer.id===region?.rasterLayerId && layer.kind==='raster' && layer.assetId===region.assetId);
  return raster ? {x:raster.x,y:raster.y,width:raster.width,height:raster.height,visible:raster.visible && raster.opacity>0,opacity:raster.opacity,...(normalizeRotation(raster.rotation??0)?{rotation:normalizeRotation(raster.rotation)}:{})} : null;
}
export function objectRegionBounds(project,label) {
  const bounds=rasterRegionBounds(project,label);if(!bounds||!label?.objectRegion)return null;
  const mask=label.objectRegion.mask,[x,y,width,height]=regionMaskInfo(mask).bbox;
  const corners=[[x,y],[x+width,y],[x+width,y+height],[x,y+height]].map(([cx,cy])=>layerPointToDocument(bounds,{x:cx*bounds.width/mask.width,y:cy*bounds.height/mask.height}));
  const xs=corners.map(p=>p.x),ys=corners.map(p=>p.y),left=Math.min(...xs),top=Math.min(...ys);
  return {x:left,y:top,width:Math.max(...xs)-left,height:Math.max(...ys)-top};
}
export function objectRegionContains(project,label,point) {
  const bounds=rasterRegionBounds(project,label);
  const x=Array.isArray(point)?point[0]:point?.x,y=Array.isArray(point)?point[1]:point?.y;
  const raster=project.layers.find(layer=>layer.id===label?.objectRegion?.rasterLayerId);
  const local=bounds?documentPointToLayer(bounds,{x,y}):null;
  return !!(label?.objectRegion && label.visible && label.opacity>0 && bounds?.visible && rasterPointVisible(project,raster,{x,y}) && regionContainsPoint(label.objectRegion.mask,local.x*label.objectRegion.mask.width/bounds.width,local.y*label.objectRegion.mask.height/bounds.height));
}
function touchesStroke(x,y,stroke) {
  if(stroke.region)return regionContainsPoint(stroke.region,x*stroke.region.width/stroke.sourceWidth,y*stroke.region.height/stroke.sourceHeight);
  const radiusSquared=(stroke.size/2)**2,points=stroke.points;
  if(points.length===1)return (x-points[0][0])**2+(y-points[0][1])**2<=radiusSquared;
  for(let index=1;index<points.length;index++) {
    const [ax,ay]=points[index-1],[bx,by]=points[index],dx=bx-ax,dy=by-ay,lengthSquared=dx*dx+dy*dy;
    const t=lengthSquared?Math.max(0,Math.min(1,((x-ax)*dx+(y-ay)*dy)/lengthSquared)):0;
    if((x-ax-t*dx)**2+(y-ay-t*dy)**2<=radiusSquared)return true;
  }
  return false;
}
export function layerSourcePointVisible(layer,x,y) {
  let visible=true;for(const stroke of layer.mask)if(touchesStroke(x,y,stroke))visible=stroke.mode==='restore';return visible;
}
export function rasterPointVisible(project,raster,point) {
  const x=Array.isArray(point)?point[0]:point?.x,y=Array.isArray(point)?point[1]:point?.y;
  if(!raster || raster.kind!=='raster' || !raster.visible || !raster.opacity || !finite(x) || !finite(y))return false;
  const local=documentPointToLayer(raster,{x,y});
  if(local.x<0 || local.y<0 || local.x>=raster.width || local.y>=raster.height)return false;
  const asset=project.assets[raster.assetId];if(!asset)return false;
  const sourceX=local.x*asset.width/raster.width,sourceY=local.y*asset.height/raster.height;
  return layerSourcePointVisible(raster,sourceX,sourceY);
}
export function nextObjectNumber(project) {
  const used=new Set(project.layers.filter(layer=>layer.kind==='text' && /^\d+$/.test(layer.text.content.trim())).map(layer=>Number(layer.text.content.trim())));
  let value=1;while(used.has(value))value++;return String(value);
}
export function maskCanvas(mask,color=DEFAULT_OBJECT_COLOR) {
  const {rows}=maskDetails(mask),canvas=document.createElement('canvas');canvas.width=mask.width;canvas.height=mask.height;
  const context=canvas.getContext('2d');context.fillStyle=color;
  for(let y=0;y<rows.length;y++)for(const [start,end] of rows[y])context.fillRect(start,y,end-start,1);
  return canvas;
}
export const maskToCanvas=maskCanvas;
function subtractIntervals(intervals,other,callback) {
  let otherIndex=0;
  for(const [start,end] of intervals) {
    let x=start;while(otherIndex<other.length && other[otherIndex][1]<=x)otherIndex++;
    let index=otherIndex;
    while(index<other.length && other[index][0]<end) { const [a,b]=other[index];if(a>x)callback(x,Math.min(a,end));x=Math.max(x,b);if(x>=end)break;index++; }
    if(x<end)callback(x,end);
  }
}
function boundaryPath(mask) {
  const info=maskDetails(mask);if(info.path)return info.path;
  const path=new Path2D(),rows=info.rows;
  for(let y=0;y<rows.length;y++) {
    for(const [start,end] of rows[y]) { path.moveTo(start,y);path.lineTo(start,y+1);path.moveTo(end,y);path.lineTo(end,y+1); }
    subtractIntervals(rows[y],rows[y-1] || [],(start,end)=>{path.moveTo(start,y);path.lineTo(end,y);});
    subtractIntervals(rows[y],rows[y+1] || [],(start,end)=>{path.moveTo(start,y+1);path.lineTo(end,y+1);});
  }
  info.path=path;return path;
}
export function drawRegionOverlay(context,mask,bounds,{color=DEFAULT_OBJECT_COLOR,fillOpacity=0.10,outlineOpacity=0.85,lineWidth=2}={}) {
  if(!bounds || bounds.width<=0 || bounds.height<=0)return;
  const {rows}=maskDetails(mask),scaleX=bounds.width/mask.width,scaleY=bounds.height/mask.height;
  context.save();context.translate(bounds.x+bounds.width/2,bounds.y+bounds.height/2);context.rotate(normalizeRotation(bounds.rotation??0)*Math.PI/180);context.translate(-bounds.width/2,-bounds.height/2);context.scale(scaleX,scaleY);
  const alpha=context.globalAlpha;context.globalAlpha=alpha*fillOpacity;context.fillStyle=color;
  for(let y=0;y<rows.length;y++)for(const [start,end] of rows[y])context.fillRect(start,y,end-start,1);
  context.globalAlpha=alpha*outlineOpacity;context.strokeStyle=color;context.lineWidth=lineWidth/Math.sqrt(scaleX*scaleY);context.lineJoin='round';context.stroke(boundaryPath(mask));context.restore();
}
