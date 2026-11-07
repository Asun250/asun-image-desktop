import {getBlockoutReview} from './blockout-review-settings.mjs';
import {getSceneConsistency} from './scene-consistency.mjs';

const need=(condition,message)=>{if(!condition)throw new Error(message);};
function byId(items,expected,description){
  need(Array.isArray(items)&&items.length===expected.length,`${description} are missing or do not match the current edit.`);
  const allowed=new Set(expected),mapped=new Map();
  for(const item of items){
    need(item&&typeof item.id==='string'&&allowed.has(item.id)&&!mapped.has(item.id),`${description} contain an unknown or duplicate image.`);
    mapped.set(item.id,item.image);
  }
  return mapped;
}

// Browser and server derive exactly the same logical order. The server supplies
// independent image decoders and dimension checks before any provider request.
export function imageGenerationInputOrder(plan,{composition=null,guide=null,referencePreviews=[],areaMasks=[]}={},
  {readOriginal=image=>image,readPreview=image=>image,identity=image=>image.source}={}){
  const {project}=plan,images=[],roles=[],settings=getBlockoutReview(project),consistency=getSceneConsistency(project);let review=null,structure=null;
  const add=(image,role)=>{images.push(image);roles.push({image:images.length,...role});};
  if(plan.hasComposition)add(readPreview(composition,project.width,project.height,'The composition image'),plan.isSketch?{role:'drawn scene composition',use:'Pencil content describes scene subjects, layout, pose and framing; transform it into the finished scene.'}:{role:'current composition'});
  else need(composition===null,'This project has no visible raster canvas; remove the unexpected composition image.');
  if(plan.hasGuide)add(readPreview(guide,project.width,project.height,'The annotation guide'),{role:'canvas annotation guide',use:'Locate numbered areas and drawn instructions; do not copy marks.'});
  else need(guide===null,'This project has no visible annotation layers; remove the unexpected guide image.');
  const guides=byId(referencePreviews,plan.referencePreviewIds,'Reference annotation guides');
  for(const reference of plan.references){
    const labels=plan.areas.filter(area=>area.referenceIds.includes(reference.id)).map(area=>area.label);
    const continuity=consistency.enabled&&consistency.continuity.referenceIds.includes(reference.id);
    add(readOriginal(reference),continuity?{role:'previous frame continuity reference',referenceId:reference.id,filename:reference.name,labels:[],scope:'continuity only',use:'Keep established identity, materials and lighting. Never copy this prior frame camera, placement, count, crop or pose; current original MAIN controls geometry.'}:{role:'original reference photo',referenceId:reference.id,filename:reference.name,labels,scope:labels.length?'matching numbered areas only':'global prompt'});
    if(guides.has(reference.id))add(readPreview(guides.get(reference.id),reference.width,reference.height,'The reference annotation guide'),{role:'reference annotation guide',referenceId:reference.id,use:'Instructions for this reference; not replacement original bytes.'});
  }
  const masks=byId(areaMasks,plan.maskAreas.map(area=>area.id),'Area selection masks');
  for(const area of plan.maskAreas)add(readPreview(masks.get(area.id),project.width,project.height,'The area selection mask'),{role:'area selection mask',areaId:area.id,label:area.label,groupAreaCount:area.selection.groupAreaCount,use:'WHITE selects pixels; BLACK excludes pixels; full-canvas coordinates.'});
  if(settings.enabled||consistency.enabled){
    const asset=project.assets[consistency.enabled?consistency.mainAssetId:settings.assetId],source=readOriginal(asset),existing=images.findIndex(image=>identity(image)===identity(source));
    const role={role:'original Blender blockout — structure authority',filename:asset.name,use:'Immutable source for camera, framing, placement, relative dimensions and occlusion. Appearance references cannot replace its structure.'};
    if(existing<0)add(source,role);else roles.push({image:existing+1,...role});
    structure={source:{...source,name:asset.name},sourceIndex:existing<0?images.length:existing+1};
    if(settings.enabled)review={...settings,...structure};
  }
  return {images,roles,review,...(consistency.enabled?{structure}:{})};
}
