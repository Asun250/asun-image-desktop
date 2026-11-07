// Ordinary image generation uses the current canvas and its explicit edit
// instructions. Sheet presets and saved variants never supply generation rules.
import {validateProject, referenceLinks, referenceProject, labelComment} from './core.mjs';
import {renderProjectPreview, drawRasterRegionOverlay} from './render.mjs';
import {rasterRegionBounds, objectRegionBounds} from './object-regions.mjs';
import {isSketchProject, sketchContentLayers} from './sketch-project.mjs';
import {applyObjectRemovalIntent} from './object-removal-request.mjs';
import {layerIntersectsCanvas} from './layer-transform.mjs';
import {imageGenerationInputOrder} from './image-generation-input-order.mjs';
import {planGenerationInputPacking,renderGenerationInputBoards} from './generation-input-packing.mjs';
import {getSceneConsistency,sceneConsistencyInstructions,sceneConsistencyPreflight} from './scene-consistency.mjs';
import {imageOutputInstructions,isSelectedAreaEdit} from './image-output-settings.mjs';

export const IMAGE_GENERATION_MAX_INPUTS = 16;
export const IMAGE_GENERATION_MAX_BYTES = 64 * 1024 * 1024;
export const IMAGE_GENERATION_PREVIEW_SIDE = 2600;
const need = (condition, message) => {if (!condition) throw new Error(message);};
const visible = (project, layer) => Boolean(layer?.visible && layer.opacity > 0 && layerIntersectsCanvas(layer,project));
const visibleArea = (project, layer) => {
  if (layer?.kind !== 'text' || !visible(project, layer)) return false;
  if (!layer.objectRegion) return true;
  const raster = project.layers.find(item => item.id === layer.objectRegion.rasterLayerId);
  return visible(project, raster);
};

/** Cheap UI eligibility check. Full validation still happens before submission. */
export function hasImageGenerationInstructions(project) {
  if (project.sceneConsistency?.enabled) return true;
  if (typeof project?.prompt === 'string' && project.prompt.trim()) return true;
  if (isSketchProject(project) && sketchContentLayers(project).some(layer => layer.id !== project.sketch.surfaceLayerId && visible(project, layer))) return true;
  return Array.isArray(project?.layers) && project.layers.some(layer => visibleArea(project, layer) && (labelComment(layer).trim() || referenceLinks(layer).length > 0));
}

export function imageGenerationPreviewDimensions(width, height) {
  const scale = Math.min(1, IMAGE_GENERATION_PREVIEW_SIDE / Math.max(width, height));
  return {width:Math.max(1, Math.round(width * scale)), height:Math.max(1, Math.round(height * scale))};
}

// A selected-area edit shares one native coordinate grid across the visible
// composition, annotation guide and every selection mask. Reference annotations
// retain the ordinary preview cap because they describe separate images.
export function imageGenerationCanvasDimensions(project) {
  return isSelectedAreaEdit(project)
    ? {width:project.width,height:project.height}
    : imageGenerationPreviewDimensions(project.width,project.height);
}

