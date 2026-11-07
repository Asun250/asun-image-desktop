// Originals stay byte-for-byte intact. Generated thumbnails are separate PNGs.
import {dimensions} from './core.mjs';
import {decodeImage} from './render.mjs';
import {validateImageFile} from './image-import-validation.mjs';
import {validatedOriginalPayload} from './image-source-validation.mjs';

export {MAX_ORIGINAL_FILE_BYTES} from './image-import-validation.mjs';
export const THUMBNAIL_MAX_SIDE = 512;
const thumbnails = new Map();
const MAX_THUMBNAIL_CACHE_BYTES=32*1024*1024,MAX_THUMBNAIL_CACHE_ENTRIES=64;
let thumbnailCacheBytes=0;
export function clearPreviewCache() { thumbnails.clear();thumbnailCacheBytes=0; }
function trimThumbnails(){
  while(thumbnails.size&&(thumbnails.size>MAX_THUMBNAIL_CACHE_ENTRIES||thumbnailCacheBytes>MAX_THUMBNAIL_CACHE_BYTES)){
    const source=thumbnails.keys().next().value,entry=thumbnails.get(source);thumbnails.delete(source);thumbnailCacheBytes-=entry.bytes;
  }
}

function signatureMime(bytes) {
  if(bytes.length>=8&&[137,80,78,71,13,10,26,10].every((value,index)=>bytes[index]===value))return 'image/png';
  if(bytes.length>=3&&bytes[0]===255&&bytes[1]===216&&bytes[2]===255)return 'image/jpeg';
  if(bytes.length>=12&&[82,73,70,70].every((value,index)=>bytes[index]===value)&&[87,69,66,80].every((value,index)=>bytes[index+8]===value))return 'image/webp';
  throw new Error('Choose an original PNG, JPEG or WebP image.');
}
function originalPayload(image) {
  return validatedOriginalPayload(image?.source);
}
function decodeBytes(payload) {
  let binary;
  try {binary=atob(payload);}catch {throw new Error('The original image bytes could not be read.');}
  return Uint8Array.from(binary,character=>character.charCodeAt(0));
}
export function sourceFileInfo(image) {
  const payload=originalPayload(image),mimeType=signatureMime(decodeBytes(payload.slice(0,16))),padding=payload.endsWith('==')?2:payload.endsWith('=')?1:0;
  return {name:image.originalFile?.name??image.name??'Original image',mimeType,byteLength:Math.floor(payload.length*3/4)-padding};
}
export function originalBlob(image) {
  const bytes=decodeBytes(originalPayload(image));
  return new Blob([bytes],{type:signatureMime(bytes)});
}
async function generateThumbnail(source) {
  const image=await decodeImage(source),scale=Math.min(1,THUMBNAIL_MAX_SIDE/Math.max(image.naturalWidth,image.naturalHeight));
  const width=Math.max(1,Math.round(image.naturalWidth*scale)),height=Math.max(1,Math.round(image.naturalHeight*scale));
  const target=document.createElement('canvas');target.width=width;target.height=height;
  target.getContext('2d').drawImage(image,0,0,width,height);
  return {source:target.toDataURL('image/png'),width,height,kind:'generated-thumbnail'};
}
export async function previewSource(image) {
  if(image.preview?.source)return image.preview.source;
  const source=image.source;let entry=thumbnails.get(source);
  if(entry){thumbnails.delete(source);thumbnails.set(source,entry);return (await entry.pending).source;}
  // Source strings are cache keys too; an entry-count limit alone can retain
  // gigabytes of removed full-resolution references in older project files.
  entry={bytes:source.length*2,pending:null};
  entry.pending=generateThumbnail(source).then(preview=>{
    if(thumbnails.get(source)===entry){const bytes=preview.source.length*2;entry.bytes+=bytes;thumbnailCacheBytes+=bytes;trimThumbnails();}
    return preview;
  }).catch(error=>{if(thumbnails.get(source)===entry){thumbnails.delete(source);thumbnailCacheBytes-=entry.bytes;}throw error;});
  thumbnails.set(source,entry);thumbnailCacheBytes+=entry.bytes;trimThumbnails();
  return (await entry.pending).source;
}
export async function readOriginalImage(file) {
  validateImageFile(file);
  const mimeType=signatureMime(new Uint8Array(await file.slice(0,12).arrayBuffer()));
  const raw=await new Promise((resolve,reject)=>{
    const reader=new FileReader();reader.onload=()=>resolve(reader.result);reader.onerror=()=>reject(new Error(`Could not read ${file.name}.`));reader.readAsDataURL(file);
  });
  // FileReader may use a supplied MIME type that disagrees with the bytes. Only
  // replace its data-URL media type; retain the original base64 payload exactly.
  const source=raw.replace(/^data:[^;]*;base64,/,`data:${mimeType};base64,`),image=await decodeImage(source);
  const {width,height}=dimensions(image.naturalWidth,image.naturalHeight),preview=await generateThumbnail(source);
  return {name:file.name,source,width,height,originalFile:{name:file.name,mimeType,byteLength:file.size},preview};
}
