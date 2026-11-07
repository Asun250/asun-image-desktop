// A sketch stays editable. Detection receives a temporary, clean rendering of
// its scene content, while all masks remain anchored to the white drawing page.
import {renderProjectPreview} from './render.mjs';
import {isSketchProject,sketchSurfaceLayer,sketchContentLayers} from './sketch-project.mjs';
export {sketchContentLayers} from './sketch-project.mjs';

const signatures=new WeakMap();
export function sketchSurface(project) {
  if(!isSketchProject(project))return null;
  const raster=sketchSurfaceLayer(project),asset=project.assets[raster?.assetId];
  return raster?.kind==='raster'&&(raster.rotation??0)===0&&raster.visible&&raster.opacity>0&&asset&&raster.x===0&&raster.y===0&&raster.width===project.width&&raster.height===project.height&&asset.width===project.width&&asset.height===project.height?raster:null;
}
export function sketchContentSignature(project) {
  if(!sketchSurface(project))return null;
  if(signatures.has(project))return signatures.get(project);
  // Identity is exact, not a lossy image hash. Reference comments and selection
  // overlays do not invalidate results; a visible scene edit always does.
  const layers=sketchContentLayers(project).map(({id,kind,x,y,width,height,rotation,opacity,mask,brightness,contrast,saturation,assetId,text,drawing})=>({id,kind,x,y,width,height,rotation,opacity,mask,brightness,contrast,saturation,text,drawing,source:assetId?project.assets[assetId]?.source:undefined}));
  const signature=JSON.stringify({width:project.width,height:project.height,background:project.sketch.background||'#ffffff',layers});
  signatures.set(project,signature);return signature;
}
export async function sketchWorkingCopy(project,{maxSide=1600,crop=null}={}) {
  if(!sketchSurface(project))throw new Error('The sketch drawing page is unavailable. Reopen the sketch before detecting its subjects.');
  // Snapshot before image decoding yields, including transformed strokes and
  // image bytes, so an in-flight request can never describe a later edit.
  const layers=sketchContentLayers(project),assets=Object.fromEntries(layers.filter(layer=>layer.kind==='raster').map(layer=>[layer.assetId,project.assets[layer.assetId]]));
  const scene=structuredClone({width:project.width,height:project.height,assets,layers,original:null});
  if(crop){
    scene.width=crop.width;scene.height=crop.height;
    scene.layers=scene.layers.map(layer=>({...layer,x:layer.x-crop.x,y:layer.y-crop.y}));
  }
  const canvas=document.createElement('canvas');
  await renderProjectPreview(scene,canvas,{maxSide,background:project.sketch.background||'#ffffff'});
  return {source:canvas.toDataURL('image/png'),width:canvas.width,height:canvas.height};
}
