import {test} from 'node:test';
import assert from 'node:assert/strict';
import {referencePackWorkflow,referencePackAgentInstructions,PACK_AGENT_INSTRUCTIONS} from '../public/reference-pack-workflow.mjs';

const record=(assetId,path,sha256)=>({assetId,path,sha256,width:1600,height:900,mimeType:'image/png',byteLength:1234,originalFilename:assetId+'.png'});
function fixture(){
  const first=record('first','originals/main/first.png','1'.repeat(64));
  const blockout=record('blockout','originals/main/blockout.png','2'.repeat(64));
  return {
    project:{name:'Scene',width:1600,height:900,prompt:'Retain the composition; use the mapped materials.',assets:{first:{},blockout:{}},layers:[]},
    mapping:{project:{name:'Scene',width:1600,height:900,prompt:'Retain the composition; use the mapped materials.'},cleanMain:first,mainImages:[first,blockout],numbers:[],unassignedReferences:[]},
  };
}
const enabled=(overrides={})=>({version:1,enabled:true,model:'gpt-6-astra',effort:'max',maxAttempts:3,assetId:'blockout',authorizedChanges:'',...overrides});
function instructions(project,mapping){return referencePackAgentInstructions({...mapping,agentWorkflow:referencePackWorkflow(project,mapping)});}
function freeze(value){if(value&&typeof value==='object'){Object.freeze(value);for(const child of Object.values(value))freeze(child);}return value;}
function sketchFixture(){
  const {project,mapping}=fixture();
  project.sketch={version:1,background:'#ffffff',surfaceLayerId:'paper'};
  project.layers=[{id:'paper',kind:'raster',assetId:'first'}];
  mapping.sketch={composition:{path:'generated-previews/sketch-composition.png',sha256:'3'.repeat(64),width:1600,height:900,mimeType:'image/png',byteLength:2345,role:'drawn scene composition'},editableProject:'editable-sketch.asun'};
  return {project,mapping};
}

test('enabled review selects the non-first original by asset identity without changing cleanMain',()=>{
  const {project,mapping}=fixture();
  project.blockoutReview=enabled({maxAttempts:2,authorizedChanges:'Move only object 4 to the agreed marked position.'});
  const workflow=referencePackWorkflow(project,mapping);
  assert.equal(workflow.source.selection,'user-selected-original');
  assert.equal(workflow.source.image.assetId,'blockout');
  assert.equal(workflow.source.image.path,'originals/main/blockout.png');
  assert.equal(workflow.source.image.sha256,'2'.repeat(64));
  assert.equal(mapping.cleanMain.assetId,'first');
  assert.equal(workflow.maxGenerationAttempts,2);
  assert.deepEqual(workflow.geometryExceptions,{mode:'explicit-exceptions',text:project.blockoutReview.authorizedChanges});
  const text=instructions(project,mapping);
  assert.match(text,/explicitly selected the original/);
  assert.match(text,/Freeze this exact file and checksum/);
  assert.match(text,/Geometry changes are allowed only when listed in the explicit blockout exceptions/);
  assert.ok(text.includes(JSON.stringify(project.blockoutReview.authorizedChanges)));
});

test('disabled stale review settings are not used as source authority, exceptions or attempt budget',()=>{
  const {project,mapping}=fixture();
  project.blockoutReview=enabled({enabled:false,assetId:'deleted-asset',maxAttempts:1,authorizedChanges:'Old instruction: move the entire building.'});
  const workflow=referencePackWorkflow(project,mapping);
  assert.equal(workflow.source.selection,'identify-original-main');
  assert.equal(workflow.source.candidate.assetId,'first');
  assert.equal(workflow.maxGenerationAttempts,3);
  assert.deepEqual(workflow.geometryExceptions,{mode:'explicit-user-instructions',text:''});
  const text=instructions(project,mapping);
  assert.doesNotMatch(text,/deleted-asset|Old instruction/);
  assert.match(text,/if the source is ambiguous or missing, ask the user/);
  assert.match(text,/do not assume that image order/);
});

test('an enabled source omitted from the packed originals fails instead of falling back to first image',()=>{
  const {project,mapping}=fixture();project.blockoutReview=enabled();
  mapping.mainImages=mapping.mainImages.filter(image=>image.assetId!=='blockout');
  assert.throws(()=>referencePackWorkflow(project,mapping),/chosen blockout is missing from the reference pack/i);
});

