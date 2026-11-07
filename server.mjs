import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import {createLocalDetection, readDetectionBody} from './local-sam.mjs';
import {createDesktopSheetService, readSheetBody} from './desktop-sheet-service.mjs';
import {prepareImageRequest} from './desktop-image-request.mjs';
import {importSheetWebPhoto} from './sheet-photo-import.mjs';
import {createDesktopImageSearch} from './desktop-image-search.mjs';
import {createGenerationQueue} from './desktop-generation-queue.mjs';
export const APP_ID = 'asun-image-local-v1';
export const BUILD = '1.6.7';
const publicRoot = fileURLToPath(new URL('./public/', import.meta.url));
const types = { '.html':'text/html; charset=utf-8', '.mjs':'text/javascript; charset=utf-8', '.js':'text/javascript; charset=utf-8', '.css':'text/css; charset=utf-8', '.svg':'image/svg+xml', '.ico':'image/x-icon', '.png':'image/png', '.gif':'image/gif' };
export function createServer({detection = createLocalDetection(), generationQueue=createGenerationQueue({directory:fileURLToPath(new URL('./data/generation-queue/',import.meta.url))}), sheets = createDesktopSheetService({queue:generationQueue}), images = createDesktopSheetService({directory:fileURLToPath(new URL('./data/image-jobs/',import.meta.url)),prepareRequest:prepareImageRequest,label:'image',queue:generationQueue}), photoImporter = importSheetWebPhoto, imageSearch = createDesktopImageSearch(), resumeQueue=false} = {}) {
  let generationUploads = 0, photoImports = 0;
  const server = http.createServer(async (request,response) => {
    response.setHeader('X-Content-Type-Options','nosniff');
    response.setHeader('Cache-Control','no-store');
    response.setHeader('Content-Security-Policy',"default-src 'self'; img-src 'self' data: blob:; style-src 'self' 'unsafe-inline'; script-src 'self'; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'");
    const host = request.headers.host || '';
    if (!/^(127\.0\.0\.1|localhost)(:\d+)?$/.test(host)) { response.writeHead(403); response.end('Local access only.'); return; }
    let requested;
    try { requested = decodeURIComponent(new URL(request.url, 'http://127.0.0.1').pathname); }
    catch { response.writeHead(400); response.end('Invalid address.'); return; }
    if (requested === '/api/image-search' || requested.startsWith('/api/image-search/')) {
      const send=(code,data)=>{response.writeHead(code,{'Content-Type':'application/json; charset=utf-8'});response.end(JSON.stringify(data));};
      const origin=request.headers.origin, site=request.headers['sec-fetch-site'];
      if((origin && origin!==`http://${host}`) || (site && !['same-origin','none'].includes(site))){send(403,{error:'Image search must start in the local Asun IMG editor.'});return;}
      if(request.method!=='GET'){response.setHeader('Allow','GET');send(405,{error:'Use Search images to find a photo.'});return;}
      try {
        const query=new URL(request.url,'http://127.0.0.1').searchParams;
        if(requested==='/api/image-search') {
          if([...query.keys()].some(key=>!['q','page'].includes(key)))throw new Error('Enter an image search and try again.');
          const page=query.get('page')??'0';if(!/^\d+$/.test(page))throw new Error('That search page is invalid. Search again.');
          send(200,await imageSearch.search(query.get('q'),{page:Number(page)}));return;
        }
        if(requested==='/api/image-search/thumbnail') {
          if([...query.keys()].some(key=>key!=='id'))throw new Error('Choose a preview from these image search results.');
          const result=await imageSearch.thumbnail(query.get('id'));
          response.writeHead(200,{'Content-Type':result.mimeType,'Content-Length':result.bytes.length,'Referrer-Policy':'no-referrer'});response.end(result.bytes);return;
        }
        send(404,{error:'That image search action is unavailable.'});
      }catch(error){if(!response.destroyed)send(error.statusCode||400,{error:error.message||'Image search could not finish. Try again.'});}
      return;
    }
    if (requested === '/api/sheet-photo-import') {
      const send=(code,data)=>{response.writeHead(code,{'Content-Type':'application/json; charset=utf-8'});response.end(JSON.stringify(data));};
      if(request.method!=='POST'){response.setHeader('Allow','POST');send(405,{error:'Drop or paste a web photo to import it.'});return;}
      if(request.headers.origin!==`http://${host}` || request.headers['sec-fetch-site']==='cross-site'){send(403,{error:'Web photos must be imported from the local Asun IMG editor.'});return;}
      if(photoImports>=2){send(429,{error:'Please wait for the current web photos to finish importing.'});return;}
      photoImports++;
      try{const input=await readSheetBody(request,10000,'photo');if(!input || Object.keys(input).some(key=>key!=='url'))throw new Error('Drop a direct image address.');send(200,await photoImporter(input.url));}
      catch(error){request.resume();if(!response.destroyed)send(error.statusCode||400,{error:error.message||'The photo could not be imported.'});}
      finally{photoImports--;}
      return;
    }
    if(requested==='/api/generation-queue/status') {
      const send=(code,data)=>{response.writeHead(code,{'Content-Type':'application/json; charset=utf-8'});response.end(JSON.stringify(data));};
      const origin=request.headers.origin;
      if((origin&&origin!==`http://${host}`)||request.headers['sec-fetch-site']==='cross-site'){send(403,{error:'Local same-origin access only.'});return;}
      if(request.method!=='GET'){response.setHeader('Allow','GET');send(405,{error:'Use GET to view the generation queue.'});return;}
      if(!(typeof images.token==='string'&&request.headers['x-asun-image-token']===images.token)&&!(typeof sheets.token==='string'&&request.headers['x-asun-sheet-token']===sheets.token)){send(403,{code:'ASUN_LOCAL_TOKEN_EXPIRED',error:'Refresh Asun IMG to authorize the generation queue.'});return;}
      try{send(200,await generationQueue.status());}catch(error){send(error.statusCode||500,{error:error.message||'The generation queue could not be read.'});}return;
    }
    if (requested.startsWith('/api/sheets/') || requested.startsWith('/api/images/')) {
      const isSheet = requested.startsWith('/api/sheets/'), prefix=isSheet?'/api/sheets':'/api/images', service=isSheet?sheets:images, label=isSheet?'sheet':'image';
      const send = (code,data) => {response.writeHead(code,{'Content-Type':'application/json; charset=utf-8'});response.end(JSON.stringify(data));};
      try {
        const origin = request.headers.origin;
        if ((origin && origin !== `http://${host}`) || request.headers['sec-fetch-site'] === 'cross-site') {send(403,{error:'Local same-origin access only.'});return;}
        if (requested === prefix+'/status') {
          if (request.method !== 'GET') {response.setHeader('Allow','GET');send(405,{error:`Use GET to check ${label} generation.`});return;}
          send(200,await service.status());return;
        }
        // This code identifies a local session rejection before any generation
        // is admitted. Clients may renew authorization and retry that same ID.
        // Provider or origin errors must never receive this retryable code.
        if (typeof service.token !== 'string' || request.headers[`x-asun-${label}-token`] !== service.token) {request.resume();send(403,{code:'ASUN_LOCAL_TOKEN_EXPIRED',error:`Refresh Asun IMG to authorize ${label} generation.`});return;}
        if(requested===prefix+'/history') {
          if(request.method!=='GET'){response.setHeader('Allow','GET');send(405,{error:'Use GET to view image history.'});return;}
          const query=new URL(request.url,'http://127.0.0.1').searchParams;
          send(200,await service.history({limit:query.get('limit')??20,cursor:query.get('cursor')}));return;
        }
        if (requested.startsWith(prefix+'/jobs/')) {
          const parts=requested.slice((prefix+'/jobs/').length).split('/');
          if(parts.length===2&&parts[1]==='cancel'){
            if(request.method!=='POST'){response.setHeader('Allow','POST');send(405,{error:'Use POST to cancel a queued generation.'});return;}
            if(origin!==`http://${host}`){send(403,{error:'Cancellation must start in the local Asun IMG app.'});return;}
            request.resume();send(200,await service.cancel(parts[0]));return;
          }
          if (request.method !== 'GET') {response.setHeader('Allow','GET');send(405,{error:`Use GET to check a generated ${label}.`});return;}
          if(parts.length===2&&parts[1]==='project'){send(200,await service.project(parts[0]));return;}
          if((parts.length===2&&parts[1]==='output')||(parts.length===3&&parts[1]==='input')) {
            const file=parts[1]==='output'?await service.output(parts[0]):await service.input(parts[0],parts[2]);
            response.writeHead(200,{'Content-Type':file.mimeType,'Content-Length':file.bytes.length,'Content-Disposition':`inline; filename="${parts[1]}-${parts[0]}.${file.extension}"`});response.end(file.bytes);return;
          }
          if(parts.length!==1){send(404,{error:'Unknown generated image file.'});return;}
          send(200,await service.job(parts[0]));return;
        }
        if (requested === prefix+'/generate') {
          if (request.method !== 'POST') {response.setHeader('Allow','POST');send(405,{error:`Use POST to generate a ${label}.`});return;}
          if (origin !== `http://${host}`) {send(403,{error:'Generation must start in the local Asun IMG app.'});return;}
          if (generationUploads >= 2) {send(429,{error:'A reference transfer is already in progress. Please wait.'});return;}
          generationUploads++;
          try {const input=await readSheetBody(request,undefined,label);send(202,await service.start(input));} finally {generationUploads--;}
          return;
        }
        send(404,{error:'Unknown generation action.'});
      } catch(error) {request.resume();if(!response.destroyed)send(error.statusCode||400,{error:error.message||'The image request could not be completed.'});}
      return;
    }
    if (requested === '/api/local-detection/status' || requested === '/api/local-detection') {
      const send = (code,data) => { response.writeHead(code,{'Content-Type':'application/json; charset=utf-8'}); response.end(JSON.stringify(data)); };
      const origin = request.headers.origin;
      if ((origin && origin !== `http://${host}`) || request.headers['sec-fetch-site'] === 'cross-site') { send(403,{error:'Local same-origin access only.'}); return; }
      if (requested === '/api/local-detection/status') {
        if (request.method !== 'GET') { response.setHeader('Allow','GET'); send(405,{error:'Use GET to check local detection.'}); return; }
        send(200,await detection.status()); return;
      }
      if (request.method !== 'POST') { response.setHeader('Allow','POST'); send(405,{error:'Use POST for local detection.'}); return; }
      if (origin !== `http://${host}` || request.headers['x-asun-detection-token'] !== detection.token) { send(403,{error:'Local detection authorization is missing. Refresh the editor and try again.'}); return; }
      if (!/^application\/json(?:\s*;|$)/i.test(request.headers['content-type'] || '')) { send(415,{error:'Detection accepts JSON image data only.'}); return; }
      try { const input = await readDetectionBody(request); send(200,await detection.detect(input)); }
      catch (error) { if (!response.destroyed) send(error.statusCode || 500,{error:error.message || 'Local detection failed.'}); }
      return;
    }
    if (!['GET','HEAD'].includes(request.method)) { response.writeHead(405, {Allow:'GET, HEAD'}); response.end('Use a supported local app endpoint.'); return; }
    if (requested === '/health') { response.writeHead(200,{'Content-Type':'application/json'}); response.end(JSON.stringify({app:APP_ID,build:BUILD,generation:'image-api'})); return; }
    if (requested === '/') requested = '/index.html';
    const target = path.resolve(publicRoot, '.' + requested);
    if (!target.startsWith(publicRoot) || !types[path.extname(target)]) { response.writeHead(404); response.end('Not found.'); return; }
    try {
      const data = await readFile(target);
      response.writeHead(200, {'Content-Type':types[path.extname(target)]});
      response.end(request.method === 'HEAD' ? undefined : data);
    } catch { response.writeHead(404); response.end('Not found.'); }
  });
  if(resumeQueue)server.once('listening',()=>generationQueue.resume());
  server.on('close', () => {generationQueue.dispose();detection.dispose();sheets.dispose();images.dispose();imageSearch.dispose();});
  return server;
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const port = Number(process.env.ASUN_PORT || 48010);
  if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error('Invalid ASUN_PORT.');
  const server = createServer({resumeQueue:true});
  server.on('error', error => { console.error(error.code === 'EADDRINUSE' ? `Port ${port} is already in use. Run Launch Asun IMG.ps1 to reuse an existing app or choose a free local port.` : error.message); process.exitCode = 1; });
  server.listen(port,'127.0.0.1',() => console.log(`Asun IMG: http://127.0.0.1:${port}`));
}
