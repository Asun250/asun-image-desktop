import {execFileSync} from 'node:child_process';
import {randomBytes, createHash} from 'node:crypto';
import {mkdir, readFile, writeFile, rename, unlink, readdir, stat} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import path from 'node:path';
import {validateProject} from './public/core.mjs';
import {getSheetPreset, buildSheetPrompt} from './public/sheet-preset.mjs';
import {sheetGenerationInputOrder} from './public/sheet-generation-input-order.mjs';
import {applyGenerationInputPacking,packingPromptRoles,PACKED_INPUT_INSTRUCTIONS} from './desktop-input-packing.mjs';
import {sheetGenerationPlan,sheetPreviewDimensions} from './public/sheet-generation-input.mjs';
import {DEFAULT_GENERATION_QUALITY,generationQualityOptions,validateGenerationQuality,DEFAULT_GENERATION_COMPLEXITY,generationComplexityOptions,validateGenerationComplexity} from './public/generation-settings.mjs';
import {createGenerationQueue} from './desktop-generation-queue.mjs';
import {checkImageOutputSize} from './public/image-output-settings.mjs';
import {MODEL as BLOCKOUT_MODEL,EFFORT as BLOCKOUT_EFFORT,reviewBlockout,buildBlockoutCorrectionPrompt} from './desktop-blockout-review.mjs';

const API = 'https://api.openai.com/v1';
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const fail = (statusCode, message) => Object.assign(new Error(message), {statusCode});
const need = (condition, message, code = 400) => {if (!condition) throw fail(code, message);};
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
export const SHEET_REQUEST_BYTES = 128 * 1024 * 1024;
const IMAGE_BYTES = 50 * 1024 * 1024, REFERENCE_BYTES = 64 * 1024 * 1024;
export const SHEET_MODELS = Object.freeze([
  ['gpt-image-2.5-sunburst', 'GPT Image 2.5 · Sunburst'],
  ['gpt-image-2.5-flare', 'GPT Image 2.5 · Flare'],
  ['gpt-image-2.6-sunburst', 'GPT Image 2.6 · Sunburst — detailed work'],
  ['gpt-image-2.6-flare', 'GPT Image 2.6 · Flare — faster iteration'],
  ['gpt-image-2', 'GPT Image 2'], ['gpt-image-1.5', 'GPT Image 1.5'],
  ['gpt-image-1', 'GPT Image 1'], ['gpt-image-1-mini', 'GPT Image 1 Mini'],
].map(([id, label]) => Object.freeze({id, label,...(id==='gpt-image-1'?{retired:true}:{})})));

export function readSheetAPIKey() {
  if (process.env.OPENAI_API_KEY?.trim()) return process.env.OPENAI_API_KEY.trim();
  if (process.platform === 'win32') {
    try {
      // Read only this app's documented credential, and never expose it to the UI.
      return execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', "[Environment]::GetEnvironmentVariable('OPENAI_API_KEY','User')"], {encoding:'utf8', windowsHide:true, timeout:5000, stdio:['ignore','pipe','ignore']}).trim();
    } catch { /* The status response explains that no API connection is set up. */ }
  }
  return '';
}

function safeMessage(error, key = '') {
  let value = String(error?.message || 'The image provider could not complete the image.');
  if (key) value = value.split(key).join('[redacted]');
  return value.replace(/sk-[A-Za-z0-9_-]+/g, '[redacted]').slice(0, 700);
}
function outputName(prepared) {
  let base = String(prepared.sourceName || 'Subject').toWellFormed().replace(/\.[^.]*$/,'').replace(/[<>:"/\\|?*\x00-\x1f\x7f]/g,'_').trim().replace(/[. ]+$/,'').slice(0,100).replace(/[\uD800-\uDBFF]$/,'');
  if(!base || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(base))base='Subject';
  return prepared.mode==='image' ? `${base} - generated image.png` : `${base} - ${prepared.views}-view sheet.png`;
}

/** Check real encoded images before upload or displaying a returned result. */
export function inspectSheetImage(bytes) {
  need(Buffer.isBuffer(bytes) && bytes.length > 20 && bytes.length <= IMAGE_BYTES, 'Choose a PNG, JPEG or WebP image under 50 MB.');
  let width, height, mimeType, extension;
  if (bytes.subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10]))) {
    need(bytes.length >= 45 && bytes.readUInt32BE(8) === 13 && bytes.toString('ascii',12,16) === 'IHDR', 'Invalid PNG header.');
    width = bytes.readUInt32BE(16);height = bytes.readUInt32BE(20);mimeType = 'image/png';extension = 'png';
    let offset = 8, image = false, ended = false;
    while (offset + 12 <= bytes.length) {
      const length = bytes.readUInt32BE(offset), kind = bytes.toString('ascii', offset + 4, offset + 8);
      need(length <= bytes.length - offset - 12, 'Truncated PNG image.');
      need(!['acTL','fcTL','fdAT'].includes(kind), 'Use one still reference image, not an animation.');
      if (kind === 'IDAT') image = true;offset += length + 12;
      if (kind === 'IEND') {need(length === 0 && offset === bytes.length, 'Invalid PNG end marker.');ended = true;break;}
    }
    need(image && ended, 'Incomplete PNG image.');
  } else if (bytes[0] === 255 && bytes[1] === 216) {
    need(bytes[bytes.length-2] === 255 && bytes[bytes.length-1] === 217, 'Incomplete JPEG image.');
    let offset = 2;
    while (offset + 4 <= bytes.length) {
      need(bytes[offset] === 255, 'Invalid JPEG marker.');while (bytes[offset] === 255) offset++;
      const marker = bytes[offset++];if (marker === 218 || marker === 217) break;
      if (marker === 1 || (marker >= 208 && marker <= 215)) continue;
      const length = bytes.readUInt16BE(offset);need(length >= 2 && offset + length <= bytes.length, 'Truncated JPEG image.');
      if ([192,193,194,195,197,198,199,201,202,203,205,206,207].includes(marker)) {need(length >= 8, 'Invalid JPEG dimensions.');height = bytes.readUInt16BE(offset + 3);width = bytes.readUInt16BE(offset + 5);}
      offset += length;
    }
    mimeType = 'image/jpeg';extension = 'jpg';
  } else if (bytes.toString('ascii',0,4) === 'RIFF' && bytes.toString('ascii',8,12) === 'WEBP') {
    need(bytes.readUInt32LE(4) + 8 === bytes.length, 'Incomplete WebP image.');
    let offset = 12, image = false;
    while (offset + 8 <= bytes.length) {
      const kind = bytes.toString('ascii',offset,offset+4), length = bytes.readUInt32LE(offset+4), start = offset+8;
      need(start + length <= bytes.length, 'Truncated WebP image.');
      if (kind === 'VP8X') {need(length >= 10, 'Invalid WebP dimensions.');width = 1+bytes.readUIntLE(start+4,3);height = 1+bytes.readUIntLE(start+7,3);}
      if (kind === 'VP8 ') {need(length >= 10 && bytes[start+3] === 157 && bytes[start+4] === 1 && bytes[start+5] === 42, 'Invalid WebP frame.');width ||= bytes.readUInt16LE(start+6)&16383;height ||= bytes.readUInt16LE(start+8)&16383;image = true;}
      if (kind === 'VP8L') {need(length >= 5 && bytes[start] === 47, 'Invalid lossless WebP frame.');const d = bytes.readUInt32LE(start+1);width ||= 1+(d&16383);height ||= 1+((d>>>14)&16383);image = true;}
      need(!['ANIM','ANMF'].includes(kind), 'Use one still reference image, not an animation.');offset = start+length+(length%2);
    }
    need(image && offset === bytes.length, 'Incomplete WebP image.');mimeType = 'image/webp';extension = 'webp';
  } else throw fail(400, 'The file is not an actual PNG, JPEG or WebP image.');
  need(Number.isInteger(width) && Number.isInteger(height) && width > 0 && height > 0 && width <= 8192 && height <= 8192 && width * height <= 32_000_000, 'Use an image up to 8192 pixels per side and 32 megapixels.');
  return {width, height, mimeType, extension, byteLength:bytes.length, sha256:hash(bytes)};
}