test('sketch authority is the clean drawing rather than the preserved blank paper',()=>{
  const {project,mapping}=sketchFixture();
  const workflow=referencePackWorkflow(project,mapping);
  assert.equal(workflow.source.selection,'sketch-composition');
  assert.equal(workflow.source.image.path,'generated-previews/sketch-composition.png');
  assert.equal(workflow.source.image.sha256,'3'.repeat(64));
  assert.equal(mapping.cleanMain.path,'originals/main/first.png');
  const text=instructions(project,mapping);
  assert.match(text,/blank drawing paper, not a Blender blockout/);
  assert.match(text,/If the task requires a Blender blockout, ask for that missing original before generating/);
});

test('selecting sketch paper cannot certify it as Blender authority, while a separate explicit source wins',()=>{
  const {project,mapping}=sketchFixture();
  project.blockoutReview=enabled({assetId:'first'});
  const paperWorkflow=referencePackWorkflow(project,mapping);
  assert.equal(paperWorkflow.source.selection,'sketch-composition');
  assert.match(paperWorkflow.source.note,/blank drawing paper/);
  project.blockoutReview.assetId='blockout';
  const realWorkflow=referencePackWorkflow(project,mapping);
  assert.equal(realWorkflow.source.selection,'user-selected-original');
  assert.equal(realWorkflow.source.image.assetId,'blockout');
  assert.equal(realWorkflow.source.image.sha256,'2'.repeat(64));
});

test('workflow preparation and instruction rendering preserve both input objects and are deterministic',()=>{
  const {project,mapping}=fixture();project.blockoutReview=enabled();
  const before=structuredClone({project,mapping});freeze(project);freeze(mapping);
  const first=referencePackWorkflow(project,mapping),second=referencePackWorkflow(project,mapping);
  assert.deepEqual(first,second);
  assert.equal(instructions(project,mapping),instructions(project,mapping));
  assert.deepEqual({project,mapping},before);
  first.source.image.path='changed by caller';
  assert.equal(mapping.mainImages[1].path,'originals/main/blockout.png');
});

test('global scene prompt retains Unicode, quotes, line breaks and exact wording in exported instructions',()=>{
  const {project,mapping}=fixture();
  const prompt='Only use building “東京”.\r\nKeep "MAIN" camera.\\notes\nNo extra birds. 🏙️';
  project.prompt=prompt;mapping.project.prompt=prompt;
  const text=instructions(project,mapping);
  const after=text.split('GLOBAL SCENE PROMPT (JSON string; original wording preserved)\r\n\r\n')[1];
  assert.ok(after,'The global prompt has its own explicit section.');
  assert.equal(JSON.parse(after.split('\r\n\r\n')[0]),prompt);
  assert.match(text,/all applicable mapping\.numbers comments and reference notes/);
  assert.match(text,/Unassigned reference photos are not a list of objects to insert/);
});

test('portable workflow requests independent exact-model review without claiming it has already run',()=>{
  const {project,mapping}=fixture();const workflow=referencePackWorkflow(project,mapping);
  assert.equal(workflow.instructions,PACK_AGENT_INSTRUCTIONS);
  assert.equal(workflow.requested,true);
  assert.equal(workflow.execution,'receiving-agent');
  assert.equal(workflow.reviewStatus,'not-run');
  assert.deepEqual(workflow.reviewer,{model:'gpt-6-astra',reasoningEffort:'max',separateAgentRequired:true,allowSubstitution:false});
  assert.equal(workflow.maxGenerationAttempts,3);
  assert.equal(workflow.onReject,'correct-and-review-again');
  assert.equal(workflow.onUncertainOrError,'stop-needs-review');
  assert.equal(workflow.onAttemptLimit,'stop-needs-review');
  const text=instructions(project,mapping);
  for(const expression of [
    /does not execute any agent, generate an image, or certify approval/,
    /Use a separate reviewing agent with the actual model and setting selected/,
    /Do not substitute another model or effort/,
    /If unavailable, report that review cannot run and stop before generation/,
    /at most 3 attempts, including the first image/,
    /INCONCLUSIVE, not approval/,
    /technical error, refusal, unsupported setting or unavailable reviewer is not a rejection/,
    /same frozen original, reference mapping, original instructions and agreed exceptions/,
    /Keep the chosen generation model and quality; do not silently switch them/,
    /Stop immediately on an uncertain review or technical failure/,
    /unknown network outcome is not permission to automatically repeat a paid request/,
    /Visual match passed only after an actual successful independent review/,
    /otherwise label it Needs review/,
    /cannot certify exact Blender world dimensions/,
  ])assert.match(text,expression);
});

test('unsupported reviewer settings and invalid attempt limits are reported rather than normalized',()=>{
  for(const override of [{model:'different-model'},{effort:'ultra'},{maxAttempts:0},{maxAttempts:4}]){
    const {project,mapping}=fixture();project.blockoutReview=enabled(override);
    assert.throws(()=>referencePackWorkflow(project,mapping),/Unsupported reviewer settings|between 1 and 3 total generation attempts/);
  }
});
