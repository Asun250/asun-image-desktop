import {validateProject} from './core.mjs';
import {rasterRegionBounds,regionMaskInfo} from './object-regions.mjs';
import {layerPointToDocument,layerIntersectsCanvas} from './layer-transform.mjs';

const instruction='Remove the object inside this selection completely. Rebuild the background naturally from the surrounding scene, matching its perspective, textures, light and shadows. Do not replace it with another object, leave a transparent hole, or render selection marks. Keep unselected objects and the camera framing unchanged.';
function selectedAreas(project,ids){
  if(!Array.isArray(ids)||!ids.length||ids.length>14||new Set(ids).size!==ids.length)throw new Error('Select one or more areas to remove first.');
  const onCanvas=bounds=>bounds&&layerIntersectsCanvas(bounds,project);
  const regionOnCanvas=layer=>{
    const raster=rasterRegionBounds(project,layer);if(!raster||!onCanvas(raster))return false;
    const mask=layer.objectRegion.mask,[x,y,w,h]=regionMaskInfo(mask).bbox,width=w*raster.width/mask.width,height=h*raster.height/mask.height;
    const center=layerPointToDocument(raster,{x:(x+w/2)*raster.width/mask.width,y:(y+h/2)*raster.height/mask.height});
    return onCanvas({x:center.x-width/2,y:center.y-height/2,width,height,rotation:raster.rotation??0});
  };
  return ids.map(id=>{
    const layer=project.layers.find(item=>item.id===id);
    if(!layer?.objectRegion||!layer.visible||layer.opacity<=0||!rasterRegionBounds(project,layer)?.visible||!onCanvas(layer)||!regionOnCanvas(layer))throw new Error('Choose a visible selection on the current image before removing an object.');
    return layer;
  });
}

// Keep the complete native edit setup with the request. Only the provider plan
// below discards unrelated edit instructions and appearance references.
export function objectRemovalRequest(project,labelIds){
  validateProject(project);
  if(project.sketch)throw new Error('Generate your sketch as an image before removing objects. Your editable drawing stays in Draw / sketch reference.');
  selectedAreas(project,labelIds);
  const snapshot=structuredClone(project);
  snapshot.imageEditRequest={version:1,action:'remove-fill',labelIds:[...labelIds]};
  return snapshot;
}
export function applyObjectRemovalIntent(project){
  if(!project||typeof project!=='object'||!Object.hasOwn(project,'imageEditRequest'))return project;
  validateProject(project);
  if(project.sketch)throw new Error('Generate your sketch as an image before removing objects.');
  const intent=project.imageEditRequest;
  if(!intent||intent.version!==1||intent.action!=='remove-fill')throw new Error('This image removal request is unsupported. Select the area again.');
  const ids=new Set(selectedAreas(project,intent.labelIds).map(layer=>layer.id));
  const next=structuredClone(project);delete next.imageEditRequest;
  next.prompt=instruction;
  next.layers=next.layers.filter(layer=>layer.kind==='raster'||ids.has(layer.id));
  for(const layer of next.layers)if(ids.has(layer.id)){delete layer.referenceIds;delete layer.referenceId;layer.referenceComment=instruction;}
  next.references=[];next.variants=[];delete next.sheetPreset;delete next.sketch;delete next.sceneConsistency;
  return validateProject(next);
}
