// Data URLs are immutable strings. Rechecking their complete base64 on every
// pointer move/Undo used to scan every original and reference repeatedly.
// Cache only string validation; dimensions, names and editable metadata are
// still validated on every call. Reset with the editor's other image caches.
const entries=new Map(),MAX_BYTES=192*1024*1024,MAX_ENTRIES=128;
let bytes=0;
function entryFor(source){
  if(typeof source!=='string')return {};
  let entry=entries.get(source);
  if(entry){entries.delete(source);entries.set(source,entry);return entry;}
  entry={};const weight=source.length*2;
  if(weight>MAX_BYTES)return entry;
  while(entries.size&&(entries.size>=MAX_ENTRIES||bytes+weight>MAX_BYTES)){
    const oldest=entries.keys().next().value;entries.delete(oldest);bytes-=oldest.length*2;
  }
  entries.set(source,entry);bytes+=weight;return entry;
}
export function clearImageSourceValidationCache(){entries.clear();bytes=0;}
export function isRasterDataURL(source){
  if(typeof source!=='string')return false;
  const entry=entryFor(source);
  if(entry.raster===undefined)entry.raster=/^data:image\/(png|jpeg|webp);base64,[A-Za-z0-9+/=]+$/.test(source);
  return entry.raster;
}
export function validatedOriginalPayload(source){
  if(typeof source!=='string')throw new Error('The original image bytes are unavailable.');
  const entry=entryFor(source);
  if(entry.payload===undefined){
    const match=/^data:[^;,]+;base64,([A-Za-z0-9+/]*={0,2})$/.exec(source);
    entry.payload=Boolean(match&&match[1].length%4!==1&&(!match[1].includes('=')||match[1].length%4===0));
  }
  if(!entry.payload)throw new Error('The original image bytes are unavailable.');
  return source.slice(source.indexOf(',')+1);
}
