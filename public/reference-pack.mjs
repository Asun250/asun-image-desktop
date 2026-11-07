import {validateProject,referenceLinks,labelComment,serializeProject} from './core.mjs';
import {referenceBoardPages,linkedReferences,linkedLabelComments,exportReferenceBoard} from './reference-board.mjs';
import {sourceFileInfo,originalBlob} from './image-source.mjs';
import {zipFiles,isWindowsReservedName} from './reference-download.mjs';
import {isSketchProject,sketchContentLayers} from './sketch-project.mjs';
import {exportImage} from './render.mjs';
import {PACK_AGENT_INSTRUCTIONS,referencePackWorkflow,referencePackAgentInstructions} from './reference-pack-workflow.mjs';
import {getSceneConsistency,sceneConsistencyInstructions,sceneConsistencyPreflight} from './scene-consistency.mjs';
import {renderSelectionMask} from './selection-mask-export.mjs';

const extensions={'image/png':'.png','image/jpeg':'.jpg','image/webp':'.webp'};
const key=value=>value.normalize('NFC').toUpperCase();
function truncate(value,length){let text=value.slice(0,length);if(/[\uD800-\uDBFF]$/.test(text))text=text.slice(0,-1);return text;}
export function safePackSegment(value,fallback='photo'){
  let text=String(value??'').toWellFormed().normalize('NFC').replace(/[<>:"/\\|?*\x00-\x1f\x7f-\x9f]/g,'_').trim().replace(/[. ]+$/,'');
  if(!text||text==='.'||text==='..')text=fallback;
  if(isWindowsReservedName(text))text='_'+text;
  return truncate(text,120).replace(/[. ]+$/,'')||fallback;
}
function allocator(reserved=[]){const used=new Set(reserved.map(key));return (base,extension='')=>{let value=base+extension,count=2;while(used.has(key(value)))value=`${base}-${count++}${extension}`;used.add(key(value));return value;};}
function filename(info,fallback,allocate){const extension=extensions[info.mimeType];if(!extension)throw new Error('A pack original must be a PNG, JPEG or WebP image.');const stem=String(info.name).replace(/\.[^.]*$/,'');return allocate(safePackSegment(stem,fallback),extension);}
async function hash(blob){const bytes=await blob.arrayBuffer();return [...new Uint8Array(await crypto.subtle.digest('SHA-256',bytes))].map(value=>value.toString(16).padStart(2,'0')).join('');}
const visible= (project,layer)=>layer.kind==='text'&&layer.visible&&layer.opacity>0&&layer.x<project.width&&layer.y<project.height&&layer.x+layer.width>0&&layer.y+layer.height>0;
async function originalRecord(image,identity){const info=sourceFileInfo(image),blob=originalBlob(image);return {info,blob,record:{...identity,originalFilename:info.name,width:image.width,height:image.height,mimeType:info.mimeType,byteLength:blob.size,sha256:await hash(blob)}};}

// Every originals/ entry comes directly from its preserved source data URL.
// Board rendering is confined to generated-previews/ and never feeds originals.
export async function completeReferencePackFiles(project){
  validateProject(project);
  const consistency=getSceneConsistency(project),preflight=sceneConsistencyPreflight(project);
  if(preflight.errors.length)throw new Error(preflight.errors.join(' '));
  const cleanAsset=project.original&&project.assets[project.original.assetId];
  if(!cleanAsset)throw new Error('Import a main image before exporting a Complete reference pack.');
  const groups=linkedReferences(project),comments=linkedLabelComments(project);
  if(!groups.length&&!comments.length&&!consistency.enabled)throw new Error('Link a visible number to a reference photo or add an instruction before exporting a Complete reference pack.');
  const layouts=groups.length||comments.length?referenceBoardPages(project):[]; // Includes the board's label ambiguity validation.
  const mapping={format:'asun-complete-reference-pack',version:1,project:{name:project.name,width:project.width,height:project.height,prompt:project.prompt},generatedPreviews:[],cleanMain:null,mainImages:[],numbers:[],unassignedReferences:[]};
  if(project.sceneConsistency)mapping.sceneConsistency=structuredClone(project.sceneConsistency);
  if(consistency.enabled){mapping.sceneConsistencyInstructions=sceneConsistencyInstructions(project);mapping.sceneConsistencyPreflight=preflight;}
  const files=[],mainNames=allocator(),folderNames=allocator(['unassigned']),references=new Map(),numberGroups=new Map();
  const assetIds=[project.original.assetId,...Object.keys(project.assets).filter(id=>id!==project.original.assetId)];
  for(const assetId of assetIds){const image=project.assets[assetId],item=await originalRecord(image,{assetId}),path='originals/main/'+filename(item.info,'main',mainNames),record={...item.record,path};files.push({name:path,blob:item.blob});mapping.mainImages.push(record);if(assetId===project.original.assetId)mapping.cleanMain=record;}
  for(const ref of project.references)references.set(ref.id,await originalRecord(ref,{referenceId:ref.id,notes:ref.notes||''}));
  for(const layer of project.layers){if(!visible(project,layer))continue;const ids=referenceLinks(layer),rawComment=labelComment(layer),comment=rawComment.trim()?rawComment:'';if(!ids.length&&!comment&&!(consistency.enabled&&(layer.objectRegion||consistency.groups.some(group=>group.label.trim()===layer.text.content.trim()))))continue;const label=layer.text.content.trim();let number=numberGroups.get(label);if(!number){number={label,literalLabels:[],layerIds:[],comment,directory:'originals/references/'+folderNames(safePackSegment(label,'label')),references:[],ids};numberGroups.set(label,number);}if(!number.literalLabels.includes(layer.text.content))number.literalLabels.push(layer.text.content);number.layerIds.push(layer.id);if(layer.objectRegion){number.selections ||= [];number.selections.push({layerId:layer.id,...structuredClone(layer.objectRegion)});}}
  const assigned=new Set();
  for(const number of numberGroups.values()){const names=allocator();for(const referenceId of number.ids){const item=references.get(referenceId);if(!item)throw new Error('A linked original reference photo is unavailable.');const path=number.directory+'/'+filename(item.info,'reference',names),record={...item.record,path};number.references.push(record);files.push({name:path,blob:item.blob});assigned.add(referenceId);}delete number.ids;mapping.numbers.push(number);}
  const unassignedNames=allocator();for(const referenceId of references.keys()){if(assigned.has(referenceId))continue;const item=references.get(referenceId),path='originals/references/unassigned/'+filename(item.info,'reference',unassignedNames),record={...item.record,path};mapping.unassignedReferences.push(record);files.push({name:path,blob:item.blob});}
  if(consistency.enabled){
    const maskNames=allocator();mapping.selectionMasks=[];
    for(const number of mapping.numbers)for(const layerId of number.layerIds){
      const layer=project.layers.find(item=>item.id===layerId);if(!layer?.objectRegion)continue;
      const canvas=renderSelectionMask(project,layer),blob=await new Promise((resolve,reject)=>canvas.toBlob(value=>value?resolve(value):reject(new Error('Could not export the selection mask.')),'image/png'));
      const path='selection-masks/'+maskNames(safePackSegment(number.label+'-'+layerId,'selection'),'.png');
      files.push({name:path,blob});mapping.selectionMasks.push({path,label:number.label,layerId,width:canvas.width,height:canvas.height,canvasWidth:project.width,canvasHeight:project.height,sha256:await hash(blob),meaning:'WHITE selects; BLACK excludes. Full current-canvas coordinates, not a crop or an individual-object count. May be scaled; fit to the current canvas before compositing.'});
    }
    mapping.continuityReferences=[...mapping.numbers.flatMap(number=>number.references),...mapping.unassignedReferences].filter(reference=>consistency.continuity.referenceIds.includes(reference.referenceId));
    for(const reference of mapping.continuityReferences){reference.role='previous frame continuity reference';reference.scope='Appearance continuity only; current MAIN controls geometry. This reference is not an area identity replacement.';}
    files.push({name:'SCENE-CONSISTENCY.txt',blob:new Blob([mapping.sceneConsistencyInstructions+'\n\nSetup warnings:\n'+(preflight.warnings.join('\n')||'None.')+'\n\nSelection masks are guidance and compositing aids. A mask does not guarantee that a generated image preserves pixels outside it. Original images remain untouched.'],{type:'text/plain;charset=utf-8'})});
  }
  for(const layout of layouts){const blob=await exportReferenceBoard(project,layout.page),name=layouts.length===1?'numbered-reference-board.png':`numbered-reference-board-page-${String(layout.pageNumber).padStart(2,'0')}.png`,path='generated-previews/'+name;files.push({name:path,blob});mapping.generatedPreviews.push({path,pageNumber:layout.pageNumber,pageCount:layout.pageCount,width:layout.width,height:layout.height,mimeType:'image/png',byteLength:blob.size,sha256:await hash(blob)});}
  if(consistency.enabled&&!layouts.length){
    const blob=await exportImage(project,'png'),path='generated-previews/canvas-annotation-guide.png';files.push({name:path,blob});mapping.generatedPreviews.push({path,role:'canvas annotation guide — not original MAIN',width:project.width,height:project.height,mimeType:'image/png',byteLength:blob.size,sha256:await hash(blob)});
  }
  if(isSketchProject(project)){
    const blob=await exportImage({...project,layers:sketchContentLayers(project)},'png'),path='generated-previews/sketch-composition.png';
    const composition={path,role:'drawn scene composition',width:project.width,height:project.height,mimeType:'image/png',byteLength:blob.size,sha256:await hash(blob)};
    files.push({name:path,blob});mapping.generatedPreviews.push(composition);
    const editablePath='editable-sketch.asun';
    files.push({name:editablePath,blob:new Blob([serializeProject(project)],{type:'application/json'})});
    mapping.sketch={composition,editableProject:editablePath,background:project.sketch.background,instruction:'Use the clean sketch composition for scene layout and drawn subjects. The preserved surface image is blank drawing paper. Numbered boards and highlights are separate editing instructions.'};
  }
  mapping.agentWorkflow=referencePackWorkflow(project,mapping);
  files.unshift({name:PACK_AGENT_INSTRUCTIONS,blob:new Blob([referencePackAgentInstructions(mapping)],{type:'text/plain;charset=utf-8'})});
  files.push({name:'mapping.json',blob:new Blob([JSON.stringify(mapping,null,2)+'\n'],{type:'application/json'})});
  files.push({name:'README.txt',blob:new Blob([readme(mapping)],{type:'text/plain;charset=utf-8'})});
  return {files,mapping};
}
export async function exportCompleteReferencePack(project){const {files}=await completeReferencePackFiles(project);return zipFiles(files);}
function readme(mapping){
  const lines=['ASUN COMPLETE REFERENCE PACK','',`Project: ${mapping.project.name}`,'',`START WITH ${PACK_AGENT_INSTRUCTIONS}: generate the scene, have a separate GPT-6 Astra Max agent review it, and correct evidenced mismatches within the recorded attempt limit.`,'This is a requested workflow, not an executed review. The receiving agent must read and run the instructions. Exporting this ZIP does not generate an image or certify a match.','mapping.agentWorkflow records the reviewer, source selection, exceptions and retry limit. The preserved first MAIN below is not necessarily the selected review source.','The global scene prompt is preserved in mapping.project.prompt and included in START-HERE.txt. Numbered instructions and reference notes follow below.','',...(mapping.sketch?['DRAWN SCENE REFERENCE',`Scene composition: ${mapping.sketch.composition.path}`,`${mapping.sketch.composition.width} x ${mapping.sketch.composition.height} pixels. Pencil strokes and content describe the intended subjects, placement, poses, scale and framing. Develop the drawing into a finished scene using its numbered instructions and appearance references. The white surface is drawing paper, not a required final white background.`,`Editable source: ${mapping.sketch.editableProject}. Open it in Asun IMG to revise individual strokes, text, selections and linked references.`,'The original surface image below is blank drawing paper. It is NOT the scene composition. Use the sketch-composition image above for the scene; use numbered boards for area guidance.','']:[]),'generated-previews/ contains generated numbered boards showing the edited scene, photo annotations, notes and numbered instructions, plus the clean drawn composition when this is a sketch. These files are generated from editable project content; they are not original image files.','','originals/ contains byte-exact original PNG, JPEG and WebP payloads. Originals have never been re-encoded and contain no app-added edits, annotation overlays, masks, resizing or cropping. Their native dimensions and MIME types are recorded in mapping.json.','',`${mapping.sketch?'Preserved original surface':'Clean MAIN'}: ${mapping.cleanMain.path}`,`Native MAIN: ${mapping.cleanMain.width} x ${mapping.cleanMain.height}; ${mapping.cleanMain.mimeType}; ${mapping.cleanMain.byteLength} bytes.`,'The preserved original is the first main image, even if its layer was later resized, cropped or deleted. Other retained main image assets are also in originals/main/.','','NUMBERED REFERENCE PHOTOS AND INSTRUCTIONS'];
  for(const number of mapping.numbers){lines.push(`Label ${JSON.stringify(number.label)}: ${number.references.length?number.directory:'instruction only (no reference photos)'}`);for(const selection of number.selections||[])lines.push(`  Shared group: apply these references and instructions to all ${selection.group?.areaCount||1} selected areas. The full-image selection mask (including disconnected areas) is stored in mapping.json under selections; gaps between areas are not selected.`);if(number.comment?.trim())lines.push('  Instruction:',number.comment);for(const ref of number.references){lines.push(`  ${ref.path} — original filename ${JSON.stringify(ref.originalFilename)}; ${ref.width} x ${ref.height}; ${ref.mimeType}; reference ID ${ref.referenceId}`);if(ref.notes)lines.push(`  Notes: ${JSON.stringify(ref.notes)}`);}}
  lines.push('','Instructions apply to their matching visible numbered labels and do not require a reference photo.','Shared photos appear in each matching visible-label folder. Unlinked photos, including photos linked only to hidden or off-canvas labels, remain in originals/references/unassigned/.','Filename and folder sanitization can change names. mapping.json retains literal labels, full numbered comments, original filenames, asset/reference IDs, notes, full dimensions, MIME types, byte sizes and SHA-256 checksums.','Generated previews have their own paths and checksums, separate from originals.','');return lines.join('\r\n');
}
