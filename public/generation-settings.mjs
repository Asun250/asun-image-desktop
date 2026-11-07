// Shared by the desktop UI and server; explicit settings are never downgraded.
export const DEFAULT_GENERATION_QUALITY = 'high';
// GPT Image 2.6: planning effort is independent of rendering quality.
// https://developers.openai.com/api/docs/guides/image-generation#set-image-complexity
export const DEFAULT_GENERATION_COMPLEXITY = 'high';
const basic = Object.freeze(['auto','low','medium','high']);
const extended = Object.freeze([...basic,'xhigh','max']);
const complexityLevels = Object.freeze(['low','medium','high']);
const noComplexity = Object.freeze([]);
export function generationQualityOptions(model) {
  return /^gpt-image-(?:2\.5-(?:sunburst|flare)(?:-2026-09-08)?|2\.6-(?:sunburst|flare))$/.test(String(model || '')) ? extended : basic;
}
export function validateGenerationQuality(model, quality = DEFAULT_GENERATION_QUALITY) {
  if (typeof quality !== 'string' || !generationQualityOptions(model).includes(quality)) {
    throw Object.assign(new Error(`Choose a supported quality for this model: ${generationQualityOptions(model).join(', ')}.`), {statusCode:400});
  }
  return quality;
}

export function generationComplexityOptions(model) {
  return /^gpt-image-2\.6-(?:sunburst|flare)$/.test(String(model || '')) ? complexityLevels : noComplexity;
}
export function validateGenerationComplexity(model, complexity) {
  const choices = generationComplexityOptions(model);
  if (!choices.length) {
    if (complexity == null) return undefined;
    throw Object.assign(new Error('Complexity is not supported for this model. Choose GPT Image 2.6 Sunburst or Flare to use complexity.'), {statusCode:400});
  }
  const value = complexity ?? DEFAULT_GENERATION_COMPLEXITY;
  if (typeof value !== 'string' || !choices.includes(value)) {
    throw Object.assign(new Error('Choose a supported complexity: low, medium, high. No replacement was selected.'), {statusCode:400});
  }
  return value;
}
