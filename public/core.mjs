import {validateSketchMetadata} from './sketch-project.mjs';
import {validateBlockoutReview} from './blockout-review-settings.mjs';
import {validateSceneConsistency} from './scene-consistency.mjs';
import {validateImageOutput} from './image-output-settings.mjs';
import {validateSheetPreset} from './sheet-preset.mjs';
import {cloneEditableData,sameEditableData} from './editable-data.mjs';
import {isRasterDataURL} from './image-source-validation.mjs';
// Serializable image-editor state. Source image bytes are never modified.
import {validateObjectRegion,validateRegionMask} from './object-regions.mjs';
import {normalizeRotation,documentPointToLayer,layerPointToDocument} from './layer-transform.mjs';
export const FORMAT = 'asun-image';
export const VERSION = 3;
export const MAX_DIMENSION = 8192;
export const MAX_PIXELS = 32_000_000;
export const MAX_LAYERS = 100;
export const MAX_STROKE_POINTS = 50000;
export const MAX_TEXT_LENGTH = 10000;
export const MAX_REFERENCE_NOTE_LENGTH = 2000;
export const MAX_LABEL_COMMENT_LENGTH = 2000;
export const TEXT_FONTS = ['Arial','Georgia','Courier New','Verdana','Trebuchet MS'];
const copy = cloneEditableData;
const id = () => globalThis.crypto.randomUUID();
const finite = value => typeof value === 'number' && Number.isFinite(value);
const isRaster = isRasterDataURL;
const isColor = value => typeof value === 'string' && /^#[0-9a-f]{6}$/i.test(value);
function requireThat(condition, message) { if (!condition) throw new Error(message); }
function sourceMetadata(image) {
  const metadata={};
  if(Object.hasOwn(image,'originalFile'))metadata.originalFile=copy(image.originalFile);
  if(Object.hasOwn(image,'preview'))metadata.preview=copy(image.preview);
  return metadata;
}
function sourceHeader(image,length=16) {
  try {return atob(image.source.slice(image.source.indexOf(',')+1,image.source.indexOf(',')+1+length));}catch {return '';}
}
function headerMime(header) {
  if(header.startsWith('\x89PNG\r\n\x1a\n'))return 'image/png';
  if(header.startsWith('\xff\xd8\xff'))return 'image/jpeg';
  if(header.startsWith('RIFF')&&header.slice(8,12)==='WEBP')return 'image/webp';
  return null;
}
function validateSourceMetadata(image) {
  if(Object.hasOwn(image,'originalFile')) {
    const file=image.originalFile,payload=image.source.slice(image.source.indexOf(',')+1),padding=payload.endsWith('==')?2:payload.endsWith('=')?1:0;
    requireThat(file&&typeof file.name==='string'&&file.name.length>0&&file.name.length<=500&&['image/png','image/jpeg','image/webp'].includes(file.mimeType)&&image.source.startsWith(`data:${file.mimeType};base64,`)&&headerMime(sourceHeader(image))===file.mimeType&&Number.isInteger(file.byteLength)&&file.byteLength>0&&file.byteLength<=50*1024*1024&&file.byteLength===Math.floor(payload.length*3/4)-padding,'Invalid original file information.');
  }
  if(Object.hasOwn(image,'preview')) {
    const preview=image.preview;
    requireThat(preview&&preview.kind==='generated-thumbnail'&&typeof preview.source==='string'&&/^data:image\/png;base64,[A-Za-z0-9+/=]+$/.test(preview.source)&&preview.source.length<=2_000_000&&Number.isInteger(preview.width)&&Number.isInteger(preview.height)&&preview.width>=1&&preview.height>=1&&preview.width<=512&&preview.height<=512,'Invalid generated image thumbnail.');
    const header=sourceHeader(preview,32),number=offset=>[0,1,2,3].reduce((value,index)=>value*256+header.charCodeAt(offset+index),0);
    requireThat(headerMime(header)==='image/png'&&header.slice(12,16)==='IHDR'&&number(16)===preview.width&&number(20)===preview.height,'The generated thumbnail does not match its saved dimensions.');
  }
}
function baseLayer(name, kind, x, y, width, height) {
  return { id: id(), kind, name: String(name).slice(0,200), x, y, width, height, visible: true, opacity: 1, mask: [], brightness: 100, contrast: 100, saturation: 100 };
}
function validatePoints(points, description) {
  requireThat(Array.isArray(points) && points.length > 0 && points.length <= MAX_STROKE_POINTS, `Invalid ${description} stroke.`);
  for (const point of points) requireThat(Array.isArray(point) && point.length === 2 && point.every(value => finite(value) && Math.abs(value) <= 1e6), `Invalid ${description} point.`);
}
function validateSourceSize(width, height) {
  requireThat(Number.isInteger(width) && Number.isInteger(height) && width >= 1 && height >= 1 && width <= 32768 && height <= 32768 && width * height <= MAX_PIXELS, 'Invalid annotation source size.');
}
function editableProject(project) {
  if (project.version !== VERSION) return migrateProject(project);
  return copy(project);
}
export function dimensions(width, height) {
  requireThat(Number.isInteger(width) && Number.isInteger(height) && width > 0 && height > 0 && width <= MAX_DIMENSION && height <= MAX_DIMENSION && width * height <= MAX_PIXELS, 'Choose dimensions up to 8192 px per side and 32 megapixels in total.');
  return { width, height };
}
export function newProject(width = 1600, height = 1000, name = 'Untitled') {
  return { format: FORMAT, version: VERSION, name, ...dimensions(width, height), assets: {}, layers: [], references: [], prompt: '', variants: [], original: null };
}
export function addRaster(project, image, options = {}) {
  const { name, source, width, height }=image;
  dimensions(width, height);
  requireThat(isRaster(source), 'Use a PNG, JPEG, or WebP image.');
  requireThat(project.layers.length < MAX_LAYERS, 'This project already has 100 layers.');
  const next = editableProject(project), assetId = id();
  next.assets[assetId] = { id: assetId, name: String(name || 'Image').slice(0,500), source, width, height, ...sourceMetadata(image) };
  validateSourceMetadata(next.assets[assetId]);
  if (!next.layers.length && options.fitDocument !== false) Object.assign(next, { width, height });
  const scale = Math.min(1, next.width / width, next.height / height);
  const layer = { ...baseLayer(name || 'Image', 'raster', (next.width - width * scale) / 2, (next.height - height * scale) / 2, width * scale, height * scale), assetId };
  next.layers.push(layer);
  if (!next.original) next.original = { assetId, width: next.width, height: next.height };
  return { project: next, layerId: layer.id };
}
// Annotation content stays editable; transforms act on a stable source coordinate system.
export function addText(project, { content, x, y, fontSize = 36, color = '#eba76f', width, height, fontFamily = 'Arial' }) {
  requireThat(project.layers.length < MAX_LAYERS, 'This project already has 100 layers.');
  const next = editableProject(project);
  const layer = baseLayer(String(content || 'Text').slice(0,80), 'text', x, y, width, height);
  layer.text = { content, fontSize, color, fontFamily, baseWidth: width, baseHeight: height };
  next.layers.push(layer);
  validateProject(next);
  return { project: next, layerId: layer.id };
}
export function updateText(project, layerId, patch) {
  const next = editableProject(project), layer = next.layers.find(item => item.id === layerId);
  requireThat(layer && layer.kind === 'text', 'Select a text layer first.');
  const allowed = ['content','fontSize','color','fontFamily','width','height'];
  const scaleX = layer.width / layer.text.baseWidth, scaleY = layer.height / layer.text.baseHeight;
  for (const [key,value] of Object.entries(patch)) {
    requireThat(allowed.includes(key), `Unsupported text property: ${key}`);
    if (key === 'width' || key === 'height') {
      layer.text[key === 'width' ? 'baseWidth' : 'baseHeight'] = value;
      layer[key] = value * (key === 'width' ? scaleX : scaleY);
    } else layer.text[key] = value;
  }
  // Masks remain in original coordinates when text is edited or resized.
  if (Object.hasOwn(patch,'content')) layer.name = String(patch.content || 'Text').slice(0,80);
  validateProject(next);
  return next;
}
export function attachObjectRegion(project,layerId,region) {
  const next=editableProject(project),layer=next.layers.find(item=>item.id===layerId);
  requireThat(layer?.kind==='text','Select a text label first.');
  if(region===null)delete layer.objectRegion;
  else { validateObjectRegion(region,next.assets,next.layers);layer.objectRegion=copy(region); }
  return validateProject(next);
}
export function labelComment(layer) {
  return typeof layer?.referenceComment==='string' ? layer.referenceComment : '';
}
export function updateLabelComment(project,layerId,comment) {
  requireThat(typeof comment==='string' && comment.length<=MAX_LABEL_COMMENT_LENGTH,`Label comments must be text up to ${MAX_LABEL_COMMENT_LENGTH} characters.`);
  const next=editableProject(project),layer=next.layers.find(item=>item.id===layerId);
  requireThat(layer?.kind==='text','Select a main scene text label first.');
  const trimmed=comment.trim();
  if(trimmed)layer.referenceComment=trimmed;
  else delete layer.referenceComment;
  return validateProject(next);
}
export function addDrawing(project, { mode = 'pencil', color = '#eba76f', size = 5, points }) {
  requireThat(project.layers.length < MAX_LAYERS, 'This project already has 100 layers.');
  requireThat(['pencil','highlight'].includes(mode) && isColor(color) && finite(size) && size > 0 && size <= 8192, 'Invalid drawing brush.');
  validatePoints(points, 'drawing');
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const [x,y] of points) { minX = Math.min(minX,x); minY = Math.min(minY,y); maxX = Math.max(maxX,x); maxY = Math.max(maxY,y); }
  const padding = size / 2 + 1, x = Math.floor(minX - padding), y = Math.floor(minY - padding);
  const width = Math.max(1,Math.ceil(maxX + padding) - x), height = Math.max(1,Math.ceil(maxY + padding) - y);
  validateSourceSize(width,height);
  const next = editableProject(project), layer = baseLayer(mode === 'highlight' ? 'Highlight' : 'Pencil stroke', 'drawing', x, y, width, height);
  layer.opacity = mode === 'highlight' ? 0.35 : 1;
  layer.drawing = { mode, color, size, points: points.map(([pointX,pointY]) => [pointX - x,pointY - y]), baseWidth: width, baseHeight: height };
  next.layers.push(layer);
  validateProject(next);
  return { project: next, layerId: layer.id };
}
export function layerSourceDimensions(project, layer) {
  requireThat(layer, 'Select a layer first.');
  const source = layer.kind === 'text' ? layer.text : layer.kind === 'drawing' ? layer.drawing : project.assets[layer.assetId];
  requireThat(source, 'The layer source is unavailable.');
  return { width: source.baseWidth ?? source.width, height: source.baseHeight ?? source.height };
}
export function updateLayer(project, layerId, patch) {
  const next = editableProject(project), layer = next.layers.find(item => item.id === layerId);
  requireThat(layer, 'Select a layer first.');
  const previous={...layer};
  const allowed = ['name','x','y','width','height','visible','opacity','mask','brightness','contrast','saturation','rotation'];
  for (const [key, value] of Object.entries(patch)) {
    requireThat(allowed.includes(key), `Unsupported layer property: ${key}`);
    if(key==='rotation')requireThat(layer.kind==='raster','Rotation is available for image layers.');
    if(key==='rotation'&&project.sketch?.surfaceLayerId===layer.id)requireThat(normalizeRotation(value)===0,'Keep the drawing page upright. Rotate the canvas view instead.');
    layer[key] = key==='rotation'?normalizeRotation(value):value;
  }
  // A detection number stays anchored when its photo moves, resizes or
  // rotates. Its text stays upright and the source selection mask stays
  // untouched. Explicitly moving a number still works independently.
  if(layer.kind==='raster'&&['x','y','width','height','rotation'].some(key=>Object.hasOwn(patch,key)&&layer[key]!==previous[key])) {
    for(const label of next.layers.filter(item=>item.objectRegion?.rasterLayerId===layer.id)) {
      const local=documentPointToLayer(previous,{x:label.x+label.width/2,y:label.y+label.height/2});
      const center=layerPointToDocument(layer,{x:local.x*layer.width/previous.width,y:local.y*layer.height/previous.height});
      label.x=center.x-label.width/2;label.y=center.y-label.height/2;
    }
  }
  validateProject(next);
  return next;
}
export function reorderLayer(project, layerId, targetIndex) {
  const next = editableProject(project), index = next.layers.findIndex(item => item.id === layerId);
  requireThat(index >= 0, 'Select a layer first.');
  requireThat(Number.isInteger(targetIndex), 'Invalid layer position.');
  const [layer] = next.layers.splice(index, 1);
  next.layers.splice(Math.max(0, Math.min(targetIndex, next.layers.length)), 0, layer);
  return next;
}
export function removeLayer(project, layerId) {
  const next = editableProject(project);
  next.layers = next.layers.filter(layer => layer.id !== layerId);
  for(const layer of next.layers)if(layer.objectRegion?.rasterLayerId===layerId)delete layer.objectRegion;
  return next; // Keep original source bytes for before/after and saved variants.
}
export function duplicateLayer(project, layerId) {
  requireThat(project.layers.length < MAX_LAYERS, 'This project already has 100 layers.');
  const next = editableProject(project), index = next.layers.findIndex(layer => layer.id === layerId);
  requireThat(index >= 0, 'Select a layer first.');
  const layer = { ...copy(next.layers[index]), id: id(), name: `${next.layers[index].name} copy` };
  next.layers.splice(index + 1, 0, layer);
  return { project: next, layerId: layer.id };
}
export function addMaskStroke(project, layerId, stroke) {
  const layer = project.layers.find(item => item.id === layerId);
  requireThat(layer, 'Select a layer first.');
  return updateLayer(project, layerId, { mask: [...layer.mask, copy(stroke)] });
}
export function saveVariant(project, name) {
  requireThat(project.variants.length < 20, 'Keep up to 20 saved variants per project.');
  const next = editableProject(project);
  next.variants.push({ id: id(), name: String(name || `Variant ${next.variants.length + 1}`).slice(0,200), width: next.width, height: next.height, layers: copy(next.layers), prompt: next.prompt, ...(next.sheetPreset?{sheetPreset:copy(next.sheetPreset)}:{}), ...(next.sketch?{sketch:copy(next.sketch)}:{}), ...(next.blockoutReview?{blockoutReview:copy(next.blockoutReview)}:{}), ...(next.sceneConsistency?{sceneConsistency:copy(next.sceneConsistency)}:{}), ...(next.imageOutput?{imageOutput:copy(next.imageOutput)}:{}) });
  return next;
}
export function restoreVariant(project, variantId) {
  const next = editableProject(project), variant = next.variants.find(item => item.id === variantId);
  requireThat(variant, 'The selected variant is unavailable.');
  const restored={ ...next, width: variant.width, height: variant.height, layers: copy(variant.layers), prompt: variant.prompt };
  if(variant.sheetPreset)restored.sheetPreset=copy(variant.sheetPreset);else delete restored.sheetPreset;
  if(variant.sketch)restored.sketch=copy(variant.sketch);else delete restored.sketch;
  if(variant.blockoutReview)restored.blockoutReview=copy(variant.blockoutReview);else delete restored.blockoutReview;
  if(variant.sceneConsistency)restored.sceneConsistency=copy(variant.sceneConsistency);else delete restored.sceneConsistency;
  if(variant.imageOutput)restored.imageOutput=copy(variant.imageOutput);else delete restored.imageOutput;
  return validateProject(restored);
}
export function addReference(project, image) {
  const { name, source, width, height }=image;
  requireThat(isRaster(source), 'Use a PNG, JPEG, or WebP reference image.');
  dimensions(width, height);
  const next = editableProject(project);
  const reference={ id: id(), name: String(name || 'Reference').slice(0,500), source, width, height, annotations: [], notes: '', ...sourceMetadata(image) };
  validateSourceMetadata(reference);next.references.push(reference);
  return next;
}
export function referenceLinks(layer) {
  if (Array.isArray(layer?.referenceIds)) return [...layer.referenceIds];
  return typeof layer?.referenceId === 'string' ? [layer.referenceId] : [];
}
export function linkReferences(project, layerId, referenceIds) {
  const next = editableProject(project), layer = next.layers.find(item => item.id === layerId);
  requireThat(layer?.kind === 'text', 'Select a text label first.');
  const available = new Set(next.references.map(reference => reference.id));
  requireThat(Array.isArray(referenceIds) && referenceIds.every(referenceId => typeof referenceId === 'string' && available.has(referenceId)), 'Choose available reference photos.');
  const unique = [...new Set(referenceIds)];
  if (unique.length) layer.referenceIds = unique;
  else delete layer.referenceIds;
  delete layer.referenceId;
  validateProject(next);
  return next;
}
export function linkReference(project, layerId, referenceId) { return linkReferences(project,layerId,referenceId === null ? [] : [referenceId]); }
export function removeReference(project, referenceId) {
  const next = editableProject(project);
  requireThat(next.references.some(reference => reference.id === referenceId), 'The reference photo is unavailable.');
  next.references = next.references.filter(reference => reference.id !== referenceId);
  for(const owner of [next,...next.variants])if(owner.sceneConsistency)owner.sceneConsistency.continuity.referenceIds=owner.sceneConsistency.continuity.referenceIds.filter(id=>id!==referenceId);
  for(const owner of [next,...next.variants])if(owner.sheetPreset){
    owner.sheetPreset.referenceIds=owner.sheetPreset.referenceIds.filter(id=>id!==referenceId);
    if(owner.sheetPreset.sourceId===referenceId)delete owner.sheetPreset.sourceId;
    if(owner.sheetPreset.subjectIds)owner.sheetPreset.subjectIds=owner.sheetPreset.subjectIds.filter(id=>id!==referenceId);
    if(owner.sheetPreset.photoEdits)owner.sheetPreset.photoEdits=owner.sheetPreset.photoEdits.filter(edit=>edit.id!==referenceId);
  }
  // Variants share the reference collection, so delete their links with the photo.
  for (const layers of [next.layers,...next.variants.map(variant => variant.layers)]) {
    for (const layer of layers) {
      const links = referenceLinks(layer).filter(item => item !== referenceId);
      if (links.length) layer.referenceIds = links;
      else delete layer.referenceIds;
      delete layer.referenceId;
    }
  }
  validateProject(next);
  return next;
}
export function updateReferenceAnnotations(project, referenceId, annotations) {
  const next = editableProject(project), reference = next.references.find(item => item.id === referenceId);
  requireThat(reference, 'The reference photo is unavailable.');
  reference.annotations = copy(annotations);
  validateProject(next);
  return next;
}
export function updateReferenceNotes(project, referenceId, notes) {
  requireThat(typeof notes === 'string' && notes.length <= MAX_REFERENCE_NOTE_LENGTH, `Reference notes must be text up to ${MAX_REFERENCE_NOTE_LENGTH} characters.`);
  const next = editableProject(project), reference = next.references.find(item => item.id === referenceId);
  requireThat(reference, 'The reference photo is unavailable.');
  if (notes === '' && !Object.hasOwn(reference, 'notes')) return validateProject(next);
  reference.notes = notes;
  validateProject(next);
  return next;
}
export function referenceProject(reference) {
  requireThat(reference && typeof reference.id === 'string' && isRaster(reference.source), 'Invalid reference image.');
  const project = newProject(reference.width,reference.height,reference.name || 'Reference photo');
  const assetId = `reference-asset-${reference.id}`, baseId = `reference-base-${reference.id}`;
  project.assets[assetId] = {id:assetId,name:reference.name || 'Reference photo',source:reference.source,width:reference.width,height:reference.height,...sourceMetadata(reference)};
  const base = {...baseLayer('Original reference photo','raster',0,0,reference.width,reference.height),id:baseId,assetId};
  project.layers = [base,...copy(reference.annotations || [])];
  project.original = {assetId,width:reference.width,height:reference.height};
  validateLayers(reference.annotations || [],{},new Set(),false,false,true);
  return validateProject(project);
}
// Sheet-specific photo edits use exactly the reference editor's safe editable
// annotation format, without modifying the shared reference or canvas layers.
export function validateReferenceAnnotations(annotations, referenceId) {
  validateLayers(annotations,{},new Set(),false,false,true);
  requireThat(annotations.every(layer=>layer.id!==`reference-base-${referenceId}`),'Invalid reference annotation identifier.');
  return annotations;
}
function validateLayers(layers, assets, references, legacy = false, legacyLinks = false, annotationOnly = false) {
  requireThat(Array.isArray(layers) && layers.length <= (annotationOnly ? MAX_LAYERS-1 : MAX_LAYERS), annotationOnly ? 'A reference photo supports up to 99 annotation layers.' : 'Invalid layer list.');
  const ids = new Set();
  for (const layer of layers) {
    requireThat(layer && typeof layer.id === 'string' && !ids.has(layer.id), 'Duplicate or invalid layer identifier.');
    ids.add(layer.id);
    const kind = legacy ? 'raster' : layer.kind;
    requireThat(['raster','text','drawing'].includes(kind), 'Invalid layer kind.');
    if (annotationOnly) {
      requireThat(kind !== 'raster', 'Reference annotations may only contain text or drawings.');
      const allowed = ['id','kind','name','x','y','width','height','visible','opacity','mask','brightness','contrast','saturation',kind === 'text' ? 'text' : 'drawing'];
      requireThat(Object.keys(layer).every(key => allowed.includes(key)), 'Reference annotations cannot contain images, reference links, or nested content.');
      const payload = layer[kind === 'text' ? 'text' : 'drawing'];
      const payloadKeys = kind === 'text' ? ['content','fontSize','color','fontFamily','baseWidth','baseHeight'] : ['mode','color','size','points','baseWidth','baseHeight'];
      requireThat(payload && Object.keys(payload).every(key => payloadKeys.includes(key)), 'Invalid reference annotation content.');
    }
    if (Object.hasOwn(layer,'referenceId')) requireThat(legacyLinks && kind === 'text' && typeof layer.referenceId === 'string' && references.has(layer.referenceId), 'A text label has an invalid reference photo link.');
    if (Object.hasOwn(layer,'referenceIds')) requireThat(!legacyLinks && kind === 'text' && Array.isArray(layer.referenceIds) && layer.referenceIds.length > 0 && new Set(layer.referenceIds).size === layer.referenceIds.length && layer.referenceIds.every(referenceId => typeof referenceId === 'string' && references.has(referenceId)), 'A text label has an invalid reference photo link.');
    if(Object.hasOwn(layer,'referenceComment')) {
      requireThat(!legacy && !annotationOnly && kind==='text','Label comments may only belong to main scene text labels.');
      requireThat(typeof layer.referenceComment==='string' && layer.referenceComment.length<=MAX_LABEL_COMMENT_LENGTH,`Label comments must be text up to ${MAX_LABEL_COMMENT_LENGTH} characters.`);
    }
    if (kind === 'raster') requireThat(Object.hasOwn(assets, layer.assetId), 'A layer is missing its original image.');
    if(Object.hasOwn(layer,'rotation'))requireThat(!legacy && !annotationOnly && kind==='raster' && finite(layer.rotation),'Invalid image layer rotation.');
    if (kind === 'text') {
      const text = layer.text;
      requireThat(text && typeof text.content === 'string' && text.content.trim().length > 0 && text.content.length <= MAX_TEXT_LENGTH && text.content.split('\n').length <= 200, 'Invalid annotation text.');
      requireThat(finite(text.fontSize) && text.fontSize >= 1 && text.fontSize <= 2048 && isColor(text.color) && TEXT_FONTS.includes(text.fontFamily), 'Invalid text style.');
      validateSourceSize(text.baseWidth,text.baseHeight);
    }
    if(Object.hasOwn(layer,'objectRegion')) {
      requireThat(!legacy && !annotationOnly && kind==='text','Detected objects may only belong to main scene text labels.');
      validateObjectRegion(layer.objectRegion,assets,layers);
    }
    if (kind === 'drawing') {
      const drawing = layer.drawing;
      requireThat(drawing && ['pencil','highlight'].includes(drawing.mode) && isColor(drawing.color) && finite(drawing.size) && drawing.size > 0 && drawing.size <= 8192, 'Invalid drawing brush.');
      validatePoints(drawing.points,'drawing');
      validateSourceSize(drawing.baseWidth,drawing.baseHeight);
      // Imported drawing coordinates must remain inside their declared source canvas.
      for (const [x,y] of drawing.points) requireThat(x >= 0 && y >= 0 && x <= drawing.baseWidth && y <= drawing.baseHeight, 'Drawing points fall outside their source.');
    }
    requireThat(typeof layer.name === 'string' && layer.name.length <= 500, 'Invalid layer name.');
    requireThat(finite(layer.x) && finite(layer.y) && Math.abs(layer.x) <= 1e6 && Math.abs(layer.y) <= 1e6, 'Invalid layer position.');
    requireThat(finite(layer.width) && finite(layer.height) && layer.width >= 1 && layer.height >= 1 && layer.width <= 32768 && layer.height <= 32768, 'Invalid layer size.');
    requireThat(typeof layer.visible === 'boolean' && finite(layer.opacity) && layer.opacity >= 0 && layer.opacity <= 1, 'Invalid layer appearance.');
    for (const key of ['brightness','contrast','saturation']) requireThat(finite(layer[key]) && layer[key] >= 0 && layer[key] <= 200, 'Invalid image adjustment.');
    requireThat(Array.isArray(layer.mask) && layer.mask.length <= 10000, 'Invalid mask.');
    for (const stroke of layer.mask) {
      if (annotationOnly) requireThat(stroke && Object.keys(stroke).every(key => ['mode','size','points'].includes(key)), 'Invalid reference annotation mask.');
      if(stroke && Object.hasOwn(stroke,'region')) {
        requireThat(!legacy && !annotationOnly && kind==='raster' && Object.keys(stroke).every(key=>['mode','region','sourceWidth','sourceHeight'].includes(key)) && ['hide','restore'].includes(stroke.mode),'Invalid object erasure mask.');
        const asset=assets[layer.assetId];
        requireThat(stroke.sourceWidth===asset.width && stroke.sourceHeight===asset.height,'The object erasure mask does not match its original image dimensions.');
        validateRegionMask(stroke.region);
        continue;
      }
      requireThat(stroke && ['hide','restore'].includes(stroke.mode) && finite(stroke.size) && stroke.size > 0 && stroke.size <= 8192, 'Invalid mask brush.');
      validatePoints(stroke.points,'mask');
    }
  }
}
export function validateProject(project) {
  requireThat(project && project.format === FORMAT && [1,2,VERSION].includes(project.version), 'This is not a supported Asun IMG project.');
  const legacy = project.version === 1;
  const legacyLinks = project.version < 3;
  dimensions(project.width, project.height);
  requireThat(typeof project.name === 'string' && project.name.length <= 500 && typeof project.prompt === 'string' && project.prompt.length <= 20000, 'Invalid project text.');
  requireThat(project.assets && typeof project.assets === 'object' && !Array.isArray(project.assets) && Object.keys(project.assets).length <= 500, 'Invalid source image collection.');
  for (const [key, asset] of Object.entries(project.assets)) {
    requireThat(asset && asset.id === key && isRaster(asset.source) && asset.source.length <= 140_000_000 && typeof asset.name === 'string', 'Invalid original image.');
    dimensions(asset.width, asset.height);
    validateSourceMetadata(asset);
  }
  requireThat(Array.isArray(project.references), 'Invalid reference list.');
  const referenceIds = new Set();
  for (const reference of project.references) {
    requireThat(reference && typeof reference.id === 'string' && reference.id.length > 0 && reference.id.length <= 200 && !referenceIds.has(reference.id) && typeof reference.name === 'string' && reference.name.length <= 500 && isRaster(reference.source) && reference.source.length <= 140_000_000, 'Duplicate or invalid reference image.');
    referenceIds.add(reference.id);
    dimensions(reference.width, reference.height);
    validateSourceMetadata(reference);
    if (Object.hasOwn(reference,'notes')) requireThat(typeof reference.notes === 'string' && reference.notes.length <= MAX_REFERENCE_NOTE_LENGTH, `Reference notes must be text up to ${MAX_REFERENCE_NOTE_LENGTH} characters.`);
    if (Object.hasOwn(reference,'annotations')) {
      validateLayers(reference.annotations,{},new Set(),false,false,true);
      requireThat(reference.annotations.every(layer => layer.id !== `reference-base-${reference.id}`), 'Invalid reference annotation identifier.');
    }
  }
  if (Object.hasOwn(project,'sheetPreset')) validateSheetPreset(project.sheetPreset,project);
  validateBlockoutReview(project);
  validateSceneConsistency(project);
  validateImageOutput(project);
  validateLayers(project.layers, project.assets, referenceIds, legacy, legacyLinks);
  validateSketchMetadata(project);
  requireThat(Array.isArray(project.variants) && project.variants.length <= 20, 'Invalid variant list.');
  for (const variant of project.variants) {
    requireThat(variant && typeof variant.id === 'string' && typeof variant.name === 'string' && typeof variant.prompt === 'string', 'Invalid variant.');
    if (Object.hasOwn(variant,'sheetPreset')) validateSheetPreset(variant.sheetPreset,project);
    validateBlockoutReview({...variant,assets:project.assets});
    validateSceneConsistency({...variant,assets:project.assets,references:project.references});
    validateImageOutput(variant);
    dimensions(variant.width, variant.height);
    validateLayers(variant.layers, project.assets, referenceIds, legacy, legacyLinks);
    validateSketchMetadata({...variant,assets:project.assets});
  }
  if (project.original !== null) {
    requireThat(project.original && Object.hasOwn(project.assets, project.original.assetId), 'The original image is missing.');
    dimensions(project.original.width, project.original.height);
  }
  return project;
}
function migrateProject(project) {
  validateProject(project);
  const next = copy(project);
  if (next.version === 1) {
    for (const layer of next.layers) layer.kind = 'raster';
    for (const variant of next.variants) for (const layer of variant.layers) layer.kind = 'raster';
  }
  if (next.version < 3) {
    for (const layers of [next.layers,...next.variants.map(variant => variant.layers)])for (const layer of layers) {
      if (typeof layer.referenceId === 'string') layer.referenceIds = [layer.referenceId];
      delete layer.referenceId;
    }
    for (const reference of next.references) if (!reference.annotations) reference.annotations = [];
    next.version = VERSION;
  }
  for(const layers of [next.layers,...next.variants.map(variant=>variant.layers)])for(const layer of layers)if(Object.hasOwn(layer,'rotation'))layer.rotation=normalizeRotation(layer.rotation);
  return validateProject(next);
}
export function serializeProject(project) { return JSON.stringify(migrateProject(project)); }
export function parseProject(text) {
  requireThat(typeof text === 'string', 'The project file could not be read. Choose a saved .asun file.');
  let value;
  try { value = JSON.parse(text); } catch { throw new Error('The project file could not be read. Choose a saved .asun file.'); }
  return migrateProject(value);
}
export class History {
  constructor(project, limit = 60) { this.limit = limit; this.reset(project); }
  reset(project) { this.entries = [{ label: 'Opened project', project: copy(validateProject(project)) }]; this.index = 0; }
  get project() { return copy(this.entries[this.index].project); }
  get canUndo() { return this.index > 0; }
  get canRedo() { return this.index < this.entries.length - 1; }
  commit(project, label) {
    validateProject(project);
    if (sameEditableData(project,this.entries[this.index].project)) return false;
    this.entries.splice(this.index + 1);
    this.entries.push({ label, project: copy(project) });
    if (this.entries.length > this.limit) this.entries.shift();
    this.index = this.entries.length - 1;
    return true;
  }
  undo() { if (this.canUndo) this.index--; return this.project; }
  redo() { if (this.canRedo) this.index++; return this.project; }
  go(index) { if (Number.isInteger(index) && index >= 0 && index < this.entries.length) this.index = index; return this.project; }
}