/** Shared, DOM-free plan used by both browser rendering and server preflight. */
export function imageGenerationPlan(input) {
  const project = applyObjectRemovalIntent(structuredClone(input));
  if (project && typeof project === 'object') {
    delete project.sheetPreset;
    for (const variant of project.variants || []) delete variant.sheetPreset;
  }
  validateProject(project);
  need(hasImageGenerationInstructions(project), 'Describe the image you want, or add an instruction or reference to a visible numbered area before generating.');
  const rasterLayers = project.layers.filter(layer => layer.kind === 'raster' && visible(project, layer));
  const isSketch = isSketchProject(project);
  const compositionLayers = isSketch ? sketchContentLayers(project).filter(layer => visible(project, layer)) : rasterLayers;
  const contentIds = new Set(compositionLayers.map(layer => layer.id));
  const annotationLayers = project.layers.filter(layer => !contentIds.has(layer.id) && layer.kind !== 'raster' && visible(project, layer) && (!layer.objectRegion || visibleArea(project, layer)));
  const areas = [], signatures = new Map();
  for (const layer of annotationLayers) {
    if (layer.kind !== 'text') continue;
    const referenceIds = referenceLinks(layer), instruction = labelComment(layer);
    if (!referenceIds.length && !instruction.trim() && !layer.objectRegion) continue;
    const label = layer.text.content.trim();
    need(label, 'Give each referenced area a readable number or label before generating.');
    const signature = JSON.stringify([referenceIds.slice().sort(), instruction.trim() ? instruction : '']);
    need(!signatures.has(label) || signatures.get(label) === signature, `Label “${label.slice(0, 80)}” has different references or instructions. Use different numbers before generating.`);
    signatures.set(label, signature);
    const region = layer.objectRegion;
    areas.push({id:layer.id, label, instruction, referenceIds,
      labelBounds:{x:layer.x, y:layer.y, width:layer.width, height:layer.height},
      ...(region ? {selection:{assetId:region.assetId, rasterLayerId:region.rasterLayerId,
        bounds:objectRegionBounds(project, layer), groupAreaCount:region.group?.areaCount || 1,
        mask:structuredClone(region.mask)}} : {})});
  }
  const linkedAnywhere = new Set(project.layers.flatMap(layer => referenceLinks(layer)));
  const selectedIds = new Set(areas.flatMap(area => area.referenceIds));
  // A photo linked only to a hidden/off-canvas label is not a global reference.
  // Truly unlinked photos guide the global prompt when one has been provided.
  const consistency=getSceneConsistency(project),continuityIds=new Set(consistency.enabled?consistency.continuity.referenceIds:[]);
  const preflight=sceneConsistencyPreflight(project);
  need(!preflight.errors.length,preflight.errors.join(' '));
  const references = project.references.filter(reference => continuityIds.has(reference.id) || selectedIds.has(reference.id) || ((project.prompt.trim()||consistency.enabled) && !linkedAnywhere.has(reference.id)));
  const referencePreviewIds = references.filter(reference => (reference.annotations || []).some(layer => visible(reference, layer))).map(reference => reference.id);
  const hasComposition = compositionLayers.length > 0, hasGuide = annotationLayers.length > 0;
  const maskAreas = areas.filter(area => area.selection);
  const imageCount = Number(hasComposition) + Number(hasGuide) + references.length + referencePreviewIds.length + maskAreas.length;
  return {project, isSketch, rasterLayers, compositionLayers, annotationLayers, areas, references, referencePreviewIds, maskAreas, hasComposition, hasGuide, imageCount, continuityIds};
}

