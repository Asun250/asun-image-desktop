// Canvas rendering does not alter source assets. Annotation content remains editable.
import { layerSourceDimensions } from './core.mjs';
import {drawRegionOverlay,rasterRegionBounds,layerSourcePointVisible,maskToCanvas,clearRegionCache} from './object-regions.mjs';
import {normalizeRotation} from './layer-transform.mjs';
import {clearImageSourceValidationCache} from './image-source-validation.mjs';
const decoded = new Map();
const MAX_DECODED_BYTES=128*1024*1024,MAX_DECODED_ENTRIES=12;
let decodedBytes=0;
let regionBuffers=new WeakMap();
const erasedRegionBuffers=new Map();
const MAX_ERASED_REGION_BYTES=32*1024*1024,MAX_ERASED_REGION_ENTRIES=8;
let erasedRegionBytes=0;
// Reuse immutable pre-mask pixels while painting. Native exports use the same
// dimensions/filtering; the budget bounds retained canvas memory across tabs.
const rasterPixelsBySource=new Map(),rasterPixelLRU=new Set();
const MAX_RASTER_PIXEL_BYTES=64*1024*1024,MAX_RASTER_PIXEL_ENTRIES=12;
let rasterPixelBytes=0,rasterPixelEpoch=0;
let glyphHitCanvas=null;
export async function decodeImage(source) {
  let entry=decoded.get(source);
  if(entry){decoded.delete(source);decoded.set(source,entry);return entry.pending;}
  entry={pending:null,bytes:0};
  entry.pending = new Promise((resolve, reject) => {
      const image = new Image();
      image.onload = () => {
        image.onload=null;image.onerror=null;
        // A reset or another request may have replaced this in-flight entry.
        // Its callers still receive their image without repopulating old caches.
        if(decoded.get(source)===entry){
          entry.bytes=image.naturalWidth*image.naturalHeight*4;decodedBytes+=entry.bytes;
          trimDecodedImages();
        }
        resolve(image);
      };
      image.onerror = () => { image.onload=null;image.onerror=null;if(decoded.get(source)===entry)decoded.delete(source);reject(new Error('An image could not be decoded. Try another PNG, JPEG, or WebP file.')); };
      image.src = source;
  });
  decoded.set(source,entry);trimDecodedImages();
  return entry.pending;
}
function trimDecodedImages(){
  while(decoded.size&&(decoded.size>MAX_DECODED_ENTRIES||decodedBytes>MAX_DECODED_BYTES)){
    const key=decoded.keys().next().value,entry=decoded.get(key);decoded.delete(key);decodedBytes-=entry.bytes;
  }
}
export function clearImageCache() { decoded.clear();decodedBytes=0;glyphHitCanvas=null;regionBuffers=new WeakMap();erasedRegionBuffers.clear();erasedRegionBytes=0;clearRegionCache();clearImageSourceValidationCache();rasterPixelsBySource.clear();rasterPixelLRU.clear();rasterPixelBytes=0;rasterPixelEpoch++; }
function erasedRegionPixels(mask){
  let entry=erasedRegionBuffers.get(mask);
  if(entry){erasedRegionBuffers.delete(mask);erasedRegionBuffers.set(mask,entry);return entry.buffer;}
  const buffer=maskToCanvas(mask,'#ffffff'),bytes=buffer.width*buffer.height*4;
  if(bytes>MAX_ERASED_REGION_BYTES)return buffer;
  // Undo keeps the editable RLE objects alive. A WeakMap alone therefore does
  // not bound their decoded canvas memory over a long editing session.
  while(erasedRegionBuffers.size&&(erasedRegionBuffers.size>=MAX_ERASED_REGION_ENTRIES||erasedRegionBytes+bytes>MAX_ERASED_REGION_BYTES)){
    const key=erasedRegionBuffers.keys().next().value,old=erasedRegionBuffers.get(key);erasedRegionBuffers.delete(key);erasedRegionBytes-=old.bytes;
  }
  entry={buffer,bytes};erasedRegionBuffers.set(mask,entry);erasedRegionBytes+=bytes;return buffer;
}
function canvas(width, height) { const item = document.createElement('canvas'); item.width = width; item.height = height; return item; }
async function rasterPixels(asset,source,layer,width,height){
  const key=`${source.width}:${source.height}:${width}:${height}:${layer.brightness}:${layer.contrast}:${layer.saturation}`;
  const cached=()=>rasterPixelsBySource.get(asset.source)?.get(key);
  let entry=cached();
  if(entry){rasterPixelLRU.delete(entry);rasterPixelLRU.add(entry);return {buffer:entry.buffer,shared:true};}
  const epoch=rasterPixelEpoch,image=await decodeImage(asset.source);
  // Concurrent renders may have prepared this image while decoding completed.
  entry=cached();if(entry){rasterPixelLRU.delete(entry);rasterPixelLRU.add(entry);return {buffer:entry.buffer,shared:true};}
  const buffer=canvas(width,height),brush=buffer.getContext('2d');
  brush.scale(width/source.width,height/source.height);
  brush.filter=`brightness(${layer.brightness}%) contrast(${layer.contrast}%) saturate(${layer.saturation}%)`;
  brush.drawImage(image,0,0,source.width,source.height);brush.filter='none';brush.setTransform(1,0,0,1,0,0);
  const bytes=width*height*4;
  if(epoch!==rasterPixelEpoch||bytes>MAX_RASTER_PIXEL_BYTES)return {buffer,shared:false};
  while(rasterPixelLRU.size&&(rasterPixelBytes+bytes>MAX_RASTER_PIXEL_BYTES||rasterPixelLRU.size>=MAX_RASTER_PIXEL_ENTRIES)){
    const oldest=rasterPixelLRU.values().next().value;rasterPixelLRU.delete(oldest);rasterPixelBytes-=oldest.bytes;
    const entries=rasterPixelsBySource.get(oldest.source);entries.delete(oldest.key);if(!entries.size)rasterPixelsBySource.delete(oldest.source);
  }
  entry={source:asset.source,key,buffer,bytes};let entries=rasterPixelsBySource.get(asset.source);if(!entries){entries=new Map();rasterPixelsBySource.set(asset.source,entries);}entries.set(key,entry);rasterPixelLRU.add(entry);rasterPixelBytes+=bytes;
  return {buffer,shared:true};
}
// Objects-mode number clicks use painted letters rather than transparent text
// padding. Sample one native pixel without allocating a full-size text buffer.
export function textGlyphContainsPoint(project,layer,point) {
  if(layer?.kind!=='text'||!layer.visible||layer.opacity<=0||!Number.isFinite(point?.x)||!Number.isFinite(point?.y)||point.x<layer.x||point.y<layer.y||point.x>=layer.x+layer.width||point.y>=layer.y+layer.height)return false;
  const source=layerSourceDimensions(project,layer),x=Math.floor((point.x-layer.x)*source.width/layer.width),y=Math.floor((point.y-layer.y)*source.height/layer.height);
  if(!layerSourcePointVisible(layer,x+.5,y+.5))return false;
  glyphHitCanvas??=canvas(1,1);const brush=glyphHitCanvas.getContext('2d',{willReadFrequently:true});
  brush.setTransform(1,0,0,1,0,0);brush.clearRect(0,0,1,1);
  const {content,fontSize,fontFamily}=layer.text,padding=Math.ceil(fontSize*.2),lineHeight=fontSize*1.25;
  brush.font=`600 ${fontSize}px ${fontFamily}`;brush.textBaseline='alphabetic';brush.fillStyle='#fff';
  const metrics=brush.measureText('Mg'),ascent=metrics.fontBoundingBoxAscent??fontSize*.9,descent=metrics.fontBoundingBoxDescent??fontSize*.2,baseline=padding+ascent+(lineHeight-ascent-descent)/2;
  brush.translate(-x,-y);for(const [index,line]of content.split('\n').entries()){const row=baseline+index*lineHeight;if(y+1>=row-ascent&&y<=row+descent)brush.fillText(line,padding,row);}
  return brush.getImageData(0,0,1,1).data[3]>0;
}
function strokePath(context, points) {
  context.beginPath();
  context.moveTo(...points[0]);
  if (points.length === 1) context.lineTo(points[0][0] + 0.01, points[0][1]);
  else for (let index = 1; index < points.length; index++) context.lineTo(...points[index]);
  context.stroke();
}
function maskCanvas(source, strokes, size = source, target = null) {
  const mask=target || canvas(size.width,size.height);mask.width=size.width;mask.height=size.height;
  const context = mask.getContext('2d');
  context.scale(size.width/source.width,size.height/source.height);
  context.fillStyle = '#fff'; context.fillRect(0,0,source.width,source.height);
  context.lineCap = 'round'; context.lineJoin = 'round'; context.strokeStyle = '#fff';
  for (const stroke of strokes) {
    context.globalCompositeOperation = stroke.mode === 'hide' ? 'destination-out' : 'source-over';
    if(stroke.region) {
      // The RLE is a full-source selection, not its bounding rectangle. Keep
      // holes and disconnected pieces precise while scaling with the raster.
      const region=erasedRegionPixels(stroke.region);
      context.imageSmoothingEnabled=false;
      context.drawImage(region,0,0,source.width,source.height);
      context.imageSmoothingEnabled=true;
      continue;
    }
    context.lineWidth = stroke.size;
    strokePath(context,stroke.points);
  }
  return mask;
}
export function drawRasterRegionOverlay(context,project,raster,mask,{bounds=raster,maxBufferSide=null,...style}={}) {
  if(!raster?.visible || raster.opacity===0 || !bounds)return;
  const rotation=normalizeRotation(bounds.rotation??raster.rotation??0);
  if(!raster.mask.length) {drawRegionOverlay(context,mask,{...bounds,rotation},style);return;}
  // Clip only a generated overlay to native hide/restore strokes. Bounds follow
  // the target canvas, so reference-board rendering cannot allocate source-sized
  // image buffers. Reuse buffers for many selected objects on the same canvas.
  let width=Math.max(1,Math.min(context.canvas.width,Math.ceil(bounds.width))),height=Math.max(1,Math.min(context.canvas.height,Math.ceil(bounds.height)));
  if(maxBufferSide) {const scale=Math.min(1,maxBufferSide/Math.max(width,height));width=Math.max(1,Math.round(width*scale));height=Math.max(1,Math.round(height*scale));}
  let buffers=regionBuffers.get(context);if(!buffers) {buffers={overlay:canvas(1,1),visibility:canvas(1,1)};regionBuffers.set(context,buffers);}
  const overlay=buffers.overlay;overlay.width=width;overlay.height=height;
  const brush=overlay.getContext('2d');brush.scale(width/bounds.width,height/bounds.height);
  drawRegionOverlay(brush,mask,{x:0,y:0,width:bounds.width,height:bounds.height},style);
  brush.setTransform(1,0,0,1,0,0);brush.globalCompositeOperation='destination-in';
  brush.drawImage(maskCanvas(project.assets[raster.assetId],raster.mask,overlay,buffers.visibility),0,0);
  if(rotation) {
    context.save();context.translate(bounds.x+bounds.width/2,bounds.y+bounds.height/2);context.rotate(rotation*Math.PI/180);
    context.drawImage(overlay,-bounds.width/2,-bounds.height/2,bounds.width,bounds.height);context.restore();
  } else context.drawImage(overlay,bounds.x,bounds.y,bounds.width,bounds.height);
}
export async function renderProject(project, target, { original = false, background = null } = {}) {
  return renderAtSize(project,target,{original,background,width:project.width,height:project.height});
}
export async function renderProjectPreview(project, target = canvas(1,1), { maxSide = 2600, original = false, background = null } = {}) {
  if(!Number.isInteger(maxSide)||maxSide<1||maxSide>8192)throw new Error('Choose a preview size from 1 to 8192 pixels.');
  const scale=Math.min(1,maxSide/Math.max(project.width,project.height));
  return renderAtSize(project,target,{original,background,width:Math.max(1,Math.round(project.width*scale)),height:Math.max(1,Math.round(project.height*scale)),maxBufferSide:maxSide});
}
async function renderAtSize(project,target,{original,background,width,height,maxBufferSide=null}) {
  target.width = width; target.height = height;
  const scaleX=width/project.width,scaleY=height/project.height;
  const context = target.getContext('2d');
  context.clearRect(0,0,target.width,target.height);
  if (background) { context.fillStyle = background; context.fillRect(0,0,target.width,target.height); }
  if (original && project.original) {
    const asset = project.assets[project.original.assetId];
    context.drawImage(await decodeImage(asset.source),0,0,asset.width*scaleX,asset.height*scaleY);
    return target;
  }
  for (const layer of project.layers) {
    if (!layer.visible || layer.opacity === 0) continue;
    if(layer.objectRegion) {
      const bounds=rasterRegionBounds(project,layer);
      if(bounds?.visible) {
        context.globalAlpha=layer.opacity*bounds.opacity;
        const raster=project.layers.find(item=>item.id===layer.objectRegion.rasterLayerId),region=layer.objectRegion.mask;
        context.save();context.scale(scaleX,scaleY);
        drawRasterRegionOverlay(context,project,raster,region,{bounds,maxBufferSide,color:layer.text.color,lineWidth:Math.max(1/Math.sqrt(scaleX*scaleY),2)});
        context.restore();
        context.globalAlpha=1;
      }
    }
    const source = layerSourceDimensions(project,layer);
    let bufferWidth=source.width,bufferHeight=source.height;
    if(maxBufferSide) {
      bufferWidth=Math.min(source.width,Math.max(1,Math.ceil(layer.width*scaleX)));
      bufferHeight=Math.min(source.height,Math.max(1,Math.ceil(layer.height*scaleY)));
      const bufferScale=Math.min(1,maxBufferSide/Math.max(bufferWidth,bufferHeight));
      bufferWidth=Math.max(1,Math.round(bufferWidth*bufferScale));bufferHeight=Math.max(1,Math.round(bufferHeight*bufferScale));
    }
    let buffer,brush,privateBuffer=false;
    try{
    if(layer.kind==='raster'){
      const prepared=await rasterPixels(project.assets[layer.assetId],source,layer,bufferWidth,bufferHeight);buffer=prepared.buffer;privateBuffer=!prepared.shared;
      // Masking must never alter a cached raster or another in-flight render.
      if(layer.mask.length&&prepared.shared){buffer=canvas(bufferWidth,bufferHeight);privateBuffer=true;buffer.getContext('2d').drawImage(prepared.buffer,0,0);}
      brush=buffer.getContext('2d');
    }else{
      buffer=canvas(bufferWidth,bufferHeight);privateBuffer=true;brush=buffer.getContext('2d');
      brush.scale(bufferWidth/source.width,bufferHeight/source.height);
      brush.filter = `brightness(${layer.brightness}%) contrast(${layer.contrast}%) saturate(${layer.saturation}%)`;
    }
    if (layer.kind === 'text') {
      const { content, fontSize, color, fontFamily } = layer.text, padding = Math.ceil(fontSize * 0.2);
      brush.font = `600 ${fontSize}px ${fontFamily}`;
      const lineHeight = fontSize * 1.25, metrics = brush.measureText('Mg');
      const ascent = metrics.fontBoundingBoxAscent ?? fontSize * 0.9, descent = metrics.fontBoundingBoxDescent ?? fontSize * 0.2;
      // CSS centers the font's ascent/descent inside each line box. Match the textarea
      // baseline so pressing Enter keeps the visible words at their preview location.
      const baseline = padding + ascent + (lineHeight - ascent - descent) / 2;
      brush.textBaseline = 'alphabetic'; brush.fillStyle = color;
      for (const [index,line] of content.split('\n').entries()) brush.fillText(line,padding,baseline + index * lineHeight);
    } else if (layer.kind === 'drawing') {
      brush.lineCap = 'round'; brush.lineJoin = 'round';
      brush.strokeStyle = layer.drawing.color; brush.lineWidth = layer.drawing.size;
      // One opaque stroke is composited once, so a highlight does not darken at intersections.
      strokePath(brush,layer.drawing.points);
    }
    brush.filter = 'none';
    brush.setTransform(1,0,0,1,0,0);
    if (layer.mask.length) {
      const visibility=canvas(1,1);
      try{maskCanvas(source,layer.mask,buffer,visibility);brush.globalCompositeOperation='destination-in';brush.drawImage(visibility,0,0);}
      finally{visibility.width=visibility.height=0;}
    }
    context.globalAlpha = layer.opacity;
    const rotation=normalizeRotation(layer.rotation??0);
    if(rotation) {
      context.save();context.scale(scaleX,scaleY);context.translate(layer.x+layer.width/2,layer.y+layer.height/2);context.rotate(rotation*Math.PI/180);
      context.drawImage(buffer,-layer.width/2,-layer.height/2,layer.width,layer.height);context.restore();
    } else context.drawImage(buffer,layer.x*scaleX,layer.y*scaleY,layer.width*scaleX,layer.height*scaleY);
    }finally{
      // Native mask copies can each be128 MiB. Release only this render's
      // private working pixels immediately, including failed/cancelled frames.
      // Cached immutable rasters and concurrent renders keep their own buffers.
      if(privateBuffer&&buffer)buffer.width=buffer.height=0;
    }
  }
  context.globalAlpha = 1;
  return target;
}
export async function exportImage(project, format = 'png', quality = 0.92) {
  if (!['png','jpeg'].includes(format)) throw new Error('Choose PNG or JPEG.');
  const target = canvas(project.width, project.height);
  await renderProject(project,target,{ background: format === 'jpeg' ? '#ffffff' : null });
  return new Promise((resolve,reject) => target.toBlob(blob => blob ? resolve(blob) : reject(new Error('Export failed. Try a smaller canvas.')), `image/${format}`, quality));
}
