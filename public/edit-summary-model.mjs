// A live view of current scene instructions. Nothing here changes saved state.
import {referenceLinks,labelComment} from './core.mjs';
import {objectRegionBounds,regionMaskInfo} from './object-regions.mjs';
import {layerPointToDocument,layerIntersectsCanvas} from './layer-transform.mjs';

const boundsOf=layer=>({x:layer.x,y:layer.y,width:layer.width,height:layer.height});
const intersects=(project,bounds)=>bounds.x<project.width&&bounds.y<project.height&&bounds.x+bounds.width>0&&bounds.y+bounds.height>0;
// Keep this rule aligned with reference-board.mjs: a visible, on-canvas label
// appears on MAIN even when its region's raster is hidden or outside the canvas.
const visibleLabel=(project,layer)=>layer.kind==='text'&&layer.visible&&layer.opacity>0&&intersects(project,layer);
const instruction=layer=>labelComment(layer).trim()?labelComment(layer):'';
const numeric=label=>/^\d+$/.test(label)?label.replace(/^0+(?=\d)/,''):null;

function compareItems(a,b) {
  const left=numeric(a.label),right=numeric(b.label);
  if(left!==null&&right!==null)return left.length-right.length||(left<right?-1:left>right?1:0)||a.layerIndex-b.layerIndex;
  if(left!==null)return -1;
  if(right!==null)return 1;
  return a.layerIndex-b.layerIndex;
}

function regionSource(project,layer) {
  const region=layer.objectRegion;
  if(!region)return null;
  const raster=project.layers.find(item=>item.id===region.rasterLayerId&&item.kind==='raster'&&item.assetId===region.assetId),asset=project.assets[region.assetId];
  if(!raster||!asset)return null;
  const [x,y,width,height]=regionMaskInfo(region.mask).bbox;
  return {raster,asset,nativeBounds:{x:x*asset.width/region.mask.width,y:y*asset.height/region.mask.height,width:width*asset.width/region.mask.width,height:height*asset.height/region.mask.height}};
}

function regionIntersectsCanvas(project,source) {
  const {raster,asset,nativeBounds:bounds}=source;
  const width=bounds.width*raster.width/asset.width,height=bounds.height*raster.height/asset.height;
  const center=layerPointToDocument(raster,{x:(bounds.x+bounds.width/2)*raster.width/asset.width,y:(bounds.y+bounds.height/2)*raster.height/asset.height});
  return layerIntersectsCanvas({x:center.x-width/2,y:center.y-height/2,width,height,rotation:raster.rotation??0},project);
}

function labelConflicts(project) {
  const labels=new Map(),conflicts=new Map();
  for(const layer of project.layers) {
    if(!visibleLabel(project,layer))continue;
    const label=layer.text.content.trim();
    if(!labels.has(label))labels.set(label,[]);
    labels.get(label).push({id:layer.id,photos:JSON.stringify(referenceLinks(layer).sort()),comment:instruction(layer)});
  }
  for(const group of labels.values()) {
    const reasons=[];
    if(new Set(group.map(item=>item.photos)).size>1)reasons.push('This label is linked to different photos. Use a different number or the same reference photos.');
    if(new Set(group.map(item=>item.comment)).size>1)reasons.push('This label has different instructions. Use a different number or the same instruction.');
    if(reasons.length)for(const item of group)conflicts.set(item.id,reasons);
  }
  return conflicts;
}

/**
 * One entry per current scene label; saved variants and unassigned photos are
 * not additional areas. Reference/source objects are read-only views of the
 * project, retaining all original bytes, photo notes and editable annotations.
 * boardIncluded describes whether the label is rendered on MAIN, not whether
 * it already has a reference or instruction tile. pending labels remain listed.
 */
export function editSummary(project) {
  const references=new Map(project.references.map(reference=>[reference.id,reference])),conflicts=labelConflicts(project),items=[];
  for(const [layerIndex,layer] of project.layers.entries()) {
    if(layer.kind!=='text')continue;
    const literalLabel=layer.text.content,label=literalLabel.trim(),referenceIds=referenceLinks(layer),comment=labelComment(layer);
    if(!layer.objectRegion&&!referenceIds.length&&!comment.trim()&&!/^\d+$/.test(label))continue;
    const linked=referenceIds.map(referenceId=>references.get(referenceId)).filter(Boolean),boardIncluded=visibleLabel(project,layer),exclusionReasons=[],warnings=[];
    if(!layer.visible)exclusionReasons.push('Label is hidden.');
    if(layer.opacity<=0)exclusionReasons.push('Label opacity is zero.');
    if(!intersects(project,layer))exclusionReasons.push('Label is outside the canvas.');
    const source=regionSource(project,layer),regionBounds=layer.objectRegion?objectRegionBounds(project,layer):null;
    if(layer.objectRegion&&!source)warnings.push('The selected area has no source image layer.');
    if(source) {
      if(!source.raster.visible||source.raster.opacity<=0)warnings.push('The selected area’s image layer is hidden.'+(boardIncluded?' Its visible label and instructions still appear on the board.':''));
      if(regionBounds&&!regionIntersectsCanvas(project,source))warnings.push('The selected area is outside the canvas.'+(boardIncluded?' Its visible label and instructions still appear on the board.':''));
    }
    const conflictReasons=conflicts.get(layer.id)||[],pending=!linked.length&&!comment.trim(),conflict=conflictReasons.length>0;
    items.push({layerId:layer.id,layerIndex,literalLabel,label,comment,references:linked,referenceIds,objectRegion:layer.objectRegion||null,regionBounds,regionSource:source,labelBounds:boundsOf(layer),boardIncluded,status:!boardIncluded?'excluded':conflict?'conflict':pending?'pending':'ready',exclusionReasons,warnings,pending,conflict,conflictReasons});
  }
  items.sort(compareItems);
  const included=items.filter(item=>item.boardIncluded),allReferences=new Set(items.flatMap(item=>item.referenceIds)),includedReferences=new Set(included.flatMap(item=>item.referenceIds));
  return {items,globalPrompt:project.prompt,counts:{total:items.length,included:included.length,excluded:items.length-included.length,withComments:items.filter(item=>item.comment.trim()).length,withReferences:items.filter(item=>item.references.length).length,referenceLinks:items.reduce((total,item)=>total+item.references.length,0),uniqueReferences:allReferences.size,includedReferenceLinks:included.reduce((total,item)=>total+item.references.length,0),includedUniqueReferences:includedReferences.size,unassignedReferences:project.references.filter(reference=>!allReferences.has(reference.id)).length,pending:items.filter(item=>item.pending).length,conflicts:items.filter(item=>item.conflict).length,withRegions:items.filter(item=>item.objectRegion).length}};
}