/** Every uploaded image has a numbered, unambiguous role in the edit request. */
export function buildImageGenerationPrompt(project, imageRoles = [], {compact=false,output=null} = {}) {
  const plan = imageGenerationPlan(project), {areas, references} = plan;
  const roles = imageRoles.map(role => ({...role}));
  const referenceMap = references.map(reference => ({id:reference.id, filename:reference.originalFile?.name || reference.name,
    scope:plan.continuityIds.has(reference.id)?'previous frame continuity only; never current geometry':areas.some(area => area.referenceIds.includes(reference.id)) ? 'matching numbered areas only' : 'global prompt',
    labels:plan.continuityIds.has(reference.id)?[]:areas.filter(area => area.referenceIds.includes(reference.id)).map(area => area.label), notes:reference.notes || ''}));
  const areaMap = areas.map(({selection, ...area}) => ({...area,referenceIds:area.referenceIds.filter(id=>!plan.continuityIds.has(id)), ...(selection ? {selection:{bounds:selection.bounds, groupAreaCount:selection.groupAreaCount,
    shape:'Use this area’s white-on-black selection-mask image; its bounding rectangle is not the selection.'}} : {})}));
  return [
    'Create ONE finished image from the image request below. Return the finished image itself.',
    plan.isSketch
      ? 'The composition image is the user’s DRAWN SCENE REFERENCE. Its pencil strokes, shapes and included content express the subjects, placement, poses, relative scale, perspective and framing of the intended scene. Turn that sketch into one finished image following the user’s prompt and mapped appearance references. Preserve the intended scene arrangement. The white sketch surface is drawing paper, not a required final white background. Do not discard the drawn subjects as annotation marks or reproduce rough construction lines unless the user requests a sketch style.'
      : plan.hasComposition
      ? plan.project.sceneConsistency?.enabled
        ? 'The composition image is the current working canvas. The separately identified original MAIN is the structural authority. Use the current canvas and annotation guide to locate numbered selections, while retaining the original MAIN camera, framing, scale and overlaps.'
        : 'The composition image is the CURRENT visible raster canvas, including placement, cropping, layer opacity, masking and color adjustments. Use it as the composition and appearance base. Preserve its arrangement and unrequested details unless the global prompt explicitly asks to change them.'
      : 'There is no base composition image. Create a new image from the global prompt and any explicitly mapped references.',
    output ? imageOutputInstructions(output) : plan.project.sceneConsistency?.enabled
      ? `The working canvas is ${plan.project.width} × ${plan.project.height} pixels. Preserve the selected original MAIN aspect ratio and framing without crop or stretch; working-canvas transforms do not replace MAIN.`
      : plan.hasComposition ? `The working canvas is ${plan.project.width} × ${plan.project.height} pixels. Keep its aspect and framing where practical.`
      : 'The empty working canvas is not a composition reference and must not override the requested output framing.',
    plan.isSketch
      ? 'The annotation guide repeats the clean sketch composition with added selection marks. Only its additional numbers, colored outlines, selection shading and highlights are editing instructions; do not copy these marks into the result. Subjects and scene lines already present in the clean sketch composition remain the scene reference. Written notes describe intent; render text in the finished artwork only when the user explicitly requests that text.'
      : 'Annotation guides are separate instructions. Their numbers, colored outlines, selection shading, arrows, highlights and drawn notes identify where to edit. Do not copy these marks into the result. Render text as part of the artwork only when the user explicitly requests that text.',
    'Each selection-mask image is aligned to the full working canvas: WHITE pixels are the selected area, BLACK pixels are outside it. Apply that area’s instruction and references only inside its selection. A group can contain disconnected objects: apply its shared instruction to every white component, not the gaps or the entire bounding rectangle. Masks are guidance to the image model, not a guarantee of pixel-identical preservation.',
    'Original reference images supply appearance details. A reference annotation preview is guidance for its matching original; do not reproduce its markings. Respect photo notes and apply area-linked references only to their matching labels. Global references guide the global prompt.',
    'Image order and roles:\n' + JSON.stringify(roles, null, compact?0:2),
    'User’s global image prompt:\n' + (plan.project.prompt.trim() || (plan.isSketch ? '(Develop the drawn scene into a finished image, following the numbered area instructions and appearance references.)' : '(No global change requested; follow the numbered area instructions.)')),
    'Numbered area instructions and reference mapping:\n' + JSON.stringify(areaMap, null, compact?0:2),
    'Reference photo notes:\n' + JSON.stringify(referenceMap, null, compact?0:2),
    ...(plan.project.sceneConsistency?.enabled?[sceneConsistencyInstructions(plan.project)]:[]),
    'Return one finished image without editor UI, explanatory panels, or reference-guide marks.',
  ].join('\n\n');
}

const encodedBytes = image => {
  const payload = image?.source?.split(',')[1] || '';
  return Math.floor(payload.length * 3 / 4) - (payload.endsWith('==') ? 2 : payload.endsWith('=') ? 1 : 0);
};
function previewImage(canvas, name) {
  return {name, source:canvas.toDataURL('image/png'), width:canvas.width, height:canvas.height};
}
function canvas() {return document.createElement('canvas');}

