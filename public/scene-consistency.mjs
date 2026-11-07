// Saved scene intent shared by the editor, generator, reviewer and portable ZIP.
// These are visible-image requirements, never measurements of Blender geometry.
export const SCENE_KINDS = Object.freeze(['car','card','text','architecture','prop','other']);
export const SCENE_DIRECTIONS = Object.freeze(['from-main','left','right','toward-camera','away-from-camera']);
export const SCENE_VIEWS = Object.freeze(['from-main','front','front-three-quarter','side','rear-three-quarter','top-rear-three-quarter','rear']);
export const SCENE_VISIBILITIES = Object.freeze(['from-main','full','partial','cropped']);
const RANKS = ['from-main','A','2','3','4','5','6','7','8','9','10','J','Q','K'];
const SUITS = ['from-main','clubs','diamonds','hearts','spades'];
const GLOBAL_FLAGS = ['preserveCardIdentity','preserveText','preservePartialObjects','noExtraObjects','sharpTraffic'];
const GROUP_FIELDS = ['label','kind','keepFromMain','borrowFromReference','ignoreFromReference','requestedChange','expectedObjectCount','referenceVariant'];
const OBJECT_FIELDS = ['id','label','name','kind','direction','view','cardRank','cardSuit','visibility','overlap','notes'];
const CONTINUITY_FIELDS = ['shot','frame','camera','previousFrame','referenceIds','changes'];
const SETTINGS_FIELDS = ['version','enabled','mainAssetId','global','groups','objects','continuity'];
const need = (condition,message) => { if (!condition) throw new Error(message); };
const record = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const exact = (value,fields) => record(value) && Object.keys(value).length === fields.length && fields.every(field=>Object.hasOwn(value,field));
const text = (value,limit=1000,nonempty=false) => typeof value === 'string' && value.length <= limit && (!nonempty || Boolean(value.trim()));
const clone = value => structuredClone(value);

function defaults() {
  return {version:1,enabled:false,mainAssetId:'',
    global:{preserveCardIdentity:true,preserveText:true,preservePartialObjects:true,noExtraObjects:true,sharpTraffic:true,notes:''},
    groups:[],objects:[],continuity:{shot:'',frame:'',camera:'',previousFrame:'',referenceIds:[],changes:''}};
}

/** Appearance presets describe borrowing limits; they do not invent objects. */
export function groupPreset(kind='other') {
  need(SCENE_KINDS.includes(kind),'Choose a supported scene object type.');
  const common = 'Camera-relative position, projected size, orientation, pose, count, spacing and overlap.';
  const presets = {
    car:[common+' Nose direction, roof and rear/front visibility, wheel contact points, and partially hidden vehicles.',
      'The mapped car model, paint, glass, tires, trim and realistic material detail.',
      'Reference camera angle, wheelbase framing, travel direction, background and catalog layout.'],
    card:[common+' Each individual card rank, suit, face/back visibility and printed symbols.',
      'Card stock, edge thickness, print finish and the specified back design only.',
      'The example card rank or suit, reference pose, arrangement and background.'],
    text:[common+' Exact wording, spelling, letter case, line breaks and letter layout.',
      'Letter material, bevel finish, surface color, lighting and neon treatment.',
      'Reference wording, extra letters, reference composition and background.'],
    architecture:[common+' Building silhouette, major forms, facade layout and architectural identity.',
      'Matching facade materials, window detail, masonry, metalwork and lighting.',
      'Reference viewpoint, different buildings, extra structures and changes to the skyline.'],
    prop:[common+' The identity and visible parts of each prop.',
      'The specifically selected design variant, materials, color and surface details.',
      'Unselected variants, extra objects, reference layout and background.'],
    other:[common,'Only the mapped appearance, materials and surface details.',
      'Reference viewpoint, layout, extra objects and background.'],
  };
  const [keepFromMain,borrowFromReference,ignoreFromReference] = presets[kind];
  return {kind,keepFromMain,borrowFromReference,ignoreFromReference,requestedChange:'',expectedObjectCount:null,referenceVariant:''};
}