export function originalImagePayload(image) {
  const match = /^data:(image\/(?:png|jpeg|webp));base64,([A-Za-z0-9+/]+={0,2})$/.exec(image?.source || '');
  need(match && match[2].length <= Math.ceil(IMAGE_BYTES*4/3), 'The original reference image is missing or exceeds 50 MB.');
  const bytes = Buffer.from(match[2], 'base64');need(bytes.toString('base64') === match[2], 'Invalid reference image encoding.');
  const info = inspectSheetImage(bytes);
  need(info.mimeType === match[1] && info.width === image.width && info.height === image.height, 'A reference image does not match its file type or dimensions.');
  return {...info, bytes};
}

export function prepareSheetRequest({requestId, project, model, quality, complexity, annotationPreviews=[], inputBoards=[]} = {}) {
  need(typeof requestId === 'string' && uuid.test(requestId), 'Choose a valid sheet request ID.');
  need(SHEET_MODELS.some(entry => entry.id === model), 'Choose a supported image model.');
  quality=validateGenerationQuality(model,quality);
  complexity=validateGenerationComplexity(model,complexity);
  validateProject(project);
  const preset=getSheetPreset(project),plan=sheetGenerationPlan(project),source=plan.photos[0].photo;
  const logical=sheetGenerationInputOrder(plan,annotationPreviews,{readOriginal:originalImagePayload,identity:image=>image.sha256,readGuide:(image,photo)=>{
    const guide=originalImagePayload(image),expected=sheetPreviewDimensions(photo.width,photo.height);
    need(guide.mimeType==='image/png'&&guide.width===expected.width&&guide.height===expected.height,'A sheet annotation guide does not match its photo dimensions. Rebuild the request.');
    return guide;
  }});
  need(logical.images.reduce((sum,image)=>sum+image.byteLength,0)<=REFERENCE_BYTES,'Choose reference images totaling no more than 64 MB.');
  const packed=applyGenerationInputPacking(logical.images,logical.roles,inputBoards,originalImagePayload,REFERENCE_BYTES),{images,roles:imageRoles}=packed;
  const prompt=buildSheetPrompt(project,packed.inputPacking?packingPromptRoles(imageRoles):imageRoles,{compact:Boolean(packed.inputPacking)})+(packed.inputPacking?'\n\n'+PACKED_INPUT_INSTRUCTIONS:'');
  need(prompt.length <= 32000, 'Shorten the sheet notes and reference notes to fit the image model prompt limit.');
  const size='1536x1024';
  return {id:requestId.toLowerCase(), model, quality, ...(complexity===undefined?{}:{complexity}), size, prompt, images, inputRoles:imageRoles, sourceName:source.name || 'Subject image', views:preset.views,...(packed.inputPacking?{inputPacking:packed.inputPacking}:{}),
    fingerprint:hash(JSON.stringify({model,quality,...(complexity===undefined?{}:{complexity}),size,prompt,images:images.map(image => image.sha256),...(packed.inputPacking?{logicalImages:logical.images.map(image=>image.sha256)}:{})}))};
}

async function readJSON(response, limit) {
  need(Number(response.headers.get('content-length') || 0) <= limit, 'The image provider response is too large.', 502);
  const chunks = [];let length = 0;
  for await (const chunk of response.body || []) {length += chunk.length;need(length <= limit, 'The image provider response is too large.', 502);chunks.push(Buffer.from(chunk));}
  try {return JSON.parse(Buffer.concat(chunks).toString('utf8'));} catch {throw fail(502, 'The image provider returned an unreadable response.');}
}
async function atomic(filename, bytes, renameFile = rename) {
  const temp = `${filename}.${randomBytes(8).toString('hex')}.tmp`;
  try {
    await writeFile(temp,bytes,{flag:'wx'});
    // Windows readers and antivirus can briefly lock a destination during an
    // atomic replace. Retry only that filesystem operation, never generation.
    for (let attempt = 0; ; attempt++) {
      try {await renameFile(temp,filename);break;}
      catch (error) {
        if (!['EPERM','EBUSY','EACCES'].includes(error.code) || attempt >= 6) throw error;
        await new Promise(resolve => setTimeout(resolve,20 * 2 ** attempt));
      }
    }
  } finally {await unlink(temp).catch(()=>{});}
}