/** Build only previews; preserved original reference bytes stay in the project. */
export async function buildImageGenerationInput(input) {
  const plan = imageGenerationPlan(input), {project} = plan;
  const canvasDimensions=imageGenerationCanvasDimensions(project),canvasMaxSide=Math.max(canvasDimensions.width,canvasDimensions.height);
  let bytes = plan.references.reduce((sum, reference) => sum + encodedBytes(reference), 0);
  const keep = image => {
    bytes += encodedBytes(image);
    need(bytes <= IMAGE_GENERATION_MAX_BYTES, 'Use images totaling no more than 64 MB, including composition and annotation guides. Reduce the canvas or references before generating.');
    return image;
  };
  need(bytes <= IMAGE_GENERATION_MAX_BYTES, 'Use reference images totaling no more than 64 MB.');
  const composition = plan.hasComposition
    ? keep(previewImage(await renderProjectPreview({...project, layers:plan.compositionLayers}, canvas(), {maxSide:canvasMaxSide}), plan.isSketch ? 'Sketch composition.png' : 'Current composition.png')) : null;
  const guide = plan.hasGuide
    ? keep(previewImage(await renderProjectPreview({...project, layers:project.layers.filter(layer => plan.compositionLayers.includes(layer) || plan.annotationLayers.includes(layer))}, canvas(), {maxSide:canvasMaxSide}), 'Canvas annotation guide.png')) : null;
  const referencePreviews = [];
  for (const id of plan.referencePreviewIds) {
    const reference = plan.references.find(item => item.id === id);
    const preview = await renderProjectPreview(referenceProject(reference), canvas(), {maxSide:IMAGE_GENERATION_PREVIEW_SIDE});
    referencePreviews.push({id, image:keep(previewImage(preview, `${reference.name} annotation guide.png`))});
  }
  const areaMasks = [];
  for (const area of plan.maskAreas) {
    const target = canvas(), size = canvasDimensions;
    target.width = size.width;target.height = size.height;
    const context = target.getContext('2d');context.fillStyle = '#000000';context.fillRect(0, 0, size.width, size.height);
    const layer = project.layers.find(item => item.id === area.id), raster = plan.rasterLayers.find(item => item.id === area.selection.rasterLayerId);
    const bounds = rasterRegionBounds(project, layer), sx = size.width / project.width, sy = size.height / project.height;
    context.save();context.scale(sx,sy);
    drawRasterRegionOverlay(context, project, raster, area.selection.mask, {bounds,
      color:'#ffffff', fillOpacity:1, outlineOpacity:0, lineWidth:1, maxBufferSide:canvasMaxSide});
    context.restore();
    areaMasks.push({id:area.id, image:keep(previewImage(target, `Area ${area.label} selection mask.png`))});
  }
  const requestInput={project,composition,guide,referencePreviews,areaMasks};
  const logical=imageGenerationInputOrder(plan,requestInput),packing=planGenerationInputPacking(logical.images,logical.roles);
  need(logical.images.reduce((sum,image)=>sum+encodedBytes(image),0)<=IMAGE_GENERATION_MAX_BYTES,'Use input images totaling no more than 64 MB, including the original blockout and guides.');
  if(!packing.packed)return requestInput;
  const inputBoards=await renderGenerationInputBoards(logical.images,packing);
  const boardBytes=inputBoards.reduce((sum,board)=>sum+encodedBytes(board.image),0);
  const singleBytes=packing.slots.filter(slot=>slot.kind==='single').reduce((sum,slot)=>sum+encodedBytes(logical.images[slot.sourceIndex-1]),0);
  need(boardBytes+singleBytes<=IMAGE_GENERATION_MAX_BYTES,'The packed images exceed 64 MB. Reduce image sizes; no references were dropped.');
  return {...requestInput,inputBoards,inputPacking:{version:1,logicalInputCount:packing.logicalInputCount,physicalInputCount:packing.physicalInputCount,boardCount:inputBoards.length}};
}
