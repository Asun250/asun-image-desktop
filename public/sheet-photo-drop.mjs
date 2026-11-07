import {clipboardImageFiles} from './clipboard.mjs';
import {captureDroppedImageFiles} from './image-import-validation.mjs';

const noImage = 'Drop a PNG, JPEG or WebP photo here. For a web image, drag the image itself or use Copy image, then Paste photos.';
export function sheetDropInput(transfer) {
  const pending=captureDroppedImageFiles(transfer);
  const strings=Object.fromEntries(['text/html','text/uri-list','text/plain'].map(type=>[type,transfer?.getData?.(type)||'']));
  const result=pending.then(files=>{
  if(files.some(file=>file.size>0))return {files,urls:[]};
  // Read embedded image bytes first; inert HTML parsing never executes markup.
  // Empty browser drag placeholders must not hide the actual image payload.
  try {return {files:clipboardImageFiles({files:[],items:[],getData:type=>strings[type]||''}),urls:[]};} catch { /* External web-image drag may contain only an image URL. */ }
  const html=strings['text/html'];
  if(html.length>1_000_000)throw new Error('The dropped page is too large. Copy the photo itself instead.');
  const template=document.createElement('template');template.innerHTML=html;
  const urls=[...template.content.querySelectorAll('img[src]')].map(image=>image.getAttribute('src'));
  if(!urls.length)urls.push(...(strings['text/uri-list'] || strings['text/plain'] || '').split(/\r?\n/).filter(line=>line&&!line.startsWith('#')));
  const publicURLs=[...new Set(urls.filter(value=>typeof value==='string' && /^https?:\/\//i.test(value.trim())).map(value=>value.trim()))];
  if(!publicURLs.length){if(files.length)return {files,urls:[]};throw new Error(noImage);}
  if(publicURLs.length>16)throw new Error('Drop up to 16 web photos at a time.');
  return {files:[],urls:publicURLs};
  });
  // The sheet waits for a paint before consuming this captured drop. Keep a
  // rejection handled in that interval; awaiting result still reports it.
  result.catch(()=>{});
  return result;
}
export async function sheetWebPhotoFile(url, fetchImpl=globalThis.fetch) {
  const response=await fetchImpl('/api/sheet-photo-import',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({url})});
  let image;try{image=await response.json();}catch{throw new Error('Restart the desktop app to load web-image import. You can also use Copy image, then Paste photos.');}
  if(!response.ok)throw new Error(image.error || noImage);
  const match=/^data:(image\/(?:png|jpeg|webp));base64,([A-Za-z0-9+/]+={0,2})$/.exec(image.source || '');
  if(!match || match[2].length>70_000_000)throw new Error('The website did not return a supported photo.');
  const decoded=atob(match[2]),bytes=Uint8Array.from(decoded,char=>char.charCodeAt(0));
  return new File([bytes],image.name || 'Web image.png',{type:match[1]});
}
