// Server-side validation for normal image generation. This module does not make
// network calls: all malformed/oversized requests fail before provider billing.
import {createHash} from 'node:crypto';
import {SHEET_MODELS, originalImagePayload} from './desktop-sheet-service.mjs';
import {validateGenerationQuality,validateGenerationComplexity} from './public/generation-settings.mjs';
import {getBlockoutReview,blockoutGenerationInstructions} from './public/blockout-review-settings.mjs';
import {resolveImageOutput} from './public/image-output-settings.mjs';
import {imageGenerationInputOrder} from './public/image-generation-input-order.mjs';
import {applyGenerationInputPacking,packingPromptRoles,PACKED_INPUT_INSTRUCTIONS} from './desktop-input-packing.mjs';
import {imageGenerationPlan, imageGenerationPreviewDimensions, imageGenerationCanvasDimensions, buildImageGenerationPrompt, IMAGE_GENERATION_MAX_BYTES} from './public/image-generation-request.mjs';

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const need = (condition, message) => {if (!condition) throw Object.assign(new Error(message), {statusCode:400});};
const hash = bytes => createHash('sha256').update(bytes).digest('hex');

function expectedPreview(image, width, height, description, dimensions=null) {
  need(image && typeof image === 'object' && !Array.isArray(image), `${description} is missing. Rebuild the request from the current canvas.`);
  const info = originalImagePayload(image), expected = dimensions||imageGenerationPreviewDimensions(width, height);
  need(info.mimeType === 'image/png' && info.width === expected.width && info.height === expected.height, `${description} does not match the current canvas dimensions. Rebuild the request.`);
  return info;
}

export function prepareImageRequest({requestId, project, model, quality, complexity, composition = null, guide = null, referencePreviews = [], areaMasks = [], inputBoards = []} = {}) {
  need(typeof requestId === 'string' && uuid.test(requestId), 'Choose a valid image request ID.');
  need(SHEET_MODELS.some(entry => entry.id === model), 'Choose a supported image model.');
  quality = validateGenerationQuality(model, quality);
  complexity = validateGenerationComplexity(model, complexity);
  const plan=imageGenerationPlan(project),reviewSettings=getBlockoutReview(project);
  // Reject unsupported exact edit pixels before decoding or packing uploads.
  const output=resolveImageOutput(plan.project,model),canvasDimensions=imageGenerationCanvasDimensions(plan.project);
  const readPreview=(image,width,height,description)=>expectedPreview(image,width,height,description,description==='The reference annotation guide'?null:canvasDimensions);
  const logical=imageGenerationInputOrder(plan,{composition,guide,referencePreviews,areaMasks},{readOriginal:originalImagePayload,readPreview,identity:image=>image.sha256});
  need(logical.images.reduce((sum,image)=>sum+image.byteLength,0)<=IMAGE_GENERATION_MAX_BYTES,'Use input images totaling no more than 64 MB, including composition, guides, masks and references.');
  const packed=applyGenerationInputPacking(logical.images,logical.roles,inputBoards,originalImagePayload,IMAGE_GENERATION_MAX_BYTES);
  const {images,roles}=packed;let review=logical.review,structure=logical.structure;
  if(review)review={...review,sourceIndex:images.findIndex(image=>image.sha256===review.source.sha256)+1};
  need(!review||review.sourceIndex>0,'The original blockout must remain a standalone input. Rebuild the request.');
  if(structure)structure={...structure,sourceIndex:images.findIndex(image=>image.sha256===structure.source.sha256)+1};
  need(!structure||structure.sourceIndex>0,'The scene MAIN must remain a standalone input. Rebuild the request.');
  const prompt=buildImageGenerationPrompt(plan.project,packed.inputPacking?packingPromptRoles(roles):roles,{compact:Boolean(packed.inputPacking),output})
    +(packed.inputPacking?'\n\n'+PACKED_INPUT_INSTRUCTIONS:'')+(review?'\n\n'+blockoutGenerationInstructions(review,review.sourceIndex):'')
    +(structure?'\n\nSCENE CONSISTENCY MAIN: Input '+structure.sourceIndex+' is the user-selected original MAIN. It controls camera, framing, object geometry, orientation and overlap. Retain its exact aspect ratio. It has priority over all appearance and previous-frame references.':'');
  need(prompt.length <= 32000, 'Shorten the prompt, area instructions or reference notes to fit the image model prompt limit.');
  const size=output.size;
  return {id:requestId.toLowerCase(), model, quality, ...(complexity===undefined?{}:{complexity}), prompt, images, inputRoles:roles, sourceName:project.name || 'Asun image', mode:'image', size, outputFraming:output, ...(packed.inputPacking?{inputPacking:packed.inputPacking}:{}), ...(review ? {review} : {}),
    fingerprint:hash(JSON.stringify({mode:'image', model, quality, ...(complexity===undefined?{}:{complexity}), size, prompt, images:images.map(image => image.sha256), ...(packed.inputPacking?{logicalImages:logical.images.map(image=>image.sha256)}:{}), ...(review ? {review:{...reviewSettings,sourceSha256:review.source.sha256}} : {})}))};
}
