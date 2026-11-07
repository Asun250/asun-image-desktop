// Object removal is an ordered, editable visibility mask. Original image bytes,
// references and the detected shapes remain available to Undo and saved files.
import {parseProject,validateProject} from './core.mjs';
import {validateObjectRegion} from './object-regions.mjs';

export function eraseObjectRegions(project,labelIds) {
  if(!Array.isArray(labelIds) || !labelIds.length || labelIds.some(id=>typeof id!=='string'))throw new Error('Select an object area before erasing.');
  validateProject(project);
  if(project.sketch)throw new Error('Render your sketch as an image before erasing objects. Your editable drawing stays in Draw / sketch reference.');
  // Resolve every selection before cloning/applying so a stale group cannot
  // leave a partly erased image. Native project parsing also migrates old files.
  const ids=[...new Set(labelIds)];
  for(const id of ids) {
    const label=project.layers.find(layer=>layer.id===id);
    if(label?.kind!=='text' || !label.objectRegion)throw new Error('This object area is no longer available. Select it again before erasing.');
    if(!label.visible || label.opacity===0)throw new Error('This object area is hidden. Show or select a visible area before erasing.');
    validateObjectRegion(label.objectRegion,project.assets,project.layers);
    const raster=project.layers.find(layer=>layer.id===label.objectRegion.rasterLayerId);
    if(!raster.visible || raster.opacity===0)throw new Error('The selected object belongs to a hidden image. Show that image before erasing.');
  }
  const next=parseProject(JSON.stringify(project));
  for(const id of ids) {
    const label=next.layers.find(layer=>layer.id===id),region=label.objectRegion;
    const raster=next.layers.find(layer=>layer.id===region.rasterLayerId);
    raster.mask.push({mode:'hide',region:structuredClone(region.mask),sourceWidth:region.sourceWidth,sourceHeight:region.sourceHeight});
    label.visible=false;
  }
  return validateProject(next);
}
