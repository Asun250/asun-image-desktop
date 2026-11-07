// Output dimensions are an API setting, separate from prompt text and previews.
// https://developers.openai.com/api/reference/resources/images/methods/edit
import {layerIntersectsCanvas} from './layer-transform.mjs';
import {isSketchProject,sketchContentLayers} from './sketch-project.mjs';

export const IMAGE_OUTPUT_ASPECTS = Object.freeze(['source','9:16','16:9','2:3','3:2','1:1']);
export const DEFAULT_IMAGE_ASPECT = '9:16';
const need=(value,message)=>{if(!value)throw Object.assign(new Error(message),{statusCode:400});};
const customSizes=model=>/^gpt-image-(?:2(?:-2026-04-21)?|2\.5-(?:sunburst|flare)(?:-2026-09-08)?)$/.test(model);
// As of 2026-11-04, Images API docs guarantee the standard sizes for GPT
// image models but enumerate only 2/2.5 for custom sizes. Do not infer 2.6
// custom-size support from a sibling or silently replace a remembered 9:16.
const standardSizes=model=>['gpt-image-1.5','gpt-image-1-mini','gpt-image-2.6-sunburst','gpt-image-2.6-flare'].includes(model);
const unverifiedCustomSizes=model=>/^gpt-image-2\.6-(?:sunburst|flare)$/.test(model);
const gcd=(a,b)=>b?gcd(b,a%b):a;
export function imageAspectRatio(width,height){if(!Number.isInteger(width)||!Number.isInteger(height)||width<1||height<1)return null;const divisor=gcd(width,height);return `${width/divisor}:${height/divisor}`;}
export function supportedImageAspects(model){return customSizes(model)?IMAGE_OUTPUT_ASPECTS.filter(value=>value!=='source'):standardSizes(model)?['2:3','3:2','1:1']:[];}
function requireSupportedModel(model){need(customSizes(model)||standardSizes(model),model==='gpt-image-1'?'GPT Image 1 is retired. Choose an available image model; no replacement was selected.':'Output-size support has not been verified for this model. Choose a supported image model.');}

const visible=(project,layer)=>Boolean(layer?.visible&&layer.opacity>0&&layerIntersectsCanvas(layer,project));
/** A pixel selection is an edit on the current canvas, not a new composition. */
export function isSelectedAreaEdit(project){
  if(isSketchProject(project))return false;
  return (project.layers||[]).some(layer=>layer.kind==='text'&&layer.objectRegion&&visible(project,layer)&&visible(project,project.layers.find(item=>item.id===layer.objectRegion.rasterLayerId&&item.kind==='raster')));
}

/** Exact native pixels are required for selected-area edits; no implicit resizing. */
export function validateImageOutputPixels(model,width,height){
  requireSupportedModel(model);
  need(Number.isInteger(width)&&Number.isInteger(height)&&width>0&&height>0,'The edit canvas has invalid dimensions.');
  const size=`${width}x${height}`;
  if(standardSizes(model))need(['1024x1024','1024x1536','1536x1024'].includes(size),unverifiedCustomSizes(model)?`The ${width} × ${height} edit canvas is outside GPT Image 2.6's verified sizes. Custom-size support is not yet confirmed in the API size documentation. Verified sizes: 1024 × 1536 (2:3 portrait), 1536 × 1024 (3:2 landscape), or 1024 × 1024 (1:1). Keep GPT Image 2.5 for custom-size edits, or choose a documented canvas size yourself; your image and mask have not been resized.`:`This model cannot preserve the ${width} × ${height} edit canvas exactly. It supports 1024 × 1536 (2:3 portrait), 1536 × 1024 (3:2 landscape), or 1024 × 1024 (1:1). Choose a supported canvas size yourself before generating; your image and mask have not been resized.`);
  else {
    need(width%16===0&&height%16===0,`This model cannot preserve the ${width} × ${height} edit canvas exactly: both dimensions must be multiples of 16. Choose a supported canvas size yourself; no rounding, crop, padding or stretch was applied.`);
    need(Math.max(width,height)<=3840&&width/height>=1/3&&width/height<=3&&width*height>=655360&&width*height<=8294400,`This model cannot preserve the ${width} × ${height} edit canvas exactly. Each side must be at most 3840 px, aspect 1:3 to 3:1, and total pixels 655,360 to 8,294,400. Choose a supported canvas size yourself; your image and mask have not been resized.`);
  }
  return size;
}

