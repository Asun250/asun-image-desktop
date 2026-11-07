import {DEFAULT_IMAGE_ASPECT,IMAGE_OUTPUT_ASPECTS} from './image-output-settings.mjs';

export const IMAGE_ASPECT_PREFERENCE_KEY='asun.image.aspect-ratio.v1';
const valid=aspect=>IMAGE_OUTPUT_ASPECTS.includes(aspect)&&aspect!=='canvas';
const browserStorage=()=>{try{return globalThis.localStorage;}catch{return null;}};

/** Global preference only supplies projects that have no saved output choice. */
export function readImageAspectPreference(storage=browserStorage()) {
  try{const value=storage?.getItem(IMAGE_ASPECT_PREFERENCE_KEY);return valid(value)?value:DEFAULT_IMAGE_ASPECT;}
  catch{return DEFAULT_IMAGE_ASPECT;}
}
export function writeImageAspectPreference(aspect,storage=browserStorage()) {
  if(!valid(aspect))throw new Error('Choose a supported aspect ratio.');
  try{if(!storage)return false;storage.setItem(IMAGE_ASPECT_PREFERENCE_KEY,aspect);return true;}catch{return false;}
}

/** Apply only to an immutable generation snapshot, never during editor rendering. */
export function withImageAspectPreference(project) {
  return {...project,imageOutput:project.imageOutput?{...project.imageOutput}:{version:1,aspect:readImageAspectPreference()}};
}