function validateSettings(settings) {
  need(exact(settings,SETTINGS_FIELDS) && settings.version===1,'Invalid scene consistency settings.');
  need(typeof settings.enabled==='boolean' && text(settings.mainAssetId),'Choose whether to use scene consistency and select its MAIN image.');
  need(exact(settings.global,[...GLOBAL_FLAGS,'notes']) && GLOBAL_FLAGS.every(field=>typeof settings.global[field]==='boolean') && text(settings.global.notes,2000),'Invalid scene consistency global rules. Notes allow up to 2000 characters.');
  need(Array.isArray(settings.groups) && settings.groups.length<=100,'Use at most 100 scene consistency numbered groups.');
  const labels = new Set();
  for (const group of settings.groups) {
    need(exact(group,GROUP_FIELDS) && text(group.label,1000,true) && !labels.has(group.label.trim()),'Each scene consistency group needs a unique numbered label.');
    need(SCENE_KINDS.includes(group.kind),'Choose a supported scene group type.');
    need(['keepFromMain','borrowFromReference','ignoreFromReference','requestedChange','referenceVariant'].every(field=>text(group[field])),'Scene group instructions allow up to 1000 characters per field.');
    need(group.expectedObjectCount===null || (Number.isInteger(group.expectedObjectCount) && group.expectedObjectCount>=0 && group.expectedObjectCount<=10000),'An expected object count must be blank or a whole number from 0 to 10000.');
    labels.add(group.label.trim());
  }
  need(Array.isArray(settings.objects) && settings.objects.length<=128,'Use at most 128 individually identified scene objects.');
  const ids = new Set();
  for (const object of settings.objects) {
    need(exact(object,Object.hasOwn(object,'anchor')?[...OBJECT_FIELDS,'anchor']:OBJECT_FIELDS) && text(object.id,1000,true) && !ids.has(object.id.trim()),'Each scene object needs a unique stable ID.');
    if(Object.hasOwn(object,'anchor'))need(exact(object.anchor,['x','y'])&&['x','y'].every(key=>Number.isFinite(object.anchor[key])&&object.anchor[key]>=0&&object.anchor[key]<=1),'Object locations must be normalized points inside the original MAIN image.');
    need(['label','name','overlap','notes'].every(field=>text(object[field])),'Scene object descriptions allow up to 1000 characters per field.');
    need(SCENE_KINDS.includes(object.kind) && SCENE_DIRECTIONS.includes(object.direction) && SCENE_VIEWS.includes(object.view) && SCENE_VISIBILITIES.includes(object.visibility),'Invalid scene object type, direction, visible view or visibility.');
    need(RANKS.includes(object.cardRank) && SUITS.includes(object.cardSuit),'Choose a supported card rank and suit, or keep each from MAIN.');
    ids.add(object.id.trim());
  }
  const continuity = settings.continuity;
  need(exact(continuity,CONTINUITY_FIELDS) && ['shot','frame','camera','previousFrame'].every(field=>text(continuity[field])) && text(continuity.changes,2000),'Invalid keyframe continuity notes.');
  need(Array.isArray(continuity.referenceIds) && continuity.referenceIds.length<=128 && continuity.referenceIds.every(id=>text(id,1000,true)) && new Set(continuity.referenceIds).size===continuity.referenceIds.length,'Choose up to 128 different continuity reference images.');
  return settings;
}

export function validateSceneConsistency(project) {
  if (!Object.hasOwn(project,'sceneConsistency')) return null;
  const settings = validateSettings(project.sceneConsistency);
  if (settings.enabled) {
    need(Boolean(settings.mainAssetId.trim()) && Object.hasOwn(project.assets||{},settings.mainAssetId),'Scene consistency needs an explicitly selected original MAIN image.');
    const sketchSurface=project.sketch&&(project.layers||[]).find(layer=>layer.id===project.sketch.surfaceLayerId);
    need(!sketchSurface||sketchSurface.assetId!==settings.mainAssetId,'The sketch paper is blank and cannot be the original Blender MAIN. Select an imported blockout image, or turn off Scene consistency for this sketch.');
    need(!project.blockoutReview?.enabled || project.blockoutReview.assetId===settings.mainAssetId,'Scene consistency MAIN and the enabled blockout review must use the same original image.');
  }
  return settings;
}

/** The caller owns this detached draft; changing it does not mutate the project. */
export function getSceneConsistency(project) {
  return clone(validateSceneConsistency(project) || defaults());
}

function visibleLabels(project) {
  return new Set((project.layers||[]).filter(layer=>layer.kind==='text' && layer.visible!==false && layer.opacity!==0 &&
    layer.x<project.width && layer.y<project.height && layer.x+layer.width>0 && layer.y+layer.height>0)
    .map(layer=>String(layer.text?.content||'').trim()).filter(Boolean));
}