export function validateImageOutput(project) {
  if(!Object.hasOwn(project,'imageOutput'))return {version:1,aspect:DEFAULT_IMAGE_ASPECT};
  const value=project.imageOutput;
  need(value&&typeof value==='object'&&!Array.isArray(value)&&value.version===1&&IMAGE_OUTPUT_ASPECTS.includes(value.aspect),'Choose a supported image output shape.');
  return value;
}

export function exactImageOutputSize(model,width,height) {
  requireSupportedModel(model);
  need(Number.isInteger(width)&&Number.isInteger(height)&&width>0&&height>0,'The output framing source has invalid dimensions.');
  if(!customSizes(model)) {
    if(width===height)return '1024x1024';
    if(width*2===height*3)return '1536x1024';
    if(width*3===height*2)return '1024x1536';
    throw Object.assign(new Error(unverifiedCustomSizes(model)?'Custom aspect ratios, including exact 9:16, are not yet confirmed for GPT Image 2.6 in the API size documentation. Verified sizes: 1024 × 1536 (2:3 portrait), 1536 × 1024 (3:2 landscape), and 1024 × 1024 (1:1). Choose one explicitly, or use GPT Image 2.5 for exact 9:16. Your preferred ratio is kept; no size was substituted.':'This model cannot keep this exact aspect ratio. Its supported portrait size is 1024 × 1536 (2:3); square is 1024 × 1024 and landscape is 1536 × 1024. Choose a supported output shape or GPT Image 2.5 Sunburst, GPT Image 2.5 Flare or GPT Image 2. No size was substituted.'),{statusCode:400});
  }
  need(width/height>=1/3&&width/height<=3,'This model supports output shapes between 1:3 and 3:1. Choose another output shape; no crop or stretch was applied.');
  const divisor=gcd(width,height),unitW=width/divisor*16,unitH=height/divisor*16;
  const min=Math.max(1,Math.ceil(Math.sqrt(655360/(unitW*unitH))));
  const max=Math.min(Math.floor(3840/Math.max(unitW,unitH)),Math.floor(Math.sqrt(8294400/(unitW*unitH))));
  need(min<=max,'This source’s exact aspect ratio cannot fit the supported pixel sizes. Portrait options include 864 × 1536 (9:16) and 1024 × 1536 (2:3). Choose an output shape explicitly; no size was substituted.');
  const target=width===height?1024:1536,multiple=Math.max(min,Math.min(max,Math.round(target/Math.max(unitW,unitH))));
  return `${unitW*multiple}x${unitH*multiple}`;
}

