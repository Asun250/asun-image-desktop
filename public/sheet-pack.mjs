// This pack carries a creation request, not a generated sheet. Every image
// original payload comes from the preserved source. Annotated previews are
// separately identified PNG guides and never replace the original photo bytes.
import {validateProject} from './core.mjs';
import {originalBlob, sourceFileInfo} from './image-source.mjs';
import {zipFiles, isWindowsReservedName} from './reference-download.mjs';
import {getSheetPreset,getSheetSubjectSources,getSheetInputPhotos,sheetAngles,buildSheetPrompt} from './sheet-preset.mjs';
import {buildSheetGenerationInput} from './sheet-generation-input.mjs';

const extensions = {'image/png':'.png', 'image/jpeg':'.jpg', 'image/webp':'.webp'};
const jsonBlob = value => new Blob([JSON.stringify(value, null, 2) + '\n'], {type:'application/json'});
const escape = value => String(value ?? '').replace(/[&<>"']/g, character => ({'&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;'}[character]));
function safeName(value, fallback) {
  let text = String(value ?? '').toWellFormed().normalize('NFC').replace(/[<>:"/\\|?*\x00-\x1f\x7f-\x9f]/g, '_').trim().replace(/[. ]+$/, '');
  if (!text || ['.', '..'].includes(text)) text = fallback;
  if (isWindowsReservedName(text)) text = '_' + text;
  text = text.slice(0, 110).replace(/[\uD800-\uDBFF]$/, '').replace(/[. ]+$/, '');
  return text || fallback;
}
function allocateNames() {
  const names = new Set();
  return (name, extension) => {
    let result = name + extension, suffix = 2;
    while (names.has(result.normalize('NFC').toUpperCase())) result = `${name}-${suffix++}${extension}`;
    names.add(result.normalize('NFC').toUpperCase());
    return result;
  };
}
async function checksum(blob) {
  return Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', await blob.arrayBuffer())), byte => byte.toString(16).padStart(2, '0')).join('');
}
async function sourceRecord(image, identity, directory, allocate) {
  const info = sourceFileInfo(image), blob = originalBlob(image);
  const path = directory + '/' + allocate(safeName(info.name.replace(/\.[^.]*$/, ''), 'image'), extensions[info.mimeType]);
  const record = {...identity, path, originalFilename:info.name, width:image.width, height:image.height, mimeType:info.mimeType, byteLength:blob.size, sha256:await checksum(blob)};
  return {blob, record};
}

export async function exportSheetPack(project) {
  validateProject(project);
  const preset = getSheetPreset(project);
  if (!preset.active) throw new Error('Choose Character / item sheet before preparing this pack.');
  const image = getSheetSubjectSources(project)[0];
  if (!image) throw new Error('Choose a subject photo before preparing a character / item sheet.');
  const {annotationPreviews}=await buildSheetGenerationInput(project);
  const files=[],assets=[],angles=sheetAngles(preset),mainImages=[],selected=[],generatedPreviews=[],imageRoles=[];
  const names={main:allocateNames(),reference:allocateNames(),guide:allocateNames()},stored=new Map(),photoRecords=new Map();
  for(const {role,photo} of getSheetInputPhotos(project)){
    const identity=Object.hasOwn(project.assets,photo.id)?{assetId:photo.id}:{referenceId:photo.id};
    if(role==='main'&&Object.hasOwn(preset,'sourceId'))identity.sourceId=photo.id;
    Object.assign(identity,{photoId:photo.id,role,notes:photo.notes||''});
    if(photo.sourceAttribution)identity.sourceAttribution=structuredClone(photo.sourceAttribution);
    let saved=stored.get(photo.source),record;
    if(!saved){
      saved=await sourceRecord(photo,identity,role==='reference'?'originals/references':'originals/main',role==='reference'?names.reference:names.main);
      stored.set(photo.source,saved);files.push({name:saved.record.path,blob:saved.blob});
      assets.push({role,...identity,path:saved.record.path,paths:[saved.record.path],labels:[],name:saved.record.originalFilename,width:photo.width,height:photo.height,blob:saved.blob});
      record=saved.record;
    }else record={...saved.record,...identity,originalFilename:photo.originalFile?.name||photo.name};
    (role==='reference'?selected:mainImages).push(record);photoRecords.set(photo.id,record);
    imageRoles.push({path:record.path,photoId:photo.id,role:role==='main'?'primary subject original':role==='subject'?'additional subject original':'detail reference original'});
  }
  for(const preview of annotationPreviews){
    const original=photoRecords.get(preview.id),blob=originalBlob(preview.image),path='generated-previews/'+names.guide(safeName(preview.image.name.replace(/\.[^.]*$/,''),'annotation-guide'),'.png');
    const record={photoId:preview.id,role:'annotation-guide',originalPath:original.path,path,width:preview.image.width,height:preview.image.height,mimeType:'image/png',byteLength:blob.size,sha256:await checksum(blob)};
    generatedPreviews.push(record);files.push({name:path,blob});
    assets.push({role:'annotation-guide',photoId:preview.id,path,name:preview.image.name,width:preview.image.width,height:preview.image.height,blob});
    imageRoles.push({path,photoId:preview.id,role:'annotation guide',originalPath:original.path});
  }
  const prompt=buildSheetPrompt(project,imageRoles);
  const projectInfo = {name:project.name, width:project.width, height:project.height};
  const mapping = {format:'asun-sheet-pack', version:1, project:projectInfo, preset, angles,
    generatedPreviews,cleanMain:mainImages[0],mainImages,numbers:[],unassignedReferences:[],sheetReferences:selected};
  const request = {format:'asun-sheet-request', version:1, project:projectInfo, preset, angles, prompt,
    guidance:'Generate one new white-background character / item sheet from the clean MAIN and explicitly selected references. This pack contains source files and a request only; it contains no generated result.'};
  const sheet = {...mapping, request};
  files.push({name:'request.txt', blob:new Blob([prompt + '\n'], {type:'text/plain;charset=utf-8'})});
  files.push({name:'sheet.json', blob:jsonBlob(sheet)});
  files.push({name:'index.html', blob:new Blob([sheetHTML(sheet)], {type:'text/html;charset=utf-8'})});
  files.push({name:'README.txt', blob:new Blob([
    'ASUN IMG — CHARACTER / ITEM SHEET REQUEST\r\n\r\n',
    'Extract this ZIP and open index.html to review the request. Attach the ZIP to an AI image service that accepts archives, or attach the images in originals/ and paste request.txt. Ask it to create the sheet.\r\n\r\n',
    `The request asks for ${preset.views} distinct labelled views of the same ${preset.subject} on a pure white background in one image. No selection masks or hand-written prompt are required.\r\n\r\n`,
    'This ZIP is a request and its reference files, NOT a generated sheet image. Image generation is performed by your chosen service.\r\n\r\n',
    'Original PNG/JPEG/WebP image payloads are preserved byte-for-byte in originals/. sheet.json records their original filenames, IDs, dimensions, MIME types, byte lengths and SHA-256 checksums. Only the selected subject photos and sheet detail references are included. Repeated originals share a file.\r\n\r\n',
    'generated-previews/ contains separate annotated photo guides. Match each guide to its original using photoId and originalPath in sheet.json. Circles, highlights and text identify the selected subject or detail; they must not appear in the finished artwork. Sheet photo notes and visible annotation text are included in request.txt.\r\n\r\n',
    'Keep your saved .asun project to revise the preset and references later. This request pack does not replace the editable project file.\r\n',
  ], {type:'text/plain;charset=utf-8'})});
  return {blob:await zipFiles(files), filename:`${safeName(project.name, 'Asun IMG')} - Character item sheet.zip`, files, mapping, request, assets};
}

function sheetHTML(sheet) {
  const images = [...sheet.mainImages,...sheet.sheetReferences];
  const photos = images.map(record=>{
    const title=record.role==='main'?'Main subject photo':record.role==='subject'?'Additional subject photo':'Detail reference',guide=sheet.generatedPreviews.find(preview=>preview.photoId===record.photoId);
    return `<figure><a href="${escape(record.path)}"><img src="${escape(record.path)}" alt="${title}"></a><figcaption><strong>${title}</strong><br><a href="${escape(record.path)}">${escape(record.originalFilename)}</a><br>${record.width} × ${record.height} · ${record.mimeType}${record.notes?`<p>${escape(record.notes)}</p>`:''}${guide?`<p>Annotation guide</p><a href="${escape(guide.path)}"><img src="${escape(guide.path)}" alt="Annotation guide for ${escape(record.originalFilename)}"></a>`:''}</figcaption></figure>`;
  }).join('');
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src 'self' file:; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'"><title>${escape(sheet.project.name)} — Character / item sheet</title><style>body{font:16px/1.55 system-ui,sans-serif;color:#292025;background:#fff;max-width:1050px;margin:auto;padding:32px}h1,h2{line-height:1.2}.badge{background:#ffede0;border-radius:100px;padding:8px 16px;display:inline-block}.photos{display:grid;grid-template-columns:repeat(auto-fit,minmax(min(100%,240px),1fr));gap:24px}figure{margin:0;border:1px solid #eaded6;border-radius:16px;padding:16px}img{width:100%;height:260px;object-fit:contain}figcaption,p,pre{overflow-wrap:anywhere}pre{white-space:pre-wrap;font:inherit;background:#fff8f2;border-radius:16px;padding:24px}a{color:#8d3d1b}nav{display:flex;flex-wrap:wrap;gap:16px}@media(max-width:500px){body{padding:18px}pre{padding:16px}}</style></head><body><h1>Character / item sheet</h1><p>${escape(sheet.project.name)}</p><p class="badge">${sheet.preset.views} distinct views · White background · One image</p><p>This is the saved creation request and its references. No generated sheet is included.</p><nav><a href="request.txt">Copyable request</a><a href="sheet.json">Settings and file checksums</a><a href="README.txt">How to use this pack</a></nav><h2>Required views</h2><p>${sheet.angles.map(escape).join(' · ')}</p><h2>Selected source photos</h2><div class="photos">${photos}</div><h2>Ready-to-use request</h2><pre>${escape(sheet.request.prompt)}</pre></body></html>`;
}
