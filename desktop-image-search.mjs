// Desktop adaptation of the existing phone app's Wikimedia Commons search.
// Only a typed query goes to the provider. Thumbnails use same-origin URLs;
// original images are imported separately, after the user chooses one.
import {randomBytes} from 'node:crypto';
import {inspectSheetImage} from './desktop-sheet-service.mjs';

const API = 'https://commons.wikimedia.org/w/api.php';
const PROVIDER = 'Wikimedia Commons';
const TTL = 15 * 60 * 1000;
const MIME = new Set(['image/png','image/jpeg','image/webp']);
const fail = (message,statusCode=400) => Object.assign(new Error(message),{statusCode});
const plain = value => String(value || '').replace(/<[^>]*>/g,' ').replace(/&(?:amp|lt|gt|quot|#39);/g,part=>({'&amp;':'&','&lt;':'<','&gt;':'>','&quot;':'"','&#39;':"'"}[part])).replace(/\s+/g,' ').trim().slice(0,500);

export function commonsImageUrl(value,{page=false,original=false}={}) {
  if(typeof value!=='string' || value.length>8192)throw fail('The image search returned an invalid address.',502);
  let url;try{url=new URL(value);}catch{throw fail('The image search returned an invalid address.',502);}
  if(url.protocol!=='https:' || url.username || url.password || url.port)throw fail('The image search returned an unsupported address.',502);
  if(page) {
    if(url.hostname!=='commons.wikimedia.org' || !url.pathname.startsWith('/wiki/File:'))throw fail('The image search returned an invalid source page.',502);
  } else {
    if(!['upload.wikimedia.org','thumb.wikimedia.org'].includes(url.hostname) || !url.pathname.startsWith('/wikipedia/commons/'))throw fail('The image search returned an unsupported image host.',502);
    if(original && (url.hostname!=='upload.wikimedia.org' || url.pathname.includes('/thumb/')))throw fail('The search did not return an original image.',502);
  }
  url.hash='';return url.href;
}

async function boundedBytes(response,maximum) {
  const declared=Number(response.headers.get('content-length'));
  if(Number.isFinite(declared) && declared>maximum){await response.body?.cancel();throw fail('The image search response was too large. Please try another search.',502);}
  const reader=response.body?.getReader();if(!reader)throw fail('The image search response could not be read.',502);
  const chunks=[];let length=0;
  try{for(;;){const {done,value}=await reader.read();if(done)break;length+=value.byteLength;if(length>maximum){await reader.cancel();throw fail('The image search response was too large. Please try another search.',502);}chunks.push(Buffer.from(value));}}
  finally{reader.releaseLock();}
  return Buffer.concat(chunks,length);
}

export function createDesktopImageSearch({fetchImpl=globalThis.fetch,now=Date.now,timeoutMs=25000}={}) {
  const records=new Map();let searches=0,thumbnails=0,disposed=false;
  function prune(){for(const [id,result] of records)if(result.expiresAt<=now())records.delete(id);}
  async function request(url,maximum) {
    let response;
    try{response=await fetchImpl(url,{headers:{accept:'application/json,image/png,image/jpeg,image/webp','User-Agent':'AsunIMG/1.6.7 (private local image editor)'},credentials:'omit',redirect:'error',signal:AbortSignal.timeout(timeoutMs)});}
    catch{throw fail('Wikimedia Commons could not be reached. Try again, or use Search the web and paste an image.',502);}
    if(!response.ok){await response.body?.cancel();throw fail(`Wikimedia Commons is unavailable (${response.status}). Try again, or use Search the web.`,502);}
    return {response,bytes:await boundedBytes(response,maximum)};
  }
  return {
    async search(query,{page=0}={}) {
      if(disposed)throw fail('Reopen image search to continue.',503);
      const text=typeof query==='string'?query.trim():'';
      if(!text || text.length>250)throw fail('Enter a search from 1 to 250 characters.');
      if(!Number.isSafeInteger(page) || page<0)throw fail('That search page is invalid. Search again.');
      if(searches>=2)throw fail('Please wait for the current image search to finish.',429);
      searches++;
      try {
        prune();
        const url=new URL(API);url.search=new URLSearchParams({action:'query',format:'json',formatversion:'2',generator:'search',gsrsearch:`${text} filetype:bitmap`,gsrnamespace:'6',gsrlimit:'18',gsroffset:String(page),prop:'imageinfo',iiprop:'url|size|mime|extmetadata',iiurlwidth:'320',iiurlheight:'320',iiextmetadatafilter:'LicenseShortName|Artist'});
        const {bytes}=await request(url.href,2*1024*1024);
        let reply;try{reply=JSON.parse(bytes.toString('utf8'));}catch{throw fail('Wikimedia Commons returned an unreadable response. Please try again.',502);}
        if(reply?.error)throw fail('Wikimedia Commons could not run that search. Try a simpler search.',502);
        if(reply?.query?.pages!==undefined && !Array.isArray(reply.query.pages))throw fail('Wikimedia Commons returned an unreadable result list. Please try again.',502);
        const images=[];
        for(const item of [...(reply.query?.pages || [])].sort((a,b)=>(a?.index||0)-(b?.index||0))) {
          const source=item?.imageinfo?.[0];
          if(!source || !MIME.has(source.mime) || !Number.isInteger(source.width) || !Number.isInteger(source.height) || source.width<1 || source.height<1 || source.width>8192 || source.height>8192 || source.width*source.height>32_000_000 || !Number.isInteger(source.size) || source.size<1 || source.size>50*1024*1024)continue;
          try {
            if(!source.thumburl && Math.max(source.width,source.height)>320)continue;
            const imageUrl=commonsImageUrl(source.url,{original:true}),remoteThumbnail=commonsImageUrl(source.thumburl||source.url),sourceUrl=commonsImageUrl(source.descriptionurl,{page:true});
            const id=randomBytes(16).toString('hex');
            const result={id,title:plain(item.title?.replace(/^File:/,''))||'Web image',thumbnailUrl:`/api/image-search/thumbnail?id=${id}`,imageUrl,sourceUrl,sourceName:PROVIDER,width:source.width,height:source.height,license:plain(source.extmetadata?.LicenseShortName?.value),artist:plain(source.extmetadata?.Artist?.value)};
            records.set(id,{url:remoteThumbnail,expiresAt:now()+TTL});images.push(result);
          }catch{/* Unsupported provider records do not become fetch targets. */}
        }
        // Bound temporary thumbnail handles without imposing a result-page cap.
        while(records.size>2000)records.delete(records.keys().next().value);
        const next=reply.continue?.gsroffset;
        return {provider:PROVIDER,images,nextPage:Number.isSafeInteger(next)&&next>page?next:null};
      } finally {searches--;}
    },
    async thumbnail(id) {
      prune();const record=typeof id==='string' && /^[a-f0-9]{32}$/.test(id) && records.get(id);
      if(disposed || !record)throw fail('This thumbnail expired. Search again to reload it.',404);
      if(thumbnails>=8)throw fail('Please wait for the current image previews to load.',429);
      thumbnails++;
      try {
        const {bytes,response}=await request(commonsImageUrl(record.url),3*1024*1024);
        const info=inspectSheetImage(bytes),header=(response.headers.get('content-type')||'').split(';')[0].trim();
        if(!MIME.has(info.mimeType) || (header && header!==info.mimeType) || info.width*info.height>1_000_000)throw fail('This preview is not a supported image.',502);
        return {bytes,mimeType:info.mimeType};
      } finally {thumbnails--;}
    },
    dispose(){disposed=true;records.clear();}
  };
}