/** Match the real composition, or first global reference when the canvas is empty. */
export function resolveImageOutput(project,model,{preferredAspect=DEFAULT_IMAGE_ASPECT}={}) {
  const choice=Object.hasOwn(project,'imageOutput')?validateImageOutput(project):validateImageOutput({imageOutput:{version:1,aspect:preferredAspect}}),scene=project.sceneConsistency,review=project.blockoutReview;
  const locked=scene?.enabled?{id:scene.mainAssetId,kind:'main'}:review?.enabled?{id:review.assetId,kind:'blockout'}:null;
  if(isSelectedAreaEdit(project)){
    const width=project.width,height=project.height,size=validateImageOutputPixels(model,width,height);
    const original=locked?project.assets?.[locked.id]:null;
    need(!locked||original,'The selected original MAIN or blockout is missing.');
    need(!original||original.width*height===original.height*width,'The edit canvas aspect conflicts with the locked original MAIN / blockout. Restore that canvas framing or change the lock explicitly; no resizing was applied.');
    return {version:1,size,width,height,aspect:'canvas',ratio:imageAspectRatio(width,height),source:'edit-canvas',sourceName:'Selected-area edit canvas',sourceWidth:width,sourceHeight:height,experimental:width*height>3686400};
  }
  let source='canvas',sourceName='Working canvas',original={width:project.width,height:project.height};
  if(locked) {
    original=project.assets?.[locked.id];need(original,'The selected original MAIN or blockout is missing. Choose it again before generating.');
    source=locked.kind;sourceName=original.name||'Original MAIN / blockout';
  } else {
    const layers=isSketchProject(project)?sketchContentLayers(project):(project.layers||[]).filter(layer=>layer.kind==='raster');
    const hasComposition=layers.some(layer=>layer.visible&&layer.opacity>0&&layerIntersectsCanvas(layer,project));
    if(!hasComposition) {
      const linked=new Set((project.layers||[]).flatMap(layer=>layer.referenceIds||[layer.referenceId].filter(Boolean)));
      const reference=(project.references||[]).find(item=>!linked.has(item.id));
      if(reference){source='reference';sourceName=reference.name||'First reference';original=reference;}
    }
  }
  const sourceWidth=original.width,sourceHeight=original.height;
  let width=sourceWidth,height=sourceHeight;
  if(choice.aspect!=='source') {
    [width,height]=choice.aspect.split(':').map(Number);
    need(!locked||width*sourceHeight===height*sourceWidth,'The chosen output shape conflicts with the locked MAIN / blockout. Choose Match source to preserve its exact framing, or change the lock explicitly. No request was sent.');
    source='preset';
  }
  const size=exactImageOutputSize(model,width,height),[outputWidth,outputHeight]=size.split('x').map(Number),divisor=gcd(outputWidth,outputHeight);
  return {version:1,size,width:outputWidth,height:outputHeight,aspect:choice.aspect,ratio:`${outputWidth/divisor}:${outputHeight/divisor}`,source,sourceName,sourceWidth,sourceHeight,experimental:outputWidth*outputHeight>3686400};
}

export function imageOutputInstructions(output) {
  return `OUTPUT FRAME: Generate exactly ${output.width} × ${output.height} pixels (${output.ratio}). This is the requested API output size. ${output.source==='reference'?'The first global reference supplies the output aspect ratio; the unused working canvas does not control framing. ':''}Preserve the intended full composition and camera framing. Do not crop, stretch, letterbox or add borders to force the aspect ratio. All reference images retain their original proportions.`;
}

/** Verify encoded output pixels, never a preview or provider metadata claim. */
export function checkImageOutputSize(size,image) {
  const match=/^(\d+)x(\d+)$/.exec(size||'');if(!match)return null;
  if(!Number.isInteger(image?.width)||!Number.isInteger(image?.height)||image.width<1||image.height<1)return null;
  const width=Number(match[1]),height=Number(match[2]),matches=image.width===width&&image.height===height;
  const requestedRatio=imageAspectRatio(width,height),actualRatio=imageAspectRatio(image.width,image.height),aspectMatches=width*image.height===height*image.width;
  // All requests use legal exact pixel dimensions. The current API documents
  // multiples-of-16 inputs, not an output-rounding allowance; do not invent one.
  return {requestedWidth:width,requestedHeight:height,actualWidth:image.width,actualHeight:image.height,requestedRatio,actualRatio,aspectMatches,matches,roundingAllowancePx:0,
    message:matches?`Verified saved image: ${width} × ${height} pixels (${actualRatio}).`:`Output size mismatch: requested ${width} × ${height} (${requestedRatio}), but the provider returned ${image.width} × ${image.height} (${actualRatio}). ${aspectMatches?'The aspect ratio matches, but the pixel dimensions differ. ':''}The original output is saved unchanged; it was not cropped or stretched. No automatic retry was made.`};
}
