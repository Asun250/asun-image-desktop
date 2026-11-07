// Fit the document to a retained native photo. Only current layer transforms
// change; original bytes, masks, annotation grids and variant snapshots do not.
import {dimensions,validateProject} from './core.mjs';
import {sourceFileInfo} from './image-source.mjs';
import {normalizeRotation,layerBounds} from './layer-transform.mjs';

const sourceChecks=new WeakMap();
const finite=value=>typeof value==='number'&&Number.isFinite(value);
function sourceIsAvailable(asset){
  if(!asset||typeof asset!=='object')return false;
  const file=asset.originalFile,metadataKey=JSON.stringify([Object.hasOwn(asset,'originalFile'),file?.name,file?.mimeType,file?.byteLength]),previous=sourceChecks.get(asset);
  if(previous?.source===asset.source&&previous.width===asset.width&&previous.height===asset.height&&previous.metadataKey===metadataKey)return previous.valid;
  let valid=false;
  try{
    dimensions(asset.width,asset.height);
    const information=sourceFileInfo(asset);
    valid=asset.source.startsWith(`data:${information.mimeType};base64,`);
    if(Object.hasOwn(asset,'originalFile'))valid=valid&&file&&typeof file.name==='string'&&file.name.length>0&&file.name.length<=500&&file.mimeType===information.mimeType&&file.byteLength===information.byteLength;
  }catch{valid=false;}
  sourceChecks.set(asset,{source:asset.source,width:asset.width,height:asset.height,metadataKey,valid});
  return valid;
}
function fitGeometry(project,raster){
  const asset=project.assets?.[raster?.assetId];
  if(raster?.kind!=='raster'||!raster.visible||!finite(raster.opacity)||raster.opacity<=0||raster.opacity>1||asset?.id!==raster.assetId||!sourceIsAvailable(asset))return null;
  if(!finite(raster.x)||!finite(raster.y)||!finite(raster.width)||!finite(raster.height)||raster.width<1||raster.height<1||raster.width>32768||raster.height>32768)return null;
  const scaleX=asset.width/raster.width,scaleY=asset.height/raster.height;
  const rotation=normalizeRotation(raster.rotation??0),uniform=Math.abs(scaleX-scaleY)<=1e-10*Math.max(scaleX,scaleY);
  let width=asset.width,height=asset.height;
  if(rotation) {
    // A uniform canvas transform preserves every existing layer, mask and
    // upright number. Include all rotated corners instead of clipping them to
    // the source's unrotated width/height.
    if(!uniform&&project.layers.length>1)return {asset,layers:[],width,height,valid:false,error:'Restore the photo\'s original aspect ratio before fitting a rotated canvas with other layers. This keeps those layers from being skewed.'};
    const native={...raster,x:0,y:0,width:asset.width,height:asset.height},bounds=layerBounds(native);
    width=Math.ceil(bounds.width);height=Math.ceil(bounds.height);
    const nextRaster={x:-bounds.x+(width-bounds.width)/2,y:-bounds.y+(height-bounds.height)/2,width:asset.width,height:asset.height};
    const dx=nextRaster.x+nextRaster.width/2-(raster.x+raster.width/2)*scaleX,dy=nextRaster.y+nextRaster.height/2-(raster.y+raster.height/2)*scaleX;
    const layers=project.layers.map(layer=>layer.id===raster.id?nextRaster:{x:layer.x*scaleX+dx,y:layer.y*scaleX+dy,width:layer.width*scaleX,height:layer.height*scaleX});
    let valid=layers.every(layer=>finite(layer.x)&&finite(layer.y)&&Math.abs(layer.x)<=1e6&&Math.abs(layer.y)<=1e6&&finite(layer.width)&&finite(layer.height)&&layer.width>=1&&layer.height>=1&&layer.width<=32768&&layer.height<=32768);
    try{dimensions(width,height);}catch{valid=false;}
    return {asset,layers,width,height,valid};
  }
  if(!uniform&&project.layers.some(layer=>layer.kind==='raster'&&normalizeRotation(layer.rotation??0)%90!==0))return {asset,layers:[],width,height,valid:false,error:'Fit this photo with its original aspect ratio to preserve the other rotated layers without skewing them.'};
  const layers=project.layers.map(layer=>{
    if(!layer)return {x:NaN,y:NaN,width:NaN,height:NaN};
    if(layer.id===raster.id)return {x:0,y:0,width:asset.width,height:asset.height};
    if(!uniform&&Math.abs(normalizeRotation(layer.rotation??0))===90) {
      const w=layer.width*scaleY,h=layer.height*scaleX;
      return {x:(layer.x+layer.width/2-raster.x)*scaleX-w/2,y:(layer.y+layer.height/2-raster.y)*scaleY-h/2,width:w,height:h};
    }
    return {x:(layer.x-raster.x)*scaleX,y:(layer.y-raster.y)*scaleY,width:layer.width*scaleX,height:layer.height*scaleY};
  });
  const valid=layers.every(layer=>finite(layer.x)&&finite(layer.y)&&Math.abs(layer.x)<=1e6&&Math.abs(layer.y)<=1e6&&finite(layer.width)&&finite(layer.height)&&layer.width>=1&&layer.height>=1&&layer.width<=32768&&layer.height<=32768);
  return {asset,layers,width,height,valid};
}

/** Prefer the selected photo. Without one, a sole raster is unambiguous. */
export function canvasImageFitTarget(project,selectedId){
  if(!project||!Array.isArray(project.layers)||!project.assets)return null;
  const selected=project.layers.find(layer=>layer?.id===selectedId);
  if(selected?.kind==='raster'){
    const geometry=fitGeometry(project,selected);
    if(geometry?.valid)return selected;
  }
  const rasters=project.layers.filter(layer=>layer?.kind==='raster');
  if(rasters.length!==1)return null;
  const geometry=fitGeometry(project,rasters[0]);
  return geometry?.valid?rasters[0]:null;
}

/** A disabled no-op button need not create another history entry. */
export function canvasImageFitChanges(project,layerId){
  if(!project||!Array.isArray(project.layers))return false;
  const raster=project.layers.find(layer=>layer?.id===layerId),geometry=fitGeometry(project,raster);
  if(!geometry?.valid)return false;
  return project.width!==geometry.width||project.height!==geometry.height||geometry.layers.some((bounds,index)=>Object.entries(bounds).some(([key,value])=>project.layers[index][key]!==value));
}

/**
 * Restore native dimensions and aspect, mapping annotations with the photo.
 * No coordinate rounding is applied to other layers. The raster is assigned
 * exact integer native bounds, avoiding subpixel transparent canvas borders.
 */
export function fitCanvasToImage(project,layerId){
  validateProject(project);
  const raster=project.layers.find(layer=>layer.id===layerId),geometry=fitGeometry(project,raster);
  if(!geometry)throw new Error('Choose a visible image layer with its original source available.');
  if(!geometry.valid)throw new Error(geometry.error||'Fitting this image would move or resize another layer beyond the editor limits. Keep layer sizes between 1 and 32768 pixels and positions within 1,000,000 pixels.');
  if(!canvasImageFitChanges(project,layerId))return project;
  const next=structuredClone(project);
  next.width=geometry.width;next.height=geometry.height;
  next.layers.forEach((layer,index)=>Object.assign(layer,geometry.layers[index]));
  return validateProject(next);
}
