// Explicit, project-local geometry authority. Never infer it from an output or
// an appearance reference, and never change the image model/quality settings.
export const BLOCKOUT_REVIEW_MODEL = 'gpt-6-astra';
export const BLOCKOUT_REVIEW_EFFORT = 'max';
export const BLOCKOUT_REVIEW_ATTEMPTS = 3;
export const BLOCKOUT_GEOMETRY_AUTHORITY = 'Geometry changes are allowed only when listed in the explicit blockout exceptions. Treat conflicting geometry requests elsewhere as constrained by the blockout lock. Do not reinterpret a material or realism request as permission to move or resize the scene.';
const need = (condition, message) => {if (!condition) throw new Error(message);};

export function validateBlockoutReview(project) {
  if (!Object.hasOwn(project, 'blockoutReview')) return null;
  const review = project.blockoutReview;
  need(review && typeof review === 'object' && !Array.isArray(review) && review.version === 1, 'Invalid blockout review settings.');
  need(typeof review.enabled === 'boolean', 'Choose whether to review against a blockout.');
  need(review.model === BLOCKOUT_REVIEW_MODEL && review.effort === BLOCKOUT_REVIEW_EFFORT, 'Blockout review requires GPT-6 Astra with Max reasoning. Unsupported reviewer settings are not replaced.');
  need(Number.isInteger(review.maxAttempts) && review.maxAttempts >= 1 && review.maxAttempts <= BLOCKOUT_REVIEW_ATTEMPTS, 'Choose between 1 and 3 total generation attempts.');
  need(typeof review.authorizedChanges === 'string' && review.authorizedChanges.length <= 2000, 'Blockout exceptions must be text up to 2000 characters.');
  need(typeof review.assetId === 'string' && review.assetId.length <= 200, 'Choose an original blockout image.');
  if (review.enabled) need(Boolean(project.assets?.[review.assetId]), 'The selected blockout image is missing. Choose its original again before generating.');
  return review;
}

export function getBlockoutReview(project) {
  return validateBlockoutReview(project) || {version:1, enabled:false, model:BLOCKOUT_REVIEW_MODEL,
    effort:BLOCKOUT_REVIEW_EFFORT, maxAttempts:BLOCKOUT_REVIEW_ATTEMPTS, assetId:'', authorizedChanges:''};
}

// Exact aspect preservation, without stretching, cropping or silently rounding.
// https://developers.openai.com/api/reference/resources/images/methods/edit
export function blockoutOutputSize(model,width,height) {
  need(Number.isInteger(width)&&Number.isInteger(height)&&width>0&&height>0,'The original blockout dimensions are invalid.');
  const ratio=width/height;
  if(!['gpt-image-2','gpt-image-2.5-sunburst','gpt-image-2.5-flare'].includes(model)) {
    if(width===height)return '1024x1024';
    if(width*2===height*3)return '1536x1024';
    if(width*3===height*2)return '1024x1536';
    throw new Error(/^gpt-image-2\.6-(?:sunburst|flare)$/.test(model)?'This blockout ratio is outside GPT Image 2.6’s documented sizes (1:1, 2:3, 3:2). Custom ratios are not yet verified for 2.6. Use GPT Image 2.5 for this exact framing; no request was sent.':'This image model cannot keep the blockout’s exact aspect ratio. Choose GPT Image 2.5 Sunburst, GPT Image 2.5 Flare or GPT Image 2, or turn off blockout review. No request was sent.');
  }
  need(ratio>=1/3&&ratio<=3,'Blockout review needs an image aspect ratio between 1:3 and 3:1. Export the Blender camera at a supported aspect ratio first. No request was sent.');
  const gcd=(a,b)=>b?gcd(b,a%b):a,divisor=gcd(width,height),unitW=width/divisor*16,unitH=height/divisor*16;
  const min=Math.max(1,Math.ceil(Math.sqrt(655360/(unitW*unitH)))),max=Math.min(Math.floor(3840/Math.max(unitW,unitH)),Math.floor(Math.sqrt(8294400/(unitW*unitH))));
  need(min<=max,'The blockout’s exact aspect ratio cannot fit the image API’s supported dimensions. Export the Blender camera at a standard ratio such as 16:9, 3:2 or 1:1, or turn off blockout review. No request was sent.');
  const target=width===height?1024:1536,multiple=Math.max(min,Math.min(max,Math.round(target/Math.max(unitW,unitH))));
  return `${unitW*multiple}x${unitH*multiple}`;
}

export function blockoutGenerationInstructions(review, sourceIndex) {
  return [
    'BLOCKOUT STRUCTURE LOCK — independent visual review is enabled.',
    `Input ${sourceIndex} is the explicitly selected ORIGINAL BLENDER BLOCKOUT. It is the authority for camera/viewpoint, framing, aspect, object placement, relative size, orientation, pose, depth ordering and occlusion. It takes precedence over the edited composition and appearance references for these constraints.`,
    'Use all mapped appearance references and numbered area instructions for identity, materials and finish. Their camera, catalog layout or background must not replace the blockout. Preserve unnumbered scene structure and do not add unrequested objects. Remove guide marks from the result.',
    BLOCKOUT_GEOMETRY_AUTHORITY,
    'Explicit authorized blockout exceptions:\n' + (review.authorizedChanges.trim() || '(None — retain the original visible structure.)'),
    'This is a raster visual matching task. Do not claim to have measured exact world dimensions or recovered exact Blender camera parameters.',
  ].join('\n\n');
}
