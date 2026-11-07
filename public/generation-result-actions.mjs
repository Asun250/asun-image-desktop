import {newProject,addRaster,parseProject} from './core.mjs';
import {originalBlob,readOriginalImage} from './image-source.mjs';
import {generationAPI,generationJSON} from './generation-details.mjs';

const requestId=/^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;
export const missingSourceMessage='This older result has no saved editable setup. Open its saved .asun project to reuse the original areas and references. You can still edit the output image.';

export async function loadGenerationRecord(id,{kind='image',fetchImpl=globalThis.fetch,signal}={}) {
  if(!requestId.test(id||''))throw new Error('Choose a saved generation from History.');
  const api=generationAPI(kind),status=await generationJSON(fetchImpl,api.endpoint+'/status',{signal});
  return generationJSON(fetchImpl,api.endpoint+'/jobs/'+encodeURIComponent(id),{signal,headers:{[api.tokenHeader]:status.token||''}});
}
export async function loadGenerationProject(record,{kind='image',fetchImpl=globalThis.fetch,signal}={}) {
  if(!requestId.test(record?.id||''))throw new Error('This result has no saved request ID.');
  if(record.sourceProjectAvailable===false)throw new Error(record.sourceProjectMessage||missingSourceMessage);
  const api=generationAPI(kind),status=await generationJSON(fetchImpl,api.endpoint+'/status',{signal});
  const saved=await generationJSON(fetchImpl,api.endpoint+'/jobs/'+encodeURIComponent(record.id)+'/project',{signal,headers:{[api.tokenHeader]:status.token||''}});
  if(!saved?.project)throw new Error('The saved edit setup is unavailable. Your current project has not changed.');
  return parseProject(JSON.stringify(saved.project));
}
export async function buildOutputProject(image) {
  if(!image?.source)throw new Error('The generated image is not available.');
  const blob=originalBlob(image),name=image.name||'Generated image.png';
  const asset=await readOriginalImage(new File([blob],name,{type:blob.type}));
  const base=newProject(asset.width,asset.height,name.replace(/\.[^.]+$/,'')+' - edit');
  // Old masks belong to the source photograph, not the newly generated pixels.
  // The exact old setup remains separately available through Redo.
  return addRaster(base,asset,{fitDocument:true}).project;
}
