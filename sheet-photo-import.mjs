// Fetch only an image explicitly dropped by the user. Never forward local
// credentials; resolve and pin every redirect to public addresses.
import http from 'node:http';
import https from 'node:https';
import {lookup} from 'node:dns/promises';
import {isIP} from 'node:net';
import {inspectSheetImage} from './desktop-sheet-service.mjs';

const limit = 50 * 1024 * 1024;
const fail = message => Object.assign(new Error(message), {statusCode:400});
export function publicImageAddress(address) {
  const family = isIP(address);
  if (family === 4) {
    const [a,b,c] = address.split('.').map(Number);
    return !(a === 0 || a === 10 || a === 127 || a >= 224 ||
      (a === 100 && b >= 64 && b <= 127) || (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) || (a === 192 && (b === 168 || b === 0 || (b === 88 && c === 99))) ||
      (a === 198 && (b === 18 || b === 19 || (b === 51 && c === 100))) || (a === 203 && b === 0 && c === 113));
  }
  // Global IPv6 unicast only, excluding documentation, protocol assignments and
  // embedded IPv4 tunnels. IPv4-mapped and local IPv6 addresses are not allowed.
  if(family!==6 || !/^[23][0-9a-f]{3}:/i.test(address))return false;
  const [first,second]=address.split(':').map(part=>parseInt(part||'0',16));
  return first!==0x2002 && first!==0x3fff && !(first===0x2001 && (second<0x200 || second===0xdb8));
}
export async function resolveImageURL(value, dnsLookup = lookup) {
  let url;try {url = new URL(value);} catch {throw fail('Drop an image or a direct public image URL.');}
  if (!['http:','https:'].includes(url.protocol) || url.username || url.password || (url.port && !['80','443'].includes(url.port)) || value.length > 8192) throw fail('Use a public HTTP or HTTPS image address.');
  const host = url.hostname.replace(/^\[|\]$/g,'');
  if (host === 'localhost' || /\.(localhost|local|internal|test|invalid)$/i.test(host)) throw fail('Local and private addresses cannot be imported from the web.');
  let addresses;
  try {addresses = isIP(host) ? [{address:host,family:isIP(host)}] : await dnsLookup(host,{all:true,verbatim:true});}
  catch {throw fail('That image website could not be reached. Copy the image and paste it here instead.');}
  if (!addresses.length || addresses.some(item => !publicImageAddress(item.address))) throw fail('Local and private addresses cannot be imported from the web.');
  return {url,addresses};
}
function requestImage({url,addresses}, signal) {
  return new Promise((resolve,reject) => {
    const transport = url.protocol === 'https:' ? https : http;
    const request = transport.get(url, {agent:false,signal,headers:{Accept:'image/png,image/jpeg,image/webp', 'User-Agent':'Asun-IMG/1.6.7'},
      lookup(_host,options,callback) {callback(null,options.all ? addresses : addresses[0].address,options.all ? undefined : addresses[0].family);}}, response => {
      const code = response.statusCode || 0;
      if ([301,302,303,307,308].includes(code)) {const location=response.headers.location;response.destroy();resolve({redirect:location});return;}
      if (code !== 200) {response.destroy();reject(fail('This website does not allow importing that image. Use Copy image, then Paste photos.'));return;}
      const declared = Number(response.headers['content-length']);
      if (declared > limit) {response.destroy();reject(fail('Choose an image smaller than 50 MB.'));return;}
      const mime = String(response.headers['content-type'] || '').split(';')[0].toLowerCase();
      if (mime && !['image/png','image/jpeg','image/webp','application/octet-stream'].includes(mime)) {response.destroy();reject(fail('That link is a web page, not a supported photo. Drag the image itself, or use Copy image and Paste photos.'));return;}
      const chunks=[];let bytes=0;
      response.on('data', chunk => {bytes+=chunk.length;if(bytes>limit){response.destroy();reject(fail('Choose an image smaller than 50 MB.'));}else chunks.push(chunk);});
      response.on('error',reject);response.on('end',()=>resolve({bytes:Buffer.concat(chunks)}));
    });
    request.on('error',reject);
  });
}
function beforeDeadline(promise,signal) {
  return new Promise((resolve,reject)=>{
    const aborted=()=>reject(new Error('Photo import timed out.'));
    if(signal.aborted){aborted();return;}
    signal.addEventListener('abort',aborted,{once:true});
    Promise.resolve(promise).then(resolve,reject).finally(()=>signal.removeEventListener('abort',aborted));
  });
}
export async function importSheetWebPhoto(value, {resolve=resolveImageURL,request=requestImage,timeoutMs=20000}={}) {
  if (typeof value !== 'string') throw fail('Drop a direct image address.');
  const controller=new AbortController(), timer=setTimeout(()=>controller.abort(),timeoutMs);
  try {
    let next=value;
    for(let hop=0;hop<4;hop++) {
      if(controller.signal.aborted)throw new Error('Photo import timed out.');
      const target=await beforeDeadline(resolve(next),controller.signal);
      if(controller.signal.aborted)throw new Error('Photo import timed out.');
      const result=await beforeDeadline(request(target,controller.signal),controller.signal);
      if(result.redirect) {next=new URL(result.redirect,target.url).href;continue;}
      if(!result.bytes)throw fail('The image website returned an empty file.');
      const info=inspectSheetImage(result.bytes);
      let name;try{name=decodeURIComponent(target.url.pathname.split('/').at(-1));}catch{name='Web image';}
      name=String(name || 'Web image').replace(/[<>:"/\\|?*\x00-\x1f]/g,'_').replace(/\.[^.]*$/,'').slice(0,140) || 'Web image';
      return {name:name+'.'+info.extension,mimeType:info.mimeType,width:info.width,height:info.height,source:'data:'+info.mimeType+';base64,'+result.bytes.toString('base64')};
    }
    throw fail('That image redirects too many times. Copy the image and paste it here instead.');
  } catch(error) {if(error.statusCode)throw error;throw fail('The web image could not be imported. Use Copy image, then Paste photos, or choose a saved image.');}
  finally {clearTimeout(timer);}
}