/** One paid submission per immutable request ID; credentials remain server-only. */
export function createDesktopSheetService({directory=fileURLToPath(new URL('./data/sheet-jobs/',import.meta.url)),getKey=readSheetAPIKey,fetchImpl=globalThis.fetch,timeoutMs=600000,maxStoredBytes=2*1024*1024*1024,maxStoredResults=2048,prepareRequest=prepareSheetRequest,label='sheet',renameFile=rename,queue=null}={}) {
  need(['sheet','image'].includes(label),'Invalid generation service label.');
  need(Number.isSafeInteger(maxStoredBytes)&&maxStoredBytes>0&&Number.isSafeInteger(maxStoredResults)&&maxStoredResults>0,'Invalid local history storage limits.');
  const token = randomBytes(32).toString('hex'), jobs = new Map(), starts = new Map(), sourceChecks = new Map(), recordAccess = new Map();
  let disposed = false, catalog = null, catalogExpiry = 0, catalogPromise = null;
  directory = path.resolve(directory);
  const ownsQueue=!queue;queue ||= createGenerationQueue({directory:path.join(directory,'queue')});
  const checkId = id => {need(typeof id === 'string' && uuid.test(id),`Choose a valid ${label} request ID.`);return id.toLowerCase();};
  const filename = (id, ext) => path.join(directory,`${checkId(id)}.${ext}`);
  async function withRecordFile(id,operation) {
    // On Windows a polling read can hold the destination open during rename.
    // Serialize our own file handles; external locks still use bounded retries.
    const previous=recordAccess.get(id)||Promise.resolve(),pending=previous.catch(()=>{}).then(operation);
    recordAccess.set(id,pending);
    try{return await pending;}finally{if(recordAccess.get(id)===pending)recordAccess.delete(id);}
  }
  const write = record => withRecordFile(record.id,()=>atomic(filename(record.id,'json'), JSON.stringify(record),renameFile));
  async function record(id) {
    id = checkId(id);
    return withRecordFile(id,async()=>{
      let value;
      try {value = JSON.parse(await readFile(filename(id,'json'),'utf8'));} catch(error) {if(error.code === 'ENOENT')throw fail(404,`That ${label} request was not found.`);throw error;}
      need(value.id === id && ['queued','running','completed','failed','cancelled','expired'].includes(value.status),`The saved ${label} request is invalid.`,500);
      return value;
    });
  }
  const inputExtension = input => ({'image/png':'png','image/jpeg':'jpg','image/webp':'webp'})[input?.mimeType];
  const inputFile = (id,input) => {
    need(Number.isInteger(input?.index)&&input.index>=1&&input.index<=16&&inputExtension(input),'The saved input metadata is invalid.',500);
    return filename(id,`input-${input.index}.${inputExtension(input)}`);
  };
  const reviewSourceFile = (id,source) => {
    need(inputExtension(source),'The saved blockout file type is invalid.',500);
    return filename(id,`review-source.${inputExtension(source)}`);
  };
  const outputFile = value => {
    if(value.review&&value.image?.attempt!==undefined){
      need(Number.isInteger(value.image.attempt)&&value.image.attempt>=1&&value.image.attempt<=3,'The saved candidate pointer is invalid.',500);
      return filename(value.id,`attempt-${value.image.attempt}.png`);
    }
    return filename(value.id,'png');
  };
  function reviewSettings(prepared) {
    if(!prepared.review)return null;
    const review=prepared.review;
    need(label==='image'&&review.enabled===true,'Blockout review is available for desktop image generation only.');
    need(review.model===BLOCKOUT_MODEL&&review.effort===BLOCKOUT_EFFORT,'Blockout review requires GPT-6 Astra with max reasoning. No alternate model or effort will be used.');
    need(Number.isInteger(review.maxAttempts)&&review.maxAttempts>=1&&review.maxAttempts<=3,'Choose between one and three total image attempts for blockout review.');
    need(typeof review.assetId==='string'&&review.assetId.length>0&&review.assetId.length<=300,'Choose the original Blender blockout image for review.');
    need(typeof review.authorizedChanges==='string'&&review.authorizedChanges.length<=8000,'Keep permitted blockout changes within 8000 characters.');
    const source=inspectSheetImage(review.source?.bytes);
    need(source.sha256===review.source.sha256&&source.width===review.source.width&&source.height===review.source.height&&source.mimeType===review.source.mimeType,'The chosen blockout image failed its integrity check.');
    need(prepared.images.some(image=>image.sha256===source.sha256),'The original blockout must also be included in the generation inputs.');
    if(review.source.name!==undefined){need(typeof review.source.name==='string'&&review.source.name.length<=500,'The chosen blockout name is invalid.');source.name=review.source.name;}
    return {enabled:true,model:BLOCKOUT_MODEL,effort:BLOCKOUT_EFFORT,maxAttempts:review.maxAttempts,assetId:review.assetId,authorizedChanges:review.authorizedChanges,source};
  }
  const exists = async target => {try{return(await stat(target)).isFile();}catch(error){if(error.code==='ENOENT')return false;throw error;}};
  function sourceSnapshot(project) {
    // Preserve the exact editable document, including dormant references,
    // sketches and variants. Provider image previews are not a source backup.
    if(project===undefined)return null; // Custom service adapters may have no native document.
    validateProject(project);
    let bytes;try{bytes=Buffer.from(JSON.stringify(project),'utf8');}catch{throw fail(400,'The editable source project could not be saved.');}
    need(bytes.length<=SHEET_REQUEST_BYTES,'The editable source project exceeds the 128 MB request limit.',413);
    return {bytes,metadata:{version:1,sha256:hash(bytes),byteLength:bytes.length}};
  }
  function sourceMetadata(value) {
    need(value.sourceProject,'This earlier generation has no saved editable source project. Open a saved .asun project to continue those edits.',404);
    const info=value.sourceProject;
    need(info.version===1&&/^[0-9a-f]{64}$/.test(info.sha256)&&Number.isSafeInteger(info.byteLength)&&info.byteLength>0&&info.byteLength<=SHEET_REQUEST_BYTES,'The saved editable source metadata is invalid.',500);
    return info;
  }
  async function readSource(value) {
    const info=sourceMetadata(value);let bytes;
    try {
      const target=filename(value.id,'project.asun'),size=await stat(target);
      need(size.isFile()&&size.size===info.byteLength,'The saved editable source project failed its integrity check.',500);
      bytes=await readFile(target);
    } catch(error) {if(error.code==='ENOENT')throw fail(404,'The editable source project is no longer stored. Open a saved .asun project to continue those edits.');throw error;}
    need(bytes.length===info.byteLength&&hash(bytes)===info.sha256,'The saved editable source project failed its integrity check.',500);
    let project;
    try{project=JSON.parse(bytes.toString('utf8'));validateProject(project);}catch{throw fail(500,'The saved editable source project is invalid and cannot be restored.');}
    return project;
  }
  async function sourceAvailability(value) {
    try {
      const info=sourceMetadata(value),file=await stat(filename(value.id,'project.asun'));
      const signature=`${info.sha256}:${info.byteLength}:${file.size}:${file.mtimeMs}:${file.ctimeMs}`;
      if(sourceChecks.get(value.id)!==signature){await readSource(value);sourceChecks.set(value.id,signature);}
      return {sourceProjectAvailable:true,sourceProjectMessage:''};
    } catch(error) {
      sourceChecks.delete(value.id);
      return {sourceProjectAvailable:false,sourceProjectMessage:error.code==='ENOENT'?'The editable source project is no longer stored. Open a saved .asun project to continue those edits.':error.statusCode?error.message:'The editable source project could not be read. Try again after checking local storage.'};
    }
  }
  const sameSource = (previous,prepared) => !previous.sourceProject || previous.sourceProject.sha256===prepared.sourceSnapshot?.metadata.sha256;
  async function jobMetadata(value,{summary=false,queuePosition}={}) {
    const settings=value.settings || null, outputAvailable=await exists(outputFile(value));
    const expired=value.status==='expired'||(value.status==='completed'&&!outputAvailable)||(!outputAvailable&&/older .* preview has expired/.test(value.message||''));
    const availableInputs=[];
    for(const input of settings?.inputs || [])if(await exists(inputFile(value.id,input)))availableInputs.push(input.index);
    const result={id:value.id,kind:label,status:expired?'expired':value.status,sourceName:value.sourceName,views:value.views,model:value.model,mode:value.mode||label,
      queuedAt:value.queuedAt||null,startedAt:value.startedAt||null,queuePosition:value.status==='queued'?(queuePosition===undefined?await queue.position(label,value.id):queuePosition):null,cancellable:value.status==='queued'&&!await exists(filename(value.id,'submitted')),
      createdAt:value.createdAt||null,finishedAt:value.finishedAt||null,message:expired?'This earlier output is no longer stored. Its available recorded settings are shown below.':value.message||'',
      legacy:!settings,settings:summary&&settings?{model:settings.model,quality:settings.quality,...(settings.complexity===undefined?{}:{complexity:settings.complexity}),size:settings.size,endpoint:settings.endpoint,inputCount:settings.inputs.length}:settings,
      outputAvailable,output:value.image?{width:value.image.width,height:value.image.height,name:value.image.name}:null,outputCheck:value.image?checkImageOutputSize(settings?.size,value.image):null,availableInputs,returned:value.returned||{},...await sourceAvailability(value)};
    if(value.review){result.phase=value.phase;result.attempt=value.attempt;result.review=value.review;if(!summary)result.attempts=value.attempts||[];}
    if(summary&&settings?.review)result.settings.review=settings.review;
    return result;
  }
  async function output(id) {
    const value=await record(id);let bytes;
    try{bytes=await readFile(outputFile(value));}catch(error){if(error.code==='ENOENT')throw fail(404,'This generated output is no longer stored.');throw error;}
    const info=inspectSheetImage(bytes);need(!value.image?.sha256||info.sha256===value.image.sha256,`The saved ${label} image failed its integrity check.`,500);
    return {bytes,...info,name:value.image?.name||`${value.id}.png`};
  }
  async function publicJob(value) {
    const result=await jobMetadata(value);
    if(result.outputAvailable&&!['queued','running'].includes(result.status)){const saved=await output(value.id);result.image={source:`data:image/png;base64,${saved.bytes.toString('base64')}`,width:saved.width,height:saved.height,name:saved.name};}
    return result;
  }
  function requestSettings(prepared) {
    const quality=validateGenerationQuality(prepared.model,prepared.quality),complexity=validateGenerationComplexity(prepared.model,prepared.complexity),size=prepared.size||'1536x1024';
    const complexitySetting=complexity===undefined?{}:{complexity};
    const options={model:prepared.model,prompt:prepared.prompt,quality,...complexitySetting,size,n:1,output_format:'png',background:'opaque'};
    need(prepared.images.length<=16,'The image provider accepts at most 16 uploaded images. Rebuild the reference boards before generating.');
    const inputs=prepared.images.map((image,index)=>{
      const roles=(prepared.inputRoles||[]).filter(role=>role.image===index+1);
      return {index:index+1,role:roles.map(role=>role.role).join('; ')||'input image',name:roles.find(role=>role.filename)?.filename||roles.find(role=>role.name)?.name||`Input ${index+1}`,
        roles:structuredClone(roles),sha256:image.sha256,width:image.width,height:image.height,mimeType:image.mimeType,byteLength:image.byteLength};
    });
    const settings={model:prepared.model,quality,...complexitySetting,size,prompt:prepared.prompt,endpoint:prepared.images.length?'/images/edits':'/images/generations',options,inputs,...(prepared.outputFraming?{outputFraming:structuredClone(prepared.outputFraming)}:{}),...(prepared.inputPacking?{inputPacking:structuredClone(prepared.inputPacking)}:{})};
    const review=reviewSettings(prepared);if(review)settings.review=review;
    return settings;
  }
  const queuedPayloadHash=value=>hash(JSON.stringify({settings:value.settings,sourceProject:value.sourceProject||null,fingerprint:value.fingerprint,sourceName:value.sourceName,views:value.views,mode:value.mode,queueSequence:value.queueSequence}));
  async function reserve(prepared, created) {
    // The exclusive claim also prevents duplicate submission from another local
    // server process sharing this folder. A missing result is never a retry cue.
    const claim = filename(prepared.id,'claim');
    try {await writeFile(claim,JSON.stringify({fingerprint:prepared.fingerprint,sourceProject:prepared.sourceSnapshot?.metadata,queuedPayloadHash:created.queuedPayloadHash}),{flag:'wx'});}
    catch(error) {
      if(error.code!=='EEXIST')throw error;
      const previous = JSON.parse(await readFile(claim,'utf8'));
      need(previous.fingerprint===prepared.fingerprint&&sameSource(previous,prepared),`This request ID already belongs to different ${label} settings or editable source.`,409);
      for(let attempt=0;attempt<20;attempt++) {
        try {return await publicJob(await record(prepared.id));}
        catch(readError) {if(readError.statusCode!==404)throw readError;await new Promise(resolve=>setTimeout(resolve,25));}
      }
      throw fail(409,'This request was already reserved. Its outcome is uncertain; it will not be submitted again automatically.');
    }
    await write(created);return null;
  }
  async function status({refresh=false}={}) {
    need(!disposed,`The ${label} service is closed.`,503);
    const credential = getKey();
    const capabilities=entry=>{const complexities=generationComplexityOptions(entry.id);return {...entry,qualities:generationQualityOptions(entry.id),complexities,...(complexities.length?{defaultComplexity:DEFAULT_GENERATION_COMPLEXITY}:{})};};
    if(!credential)return {configured:false,authenticated:false,defaultQuality:DEFAULT_GENERATION_QUALITY,models:SHEET_MODELS.map(entry=>({...capabilities(entry),available:false})),message:`Connect OPENAI_API_KEY on this PC to generate ${label}s. API usage is billed separately from ChatGPT.`,token};
    if(!refresh && catalog && catalogExpiry > Date.now())return {...catalog,token};
    if(catalogPromise)return catalogPromise;
    catalogPromise = (async()=>{
      try {
        const response = await fetchImpl(API+'/models',{headers:{Authorization:`Bearer ${credential}`},signal:AbortSignal.timeout(15000),redirect:'error'});
        const data = await readJSON(response,4*1024*1024);
        if(!response.ok)throw new Error(data.error?.message || `Image model access check failed (${response.status}).`);
        need(Array.isArray(data.data),'The image model list was invalid.',502);
        const available = new Set(data.data.map(item=>item.id));
        catalog = {configured:true,authenticated:true,defaultQuality:DEFAULT_GENERATION_QUALITY,models:SHEET_MODELS.map(entry=>({...capabilities(entry),available:!entry.retired&&available.has(entry.id)})),reviewModel:{id:BLOCKOUT_MODEL,effort:BLOCKOUT_EFFORT,available:available.has(BLOCKOUT_MODEL)},message:`API connection verified. Generating ${label}s uses paid OpenAI API billing; access does not confirm remaining credit.`};
      } catch(error) {catalog = {configured:true,authenticated:false,defaultQuality:DEFAULT_GENERATION_QUALITY,models:SHEET_MODELS.map(entry=>({...capabilities(entry),available:false})),message:safeMessage(error,credential)};}
      catalogExpiry = Date.now()+60000;return {...catalog,token};
    })().finally(()=>{catalogPromise=null;});
    return catalogPromise;
  }
  async function makeRoom(prepared) {
    await mkdir(directory,{recursive:true});
    const entries = await readdir(directory);
    need(entries.filter(name=>/^[0-9a-f-]{36}\.json$/.test(name)).length < maxStoredResults,`The local ${label} history has reached its ${maxStoredResults}-request limit. Archive history on this PC before generating more. Existing images have been kept.`,507);
    let total = 0;
    for(const name of entries) {
      try{const info=await stat(path.join(directory,name));if(info.isFile())total+=info.size;}catch(error){if(error.code!=='ENOENT')throw error;}
      if(/^[0-9a-f-]{36}\.json$/.test(name)&&uuid.test(name.slice(0,-5))){
        const pending=await record(name.slice(0,-5));
        // Reserve room for another process already submitting a job here, in
        // addition to bytes present on disk. Conservative double counting is
        // preferable to beginning a paid request without room for its result.
        if(['queued','running'].includes(pending.status))total+=IMAGE_BYTES*(pending.settings?.review?pending.settings.review.maxAttempts:1);
      }
    }
    const inputBytes=prepared.images.reduce((sum,image)=>sum+image.byteLength,0);
    const review=prepared.settings.review,outputBudget=IMAGE_BYTES*(review?review.maxAttempts:1),reviewBudget=review?review.source.byteLength+8*1024*1024:0;
    need(total+inputBytes+(prepared.sourceSnapshot?.bytes.length||0)+outputBudget+reviewBudget+256*1024<=maxStoredBytes,`The local ${label} history has reached its storage limit (${Math.round(maxStoredBytes/1024/1024)} MB). Archive history on this PC before generating more. Existing images have been kept.`,507);
  }
  async function generateReviewedCandidate(prepared,options,credential,signal) {
    const body=new FormData();
    for(const [name,value] of Object.entries(options))body.append(name,String(value));
    prepared.images.forEach((image,index)=>body.append('image[]',new Blob([image.bytes],{type:image.mimeType}),`reference-${index+1}.${image.extension}`));
    const response=await fetchImpl(API+prepared.settings.endpoint,{method:'POST',headers:{Authorization:`Bearer ${credential}`},body,signal,redirect:'error'});
    const data=await readJSON(response,72*1024*1024);
    if(!response.ok)throw new Error(data.error?.message||`Image generation failed (${response.status}).`);
    const encoded=data.data?.[0]?.b64_json;
    need(data.data?.length===1&&typeof encoded==='string'&&/^[A-Za-z0-9+/]+={0,2}$/.test(encoded)&&encoded.length<=Math.ceil(IMAGE_BYTES*4/3),'The provider did not return one valid image.',502);
    const bytes=Buffer.from(encoded,'base64');need(bytes.toString('base64')===encoded,'Invalid generated image encoding.',502);
    const info=inspectSheetImage(bytes);need(info.mimeType==='image/png','The provider did not return the requested PNG image.',502);
    const returned={};for(const name of ['model','quality','complexity','size','output_format','background'])if(typeof data[name]==='string'&&data[name].length<=200)returned[name]=safeMessage({message:data[name]},credential);
    return {bytes,info,returned};
  }
  async function executeReviewed(prepared,credential,controller) {
    const policy=prepared.settings.review,attempts=[];
    let number=0,prompt=prepared.prompt,phase='generating';
    const stepSignal=()=>AbortSignal.any([controller.signal,AbortSignal.timeout(timeoutMs)]);
    const reviewState=(status,extra={})=>({enabled:true,model:policy.model,effort:policy.effort,status,maxAttempts:policy.maxAttempts,assetId:policy.assetId,sourceSha256:policy.source.sha256,...extra});
    try {
      for(number=1;number<=policy.maxAttempts;number++) {
        phase='generating';
        const options={...prepared.settings.options,prompt};
        const attempt={number,status:'running',phase,startedAt:new Date().toISOString(),settings:{...prepared.settings,prompt,options}};
        attempts.push(attempt);
        // Every additional paid operation has its own durable, exclusive claim.
        // A crash or uncertain response is never permission to replay that call.
        await writeFile(filename(prepared.id,`attempt-${number}.submitted`),JSON.stringify({number,phase,ownerPid:process.pid,submittedAt:attempt.startedAt,settingsHash:hash(JSON.stringify(options))}),{flag:'wx'});
        await write({...await record(prepared.id),phase,attempt:number,attempts,review:reviewState('generating'),message:`Generating attempt ${number} of ${policy.maxAttempts}; Astra will compare it with the original blockout.`});
        const candidate=await generateReviewedCandidate(prepared,options,credential,stepSignal());
        const image={...candidate.info,name:outputName(prepared),attempt:number};
        await atomic(filename(prepared.id,`attempt-${number}.png`),candidate.bytes,renameFile);
        // Publish only a pointer after the immutable candidate is durable. A
        // polling reader or failed record write can still read the prior image.
        attempt.candidate=image;attempt.returned=candidate.returned;attempt.generatedAt=new Date().toISOString();attempt.phase='reviewing';phase='reviewing';
        const outputCheck=checkImageOutputSize(prepared.settings.size,candidate.info);
        if(outputCheck&&!outputCheck.matches) {
          // The encoded pixels are definitive. Do not pay for a visual review
          // or let a reviewer approve a candidate that violates the output size.
          attempt.status='failed';attempt.phase='output-size-mismatch';attempt.outputCheck=outputCheck;attempt.error=outputCheck.message;attempt.finishedAt=new Date().toISOString();
          await write({...await record(prepared.id),status:'failed',phase:'needs_review',attempt:number,attempts,image,outputCheck,returned:candidate.returned,review:reviewState('error',{candidateSha256:image.sha256,summary:outputCheck.message}),message:`Needs review: ${outputCheck.message} Astra review was not submitted.`,finishedAt:new Date().toISOString()});return;
        }
        await write({...await record(prepared.id),phase,attempt:number,attempts,image,outputCheck,returned:candidate.returned,review:reviewState('reviewing',{candidateSha256:image.sha256}),message:`Astra is reviewing attempt ${number} against the original blockout. This image is not approved yet.`});
        await writeFile(filename(prepared.id,`attempt-${number}.review-submitted`),JSON.stringify({number,ownerPid:process.pid,submittedAt:new Date().toISOString(),sourceSha256:policy.source.sha256,candidateSha256:image.sha256}),{flag:'wx'});
        const mappedInput=(input,index)=>{const entry=prepared.settings.inputs[index];return {...input,role:entry?.role,name:entry?.name,generationInputs:[{index:entry.index,roles:entry.roles||[]}]};};
        const mapped=prepared.images.map(mappedInput),source={...prepared.review.source,generationInputs:mapped.filter(input=>input.sha256===policy.source.sha256).flatMap(input=>input.generationInputs)};
        const inputs=mapped.filter(input=>input.sha256!==policy.source.sha256);
        const review=await reviewBlockout({source,candidate:{...candidate.info,bytes:candidate.bytes,generationInputs:[]},inputs,constraints:{authorizedChanges:policy.authorizedChanges,originalPrompt:prepared.prompt},credential,fetchImpl,signal:stepSignal()});
        need(review.sourceSha256===policy.source.sha256&&review.candidateSha256===image.sha256,'The review does not match the saved blockout and candidate. Review stopped.',502);
        const decision=review.verdict?.decision;need(['accept','reject','inconclusive'].includes(decision),'The reviewer did not return a supported decision.',502);
        attempt.review=review;attempt.finishedAt=new Date().toISOString();attempt.status=decision==='accept'?'accepted':decision==='reject'?'rejected':'inconclusive';attempt.phase='reviewed';
        if(decision==='accept') {
          await write({...await record(prepared.id),status:'completed',phase:'completed',attempt:number,attempts,review:reviewState('accepted',{candidateSha256:image.sha256,summary:review.verdict.summary}),message:`Astra accepted attempt ${number}: its visible composition matches the blockout within the review's limits. Exact 3D measurements are not verified from an image.`,finishedAt:new Date().toISOString()});return;
        }
        if(decision==='inconclusive'||number===policy.maxAttempts) {
          await write({...await record(prepared.id),status:'failed',phase:'needs_review',attempt:number,attempts,review:reviewState(decision==='reject'?'rejected':'inconclusive',{candidateSha256:image.sha256,summary:review.verdict.summary}),message:decision==='reject'?`Needs review: Astra rejected all ${number} permitted image attempt${number===1?'':'s'}. The latest candidate and every review are saved for inspection.`:'Needs review: Astra could not confidently assess this image. The candidate is saved; no corrective generation was sent.',finishedAt:new Date().toISOString()});return;
        }
        // Only a conclusive rejection can authorize a new corrective attempt.
        prompt=buildBlockoutCorrectionPrompt(prepared.prompt,review.verdict,number+1);
        await write({...await record(prepared.id),attempts,review:reviewState('rejected',{candidateSha256:image.sha256,summary:review.verdict.summary}),message:`Astra rejected attempt ${number}. Preparing the next attempt with its corrections and the same original inputs.`});
      }
    } catch(error) {
      const interrupted=controller.signal.aborted||error?.name==='TimeoutError'||error?.name==='AbortError';
      const reason=interrupted?'Stopped waiting. The provider may still finish and charge for the submitted operation.':error?.code==='EEXIST'?'This attempt was already marked for submission. Its provider outcome is uncertain; it will not be sent again.':safeMessage(error,credential);
      const last=attempts.at(-1);if(last){
        last.status='failed';last.error=reason;last.finishedAt=new Date().toISOString();
        // Failed/refused/malformed reviews still retain the safe request audit;
        // this is evidence of what was submitted, never an approval verdict.
        if(phase==='reviewing'&&error?.reviewRequest){
          last.reviewRequest=JSON.parse(JSON.stringify(error.reviewRequest).split(credential).join('[redacted]'));
          last.reviewModel=BLOCKOUT_MODEL;last.reviewEffort=BLOCKOUT_EFFORT;
        }
      }
      try {const current=await record(prepared.id);await write({...current,status:'failed',phase:'needs_review',attempt:number,attempts,review:reviewState('error',{candidateSha256:current.image?.sha256}),message:`Needs review: ${reason} No automatic retry was made. Any saved candidate remains available to inspect.`,finishedAt:new Date().toISOString()});}catch{/* Leave the interrupted record recoverable without resubmission. */}
    } finally {jobs.delete(prepared.id);}
  }
  async function execute(prepared, credential, controller) {
    if(prepared.review)return executeReviewed(prepared,credential,controller);
    const timer = setTimeout(()=>controller.abort(),timeoutMs);
    try {
      const options=prepared.settings.options,endpoint=prepared.settings.endpoint;
      let body,headers={Authorization:`Bearer ${credential}`};
      if(prepared.images.length) {
        body=new FormData();
        for(const [name,value] of Object.entries(options))body.append(name,String(value));
        prepared.images.forEach((image,index)=>body.append('image[]',new Blob([image.bytes],{type:image.mimeType}),`reference-${index+1}.${image.extension}`));
      } else {body=JSON.stringify(options);headers['Content-Type']='application/json';}
      // Never retry a paid POST, including when its outcome is uncertain.
      const response = await fetchImpl(API+endpoint,{method:'POST',headers,body,signal:controller.signal,redirect:'error'});
      const data = await readJSON(response,72*1024*1024);
      if(!response.ok)throw new Error(data.error?.message || `Image generation failed (${response.status}).`);
      const encoded = data.data?.[0]?.b64_json;
      need(data.data?.length === 1 && typeof encoded === 'string' && /^[A-Za-z0-9+/]+={0,2}$/.test(encoded) && encoded.length <= Math.ceil(IMAGE_BYTES*4/3),`The provider did not return one valid ${label} image.`,502);
      const bytes = Buffer.from(encoded,'base64');need(bytes.toString('base64') === encoded,'Invalid generated image encoding.',502);
      const info = inspectSheetImage(bytes);need(info.mimeType === 'image/png','The provider did not return the requested PNG image.',502);
      const current = await record(prepared.id);
      // Keep resolved provider fields separate from requested values (notably
      // quality:auto). Missing response fields stay unknown.
      const returned={};
      for(const name of ['model','quality','complexity','size','output_format','background'])if(typeof data[name]==='string'&&data[name].length<=200)returned[name]=safeMessage({message:data[name]},credential);
      await atomic(filename(prepared.id,'png'),bytes,renameFile);
      const outputCheck=checkImageOutputSize(options.size,info);
      await write({...current,status:'completed',message:outputCheck&&!outputCheck.matches?outputCheck.message:`Your generated ${label} is ready.`,finishedAt:new Date().toISOString(),returned,outputCheck,image:{...info,name:outputName(prepared)}});
    } catch(error) {
      const message = controller.signal.aborted ? `Stopped waiting for this ${label}. The provider may still finish and charge for it. No automatic retry was made.` : safeMessage(error,credential)+' No automatic retry was made.';
      try {const current = await record(prepared.id);await write({...current,status:'failed',message,finishedAt:new Date().toISOString()});} catch { /* An interrupted record remains recoverable without resubmitting. */ }
    } finally {clearTimeout(timer);jobs.delete(prepared.id);}
  }
  async function admit(prepared,queueSequence) {
    need(!disposed,`The ${label} service is closed.`,503);
    let previous;try {previous=await record(prepared.id);} catch(error) {if(error.statusCode !== 404)throw error;}
    if(previous) {
      need(previous.fingerprint === prepared.fingerprint&&sameSource(previous,prepared),`This request ID already belongs to different ${label} settings or editable source. Create a new request.`,409);
      return publicJob(previous);
    }
      const access = await status();need(access.authenticated,access.message,401);
      need(access.models.some(entry=>entry.id===prepared.model && entry.available),'This image model is unavailable to the connected API account.',403);
      if(prepared.review)need(access.reviewModel?.id===BLOCKOUT_MODEL&&access.reviewModel.available,'GPT-6 Astra is unavailable to the connected API account. Blockout review cannot run; no generation request was sent. No substitute reviewer will be used.',403);
      await makeRoom(prepared);
      const queuedAt=new Date().toISOString();
      const created = {id:prepared.id,status:'queued',queueSequence,queuedAt,sourceName:prepared.sourceName,views:prepared.views,model:prepared.model,mode:prepared.mode || label,fingerprint:prepared.fingerprint,sourceProject:prepared.sourceSnapshot?.metadata,createdAt:queuedAt,settings:prepared.settings,message:`Your ${label} is queued. You can keep editing or start another project.`};
      if(prepared.review){created.phase='queued';created.attempt=0;created.attempts=[];created.review={enabled:true,model:BLOCKOUT_MODEL,effort:BLOCKOUT_EFFORT,status:'pending',maxAttempts:prepared.settings.review.maxAttempts,assetId:prepared.settings.review.assetId,sourceSha256:prepared.settings.review.source.sha256};}
      created.queuedPayloadHash=queuedPayloadHash(created);
      const reserved=await reserve(prepared,created);if(reserved)return reserved;
      try {
        // Inputs, the editable source and immutable settings precede a paid call.
        if(prepared.sourceSnapshot)await atomic(filename(prepared.id,'project.asun'),prepared.sourceSnapshot.bytes,renameFile);
        for(const [index,image] of prepared.images.entries())await atomic(inputFile(prepared.id,prepared.settings.inputs[index]),image.bytes,renameFile);
        if(prepared.review)await atomic(reviewSourceFile(prepared.id,prepared.settings.review.source),prepared.review.source.bytes,renameFile);
      } catch(error) {
        await write({...created,status:'failed',finishedAt:new Date().toISOString(),message:'The editable source or input images could not be saved to local history. No generation request was sent.'});
        throw fail(507,'The editable source or input images could not be saved to local history. No generation request was sent.');
      }
      return publicJob(created);
  }
  async function queuedInput(current) {
    const claim=JSON.parse(await readFile(filename(current.id,'claim'),'utf8'));
    need(current.queuedPayloadHash&&current.queuedPayloadHash===claim.queuedPayloadHash&&current.queuedPayloadHash===queuedPayloadHash(current),'The queued request failed its saved settings integrity check. No generation request was sent.',500);
    need(current.settings&&current.settings.options&&Array.isArray(current.settings.inputs),'This queued request is missing its saved generation settings.',500);
    const settings=current.settings;
    need(settings.model===current.model&&settings.options.model===current.model&&settings.options.prompt===settings.prompt&&settings.options.quality===settings.quality&&settings.options.complexity===settings.complexity&&settings.options.size===settings.size,'The queued generation settings do not match their saved values.',500);
    validateGenerationQuality(current.model,settings.quality);
    need(validateGenerationComplexity(current.model,settings.complexity)===settings.complexity,'The queued complexity setting is missing or unsupported. No generation request was sent.',500);
    if(current.sourceProject)await readSource(current);
    const images=[];
    for(const input of settings.inputs){
      const bytes=await readFile(inputFile(current.id,input)),info=inspectSheetImage(bytes);
      need(info.sha256===input.sha256&&info.mimeType===input.mimeType&&info.width===input.width&&info.height===input.height&&info.byteLength===input.byteLength,'A queued reference image failed its integrity check. No generation request was sent.',500);
      images.push({...info,bytes});
    }
    need(settings.endpoint===(images.length?'/images/edits':'/images/generations'),'The queued generation endpoint is invalid.',500);
    const prepared={...current,quality:settings.quality,...(settings.complexity===undefined?{}:{complexity:settings.complexity}),size:settings.size,prompt:settings.prompt,settings,images};
    if(settings.review){
      const expected=settings.review.source,bytes=await readFile(reviewSourceFile(current.id,expected)),source=inspectSheetImage(bytes);
      need(source.sha256===expected.sha256&&source.width===expected.width&&source.height===expected.height&&source.mimeType===expected.mimeType&&source.byteLength===expected.byteLength,'The saved original blockout failed its integrity check. No generation request was sent.',500);
      prepared.review={...settings.review,source:{...source,...(expected.name!==undefined?{name:expected.name}:{}),bytes}};reviewSettings(prepared);
    }else delete prepared.review;
    return prepared;
  }
  async function dispatch(id) {
    need(!disposed,`The ${label} service is closed.`,503);
    const current=await record(id);if(current.status!=='queued')return {completion:Promise.resolve()};
    let prepared,credential;
    try{
      prepared=await queuedInput(current);
      const access=await status();need(access.authenticated,access.message,401);need(access.models.some(entry=>entry.id===current.model&&entry.available),'This image model is unavailable to the connected API account. No generation request was sent.',403);
      if(prepared.review)need(access.reviewModel?.id===BLOCKOUT_MODEL&&access.reviewModel.available,'GPT-6 Astra is unavailable to the connected API account. No generation request was sent. No substitute reviewer will be used.',403);
      credential=getKey();need(credential,'The API connection is no longer available. No generation request was sent.',401);
      // Separate submission claim from admission. A crash after this marker is
      // uncertain, even if the record still says queued: never POST it twice.
      await writeFile(filename(id,'submitted'),JSON.stringify({fingerprint:current.fingerprint,ownerPid:process.pid,submittedAt:new Date().toISOString()}),{flag:'wx'});
      const running={...current,status:'running',ownerPid:process.pid,startedAt:new Date().toISOString(),message:`Generating your ${label}… You can keep editing or queue another image.`};
      await write(running);
      const controller=new AbortController();jobs.set(id,controller);
      return {completion:execute(prepared,credential,controller)};
    }catch(error){
      const uncertain=error.code==='EEXIST'||await exists(filename(id,'submitted'));
      await write({...current,status:'failed',...(current.review?{phase:'needs_review',review:{...current.review,status:'error'}}:{}),finishedAt:new Date().toISOString(),message:uncertain?'This request was already marked for submission. Its provider outcome is uncertain; it will not be submitted again automatically.':safeMessage(error,credential||'')+' No generation request was sent.'});
      return {completion:Promise.resolve()};
    }
  }
  async function recoverRecord(id) {
    let current=await record(id);
    if(current.status==='running'&&!jobs.has(current.id)&&!starts.has(current.id)) {
      // A worker may have completed between reading its record and checking the
      // active map. Re-read before deciding that it was interrupted.
      current=await record(id);if(current.status!=='running')return current;
      let ownerAlive=false;
      if(Number.isInteger(current.ownerPid)&&current.ownerPid>0)try{process.kill(current.ownerPid,0);ownerAlive=true;}catch{/* The submitting process has exited. */}
      if(!ownerAlive){current={...current,status:'failed',...(current.review?{phase:'needs_review',review:{...current.review,status:'error'}}:{}),finishedAt:new Date().toISOString(),message:current.review?'Needs review: the app server stopped during blockout generation or review. Any saved candidate remains available. The provider may have billed the submitted operation. No operation will be submitted again automatically.':`The app server restarted before the ${label} result was saved. The provider may have billed this request. It will not be submitted again automatically.`};await write(current);}
    }
    if(current.status==='completed'&&!await exists(outputFile(current)))return {...current,status:'expired'};
    return current;
  }
  const sortKey=value=>[value.createdAt||'',value.id];
  const compare=(a,b)=>b[0].localeCompare(a[0])||b[1].localeCompare(a[1]);
  async function scan() {
    let names;try{names=await readdir(directory);}catch(error){if(error.code==='ENOENT')return [];throw error;}
    const result=[];for(const name of names)if(/^[0-9a-f-]{36}\.json$/.test(name)&&uuid.test(name.slice(0,-5)))result.push(await recoverRecord(name.slice(0,-5)));
    return result;
  }
  queue.register(label,{scan,dispatch,summarize:(value,options)=>jobMetadata(value,{...options,summary:true})});
  return {token,status,output,queue,
    async start(input) {
      const prepared = prepareRequest(input);prepared.settings=requestSettings(prepared);prepared.sourceSnapshot=sourceSnapshot(input?.project);
      const pending=starts.get(prepared.id);
      if(pending) {need(pending.fingerprint===prepared.fingerprint&&pending.sourceHash===prepared.sourceSnapshot?.metadata.sha256,`This request ID already belongs to different ${label} settings or editable source.`,409);return pending.promise;}
      const promise=queue.admit(sequence=>admit(prepared,sequence)).then(value=>{queue.wake();return value;}).finally(()=>starts.delete(prepared.id));starts.set(prepared.id,{fingerprint:prepared.fingerprint,sourceHash:prepared.sourceSnapshot?.metadata.sha256,promise});return promise;
    },
    async cancel(id) {
      id=checkId(id);
      const value=await queue.withLock(async()=>{
        const current=await record(id);if(current.status==='cancelled')return current;
        need(current.status==='queued','Only queued generations can be cancelled. This request has already started or finished.',409);
        need(!await exists(filename(id,'submitted')),'This request was already marked for submission. Its provider outcome is uncertain, so it cannot be cancelled as an unstarted job.',409);
        const cancelled={...current,status:'cancelled',finishedAt:new Date().toISOString(),message:'Cancelled before generation started. No provider request was sent.'};await write(cancelled);return cancelled;
      });queue.wake();return publicJob(value);
    },
    resumeQueue(){queue.resume();},
    async job(id) {return publicJob(await recoverRecord(id));},
    async project(id) {return {project:await readSource(await record(id))};},
    async input(id,index) {
      need(/^(?:[1-9]|1[0-6])$/.test(String(index)),'Choose an input image number from 1 to 16.');
      const current=await record(id),entry=current.settings?.inputs?.find(input=>input.index===Number(index));
      need(entry,'This request has no recorded image at that input number.',404);
      let bytes;try{bytes=await readFile(inputFile(current.id,entry));}catch(error){if(error.code==='ENOENT')throw fail(404,'This input image is no longer stored.');throw error;}
      const info=inspectSheetImage(bytes);need(info.sha256===entry.sha256&&info.mimeType===entry.mimeType&&info.width===entry.width&&info.height===entry.height,'The saved input image failed its integrity check.',500);
      return {bytes,...info,name:entry.name};
    },
    async history({limit=20,cursor=null}={}) {
      need(/^\d+$/.test(String(limit))&&Number(limit)>=1&&Number(limit)<=50,'Choose a history page size from 1 to 50.');limit=Number(limit);
      let after=null;
      if(cursor!==null&&cursor!==''){
        need(typeof cursor==='string'&&cursor.length<=512&&/^[A-Za-z0-9_-]+$/.test(cursor),'Invalid history page cursor.');
        try{after=JSON.parse(Buffer.from(cursor,'base64url').toString('utf8'));}catch{throw fail(400,'Invalid history page cursor.');}
        need(Array.isArray(after)&&after.length===2&&typeof after[0]==='string'&&(after[0]===''||/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(after[0]))&&typeof after[1]==='string'&&uuid.test(after[1]),'Invalid history page cursor.');
      }
      let names;try{names=await readdir(directory);}catch(error){if(error.code==='ENOENT')return {items:[],nextCursor:null};throw error;}
      const records=[];
      for(const name of names)if(/^[0-9a-f-]{36}\.json$/.test(name)&&uuid.test(name.slice(0,-5)))records.push(await record(name.slice(0,-5)));
      records.sort((a,b)=>compare(sortKey(a),sortKey(b)));
      const remaining=after?records.filter(value=>compare(sortKey(value),after)>0):records,page=remaining.slice(0,limit),items=[];
      for(const value of page)items.push(await jobMetadata(await recoverRecord(value.id),{summary:true}));
      return {items,nextCursor:remaining.length>limit?Buffer.from(JSON.stringify(sortKey(page.at(-1)))).toString('base64url'):null};
    },
    dispose(){disposed=true;if(ownsQueue)queue.dispose();for(const controller of jobs.values())controller.abort();},
  };
}

export async function readSheetBody(request, limit=SHEET_REQUEST_BYTES, label='Sheet') {
  need(/^application\/json(?:\s*;|$)/i.test(request.headers['content-type']||''),`${label} generation accepts JSON image data.`,415);
  need(Number(request.headers['content-length']||0)<=limit,'The project is too large to send. Use a smaller reference project.',413);
  const chunks=[];let size=0;
  for await(const chunk of request) {size+=chunk.length;need(size<=limit,'The project is too large to send. Use a smaller reference project.',413);chunks.push(chunk);}
  try{return JSON.parse(Buffer.concat(chunks).toString('utf8'));}catch{throw fail(400,`Invalid ${label.toLowerCase()} request JSON.`);}
}
