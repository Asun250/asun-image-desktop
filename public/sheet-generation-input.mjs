// Clean subject/reference bytes and editable annotation guides remain separate.
import {validateProject, referenceProject} from './core.mjs';
import {renderProjectPreview} from './render.mjs';
import {getSheetPreset,getSheetSubjectSources,getSheetInputPhotos,sheetVisibleAnnotations} from './sheet-preset.mjs';
import {sheetGenerationInputOrder} from './sheet-generation-input-order.mjs';
import {planGenerationInputPacking,renderGenerationInputBoards} from './generation-input-packing.mjs';

export const SHEET_PREVIEW_SIDE=2600;
export const SHEET_MAX_INPUT_IMAGES=16;
export const SHEET_MAX_INPUT_BYTES=64*1024*1024;
const need=(condition,message)=>{if(!condition)throw new Error(message);};
export function sheetPreviewDimensions(width,height){
  const scale=Math.min(1,SHEET_PREVIEW_SIDE/Math.max(width,height));
  return {width:Math.max(1,Math.round(width*scale)),height:Math.max(1,Math.round(height*scale))};
}
export function sheetGenerationPlan(project){
  validateProject(project);
  need(getSheetPreset(project).active&&getSheetSubjectSources(project).length>0,'Choose a subject image for the character / item sheet first.');
  const photos=getSheetInputPhotos(project),annotated=photos.filter(({photo})=>sheetVisibleAnnotations(photo).length>0);
  const originalCount=new Set(photos.map(({photo})=>photo.source)).size;
  return {photos,annotated,imageCount:originalCount+annotated.length};
}
function imageBytes(image){
  const payload=image.source.split(',')[1]||'';
  return Math.floor(payload.length*3/4)-(payload.endsWith('==')?2:payload.endsWith('=')?1:0);
}
export async function buildSheetGenerationInput(input){
  const project=structuredClone(input),plan=sheetGenerationPlan(project),seen=new Set();let bytes=0;
  for(const {photo} of plan.photos)if(!seen.has(photo.source)){seen.add(photo.source);bytes+=imageBytes(photo);}
  need(bytes<=SHEET_MAX_INPUT_BYTES,'Choose subject and reference images totaling no more than 64 MB.');
  const annotationPreviews=[];
  for(const {photo} of plan.annotated){
    const editorProject=referenceProject({...photo,annotations:sheetVisibleAnnotations(photo)});
    const canvas=await renderProjectPreview(editorProject,document.createElement('canvas'),{maxSide:SHEET_PREVIEW_SIDE});
    const image={name:`${photo.name} - annotation guide.png`,width:canvas.width,height:canvas.height,source:canvas.toDataURL('image/png')};
    bytes+=imageBytes(image);
    need(bytes<=SHEET_MAX_INPUT_BYTES,'Choose photos and annotation guides totaling no more than 64 MB. Reduce the photo count or annotation guide sizes.');
    annotationPreviews.push({id:photo.id,image});
  }
  const logical=sheetGenerationInputOrder(plan,annotationPreviews),packing=planGenerationInputPacking(logical.images,logical.roles);
  if(!packing.packed)return {project,annotationPreviews};
  const inputBoards=await renderGenerationInputBoards(logical.images,packing);
  const total=inputBoards.reduce((sum,board)=>sum+imageBytes(board.image),0)+packing.slots.filter(slot=>slot.kind==='single').reduce((sum,slot)=>sum+imageBytes(logical.images[slot.sourceIndex-1]),0);
  need(total<=SHEET_MAX_INPUT_BYTES,'The packed images exceed 64 MB. Reduce image sizes; no references were dropped.');
  return {project,annotationPreviews,inputBoards,inputPacking:{version:1,logicalInputCount:packing.logicalInputCount,physicalInputCount:packing.physicalInputCount,boardCount:inputBoards.length}};
}