/** Human-actionable preflight only: no guessed identities or inferred mask counts. */
export function sceneConsistencyPreflight(project) {
  const errors=[],warnings=[];
  let settings;
  try { settings=validateSceneConsistency(project); } catch(error) { errors.push(error.message); return {errors,warnings}; }
  if (!settings?.enabled) return {errors,warnings};
  const labels=visibleLabels(project),groupLabels=new Set(settings.groups.map(group=>group.label.trim()));
  for (const group of settings.groups) {
    if (!labels.has(group.label.trim())) warnings.push(`Group ${group.label} has no matching visible numbered label on this canvas.`);
    const rosterCount=settings.objects.filter(object=>object.label.trim()===group.label.trim()).length;
    if (group.expectedObjectCount!==null && group.expectedObjectCount!==rosterCount) warnings.push(`Group ${group.label} expects ${group.expectedObjectCount} physical objects but lists ${rosterCount} individual IDs. The roster may be partial; selection-region counts are not object counts.`);
    if (group.requestedChange.trim()) warnings.push(`Check group ${group.label}'s requested change against MAIN. Structural changes must also be listed in the explicit blockout exceptions when review is enabled.`);
  }
  for (const object of settings.objects) {
    if(!object.anchor&&!object.name.trim()&&!object.notes.trim())warnings.push(`Object ${object.id} needs a location on MAIN or a descriptive name so it can be distinguished from other objects sharing its number.`);
    if (!object.label.trim()) warnings.push(`Object ${object.id} has no numbered group; identify its location in its name or notes.`);
    else if (!labels.has(object.label.trim())) warnings.push(`Object ${object.id} refers to label ${object.label}, which is not visible on this canvas.`);
    else if (!groupLabels.has(object.label.trim())) warnings.push(`Object ${object.id} uses label ${object.label} without saved shared appearance rules.`);
  }
  const referenceIds=new Set((project.references||[]).map(reference=>reference.id));
  for (const id of settings.continuity.referenceIds) if(!referenceIds.has(id)) errors.push(`Continuity reference ${id} is missing. Choose an available reference image or remove this link.`);
  if (!settings.groups.length && !settings.objects.length) warnings.push('Only global scene rules are saved. Add numbered groups and individual IDs for object-specific checks.');
  return {errors,warnings};
}

export function sceneConsistencyInstructions(project) {
  const settings=validateSceneConsistency(project);
  if (!settings?.enabled) return '';
  const preflight=sceneConsistencyPreflight(project);
  need(!preflight.errors.length,preflight.errors.join(' '));
  const rules=[
    'SCENE CONSISTENCY CONTRACT — saved user scene requirements',
    `Original MAIN asset ID ${JSON.stringify(settings.mainAssetId)} controls camera view, framing, aspect ratio, positions, relative projected sizes, orientation, pose, contact, overlap and depth order. Appearance references cannot replace that composition.`,
    'Numbered groups share appearance rules. Stable object IDs identify physical instances, including partially obscured ones; the number of selection-mask regions is never the physical object count. Apply each instance rule to its own matching MAIN object, not as a generic angle for an entire row.',
    'Explicit keepFromMain and ignoreFromReference fields take precedence over generic reference-appearance borrowing. An example asset is not permission to replace every instance with its identity. A requestedChange describes user intent but does not create an exception to an enabled blockout geometry lock; structural exceptions must be in that lock’s dedicated authorized changes.',
    settings.global.preserveCardIdentity?'Preserve each card’s individual rank, suit, symbols and face/back visibility from MAIN unless that specific instance explicitly requests another identity. Never turn all cards into the rank/suit shown by a material example.':'',
    settings.global.preserveText?'Preserve intentional in-scene wording, spelling, case and layout from MAIN; remove annotation numbers, arrows, selection outlines and reference-sheet captions.':'',
    settings.global.preservePartialObjects?'Preserve partly hidden and cropped objects in their original overlap. Do not delete them or pull them into view.':'',
    settings.global.noExtraObjects?'Do not add unrequested objects or duplicate assets from appearance sheets.':'',
    settings.global.sharpTraffic?'Keep traffic and scene details in focus and sharp, with no car light trails or motion streaks.':'',
    'Read front/rear labels and travel arrows in annotation guides as direction instructions. The arrow points toward the car’s nose/travel direction; never reproduce arrows in the finished scene. Direction is separate from the visible camera-relative view. Match every car’s individual roof, rear-window, trunk/bumper visibility, foreshortening, footprint and wheel contacts to MAIN. from-main means inspect that individual object; do not invent a shared pose.',
    'Continuity images provide prior appearance and identity context only. They never override the current MAIN camera, framing, current object placement or current overlaps. Shot/frame/camera names are user labels, not verified numerical Blender camera data.',
    'An object anchor is a normalized point on the original MAIN: x is left to right and y is top to bottom, both 0 to 1. It identifies a point on that object’s visible part, not a target position to move to. Locate that individual object at the anchor and preserve its existing shape and overlap. Never render the anchor or ID as artwork.',
    'Review the actual source and candidate images independently against these requirements. Saved rules and preflight do not constitute approval or prove exact Blender world dimensions, numerical camera settings or pixel-perfect geometry.',
    'Saved scene requirements (JSON):\n'+JSON.stringify(settings),
  ];
  return rules.filter(Boolean).join('\n\n');
}

/** A reusable profile must not bind a different shot to this shot's source. */
export function sceneConsistencyTemplate(settings) {
  const template=clone(validateSettings(settings));
  template.enabled=false;
  template.mainAssetId='';
  template.continuity.referenceIds=[];
  template.continuity.frame='';
  template.continuity.previousFrame='';
  template.continuity.changes='';
  for(const object of template.objects)delete object.anchor;
  return template;
}

export function sceneConsistencyFromTemplate(project,template) {
  need(record(project),'Open a project before applying scene consistency defaults.');
  // No source is chosen from the canvas, import order or a previous template.
  return sceneConsistencyTemplate(template);
}
