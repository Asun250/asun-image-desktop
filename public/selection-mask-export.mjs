import {drawRasterRegionOverlay} from './render.mjs';
import {rasterRegionBounds} from './object-regions.mjs';

// Same full-canvas selection coordinates as generation. The exported mask is
// guidance/a compositing aid; it never claims to constrain provider pixels.
export function renderSelectionMask(project,layer,{maxSide=2600}={}) {
  const region=layer?.objectRegion,raster=project.layers.find(item=>item.id===region?.rasterLayerId);
  if(!region||!raster||raster.kind!=='raster')throw new Error('This selection has no source image layer.');
  const scale=Math.min(1,maxSide/Math.max(project.width,project.height));
  const canvas=document.createElement('canvas');
  canvas.width=Math.max(1,Math.round(project.width*scale));canvas.height=Math.max(1,Math.round(project.height*scale));
  const context=canvas.getContext('2d');context.fillStyle='#000000';context.fillRect(0,0,canvas.width,canvas.height);
  context.save();context.scale(canvas.width/project.width,canvas.height/project.height);
  drawRasterRegionOverlay(context,project,raster,region.mask,{bounds:rasterRegionBounds(project,layer),color:'#ffffff',fillOpacity:1,outlineOpacity:0,lineWidth:1,maxBufferSide:maxSide});
  context.restore();return canvas;
}
