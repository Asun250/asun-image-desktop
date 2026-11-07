import test from 'node:test';
import assert from 'node:assert/strict';
import {
  getSceneConsistency,validateSceneConsistency,sceneConsistencyInstructions,
  sceneConsistencyPreflight,sceneConsistencyTemplate,sceneConsistencyFromTemplate,
  groupPreset,SCENE_KINDS,SCENE_DIRECTIONS,SCENE_VIEWS,SCENE_VISIBILITIES,
} from '../public/scene-consistency.mjs';

function fixture() {
  const project={assets:{main:{id:'main'},other:{id:'other'}},width:1600,height:900,references:[{id:'previous'}],
    layers:[{id:'cars',kind:'text',text:{content:'2'},visible:true,opacity:1,x:10,y:10,width:30,height:30}]};
  project.sceneConsistency={...getSceneConsistency(project),enabled:true,mainAssetId:'main'};
  project.sceneConsistency.groups=[{label:'2',...groupPreset('car'),expectedObjectCount:2}];
  project.sceneConsistency.objects=[object('2A'),object('2B',{visibility:'partial',overlap:'Behind 2A'})];
  return project;
}
function object(id,overrides={}) {
  return {id,label:'2',name:'Far-lane car',kind:'car',direction:'left',view:'top-rear-three-quarter',
    cardRank:'from-main',cardSuit:'from-main',visibility:'full',overlap:'',notes:'',...overrides};
}
function freeze(value) {
  if (value&&typeof value==='object') { Object.freeze(value); for(const item of Object.values(value)) freeze(item); }
  return value;
}

test('object anchors identify current MAIN and never leak into another frame default',()=>{
  const project=fixture();project.sceneConsistency.objects[0].anchor={x:.25,y:.8};
  assert.doesNotThrow(()=>validateSceneConsistency(project));
  assert.match(sceneConsistencyInstructions(project),/normalized point on the original MAIN/);
  assert.equal(sceneConsistencyTemplate(project.sceneConsistency).objects[0].anchor,undefined);
  assert.deepEqual(project.sceneConsistency.objects[0].anchor,{x:.25,y:.8});
  for(const anchor of [{x:-.1,y:.5},{x:1.1,y:0},{x:NaN,y:0},{x:0},{x:0,y:0,z:0}]){
    project.sceneConsistency.objects[0].anchor=anchor;assert.throws(()=>validateSceneConsistency(project),/normalized points/);
  }
});

test('blank sketch paper cannot silently become the original Blender MAIN',()=>{
  const project=fixture();project.sketch={version:1,surfaceLayerId:'paper'};project.layers.push({id:'paper',kind:'raster',assetId:'main'});
  assert.throws(()=>validateSceneConsistency(project),/sketch paper is blank/);
  project.sceneConsistency.mainAssetId='other';assert.doesNotThrow(()=>validateSceneConsistency(project));
});

test('existing projects stay off and contribute no generation instructions',()=>{
  const project={assets:{}};
  assert.equal(validateSceneConsistency(project),null);
  assert.equal(sceneConsistencyInstructions(project),'');
  assert.deepEqual(sceneConsistencyPreflight(project),{errors:[],warnings:[]});
  const first=getSceneConsistency(project),second=getSceneConsistency(project);
  assert.equal(first.enabled,false);assert.equal(first.mainAssetId,'');
  first.global.notes='Edited draft';first.objects.push(object('2A'));
  assert.equal(second.global.notes,'');assert.equal(second.objects.length,0);
  assert.equal(project.sceneConsistency,undefined);
});

test('explicit original selection is required and must agree with enabled review',()=>{
  const project=fixture();project.sceneConsistency.mainAssetId='';
  assert.throws(()=>validateSceneConsistency(project),/explicitly selected original MAIN/);
  assert.match(sceneConsistencyPreflight(project).errors[0],/MAIN/);
  project.sceneConsistency.mainAssetId='missing';
  assert.throws(()=>validateSceneConsistency(project),/MAIN/);
  project.sceneConsistency.mainAssetId='main';project.blockoutReview={enabled:true,assetId:'other'};
  assert.throws(()=>validateSceneConsistency(project),/same original image/);
  project.blockoutReview.enabled=false;
  assert.doesNotThrow(()=>validateSceneConsistency(project));
});

test('disabled saved drafts do not select a source or add instructions',()=>{
  const project=fixture();project.sceneConsistency.enabled=false;project.sceneConsistency.mainAssetId='removed';
  project.blockoutReview={enabled:true,assetId:'other'};
  assert.equal(sceneConsistencyInstructions(project),'');
  assert.deepEqual(sceneConsistencyPreflight(project),{errors:[],warnings:[]});
});

test('per-object identity and rear view instructions survive verbatim without confusing selections with counts',()=>{
  const project=fixture();
  project.sceneConsistency.groups.push({label:'3',...groupPreset('card'),expectedObjectCount:null});
  project.sceneConsistency.objects.push(object('3A',{label:'3',kind:'card',name:'Queen of clubs',cardRank:'Q',cardSuit:'clubs',direction:'from-main',view:'from-main'}));
  const text=sceneConsistencyInstructions(project);
  assert.match(text,/"id":"2A"/);assert.match(text,/"view":"top-rear-three-quarter"/);
  assert.match(text,/"id":"3A"/);assert.match(text,/"cardRank":"Q","cardSuit":"clubs"/);
  assert.match(text,/selection-mask regions is never the physical object count/);
  assert.match(text,/Never turn all cards into the rank\/suit/);
  assert.match(text,/Keep traffic.*no car light trails/);
  assert.match(text,/dedicated authorized changes/);
  assert.match(text,/do not constitute approval or prove exact Blender/);
});

test('continuity inputs are context only and missing linked images stop instruction creation',()=>{
  const project=fixture();project.sceneConsistency.continuity={shot:'Intro',frame:'20',camera:'Camera A',previousFrame:'1',referenceIds:['previous'],changes:'The camera rises slightly.'};
  assert.deepEqual(sceneConsistencyPreflight(project).errors,[]);
  const text=sceneConsistencyInstructions(project);
  assert.match(text,/Continuity images provide prior appearance and identity context only/);
  assert.match(text,/never override the current MAIN camera/);
  assert.match(text,/"referenceIds":\["previous"\]/);
  project.references=[];
  assert.match(sceneConsistencyPreflight(project).errors[0],/Continuity reference previous is missing/);
  assert.throws(()=>sceneConsistencyInstructions(project),/Continuity reference/);
});

test('partial rosters warn instead of inferring counts from disconnected masks',()=>{
  const project=fixture();project.sceneConsistency.groups[0].expectedObjectCount=10;
  project.layers[0].objectRegion={group:{areaCount:7}};
  const result=sceneConsistencyPreflight(project);
  assert.deepEqual(result.errors,[]);
  assert.match(result.warnings[0],/expects 10 physical objects but lists 2 individual IDs/);
  assert.match(result.warnings[0],/roster may be partial/);
  assert.equal(result.warnings.some(message=>message.includes('expects 7')),false);
});

test('hidden or removed number labels produce repair guidance without losing saved object IDs',()=>{
  const project=fixture();project.layers[0].visible=false;
  const result=sceneConsistencyPreflight(project);
  assert.equal(result.errors.length,0);
  assert.ok(result.warnings.some(message=>message.includes('Group 2 has no matching visible')));
  assert.ok(result.warnings.some(message=>message.includes('Object 2B refers to label 2')));
  assert.equal(project.sceneConsistency.objects[1].id,'2B');
});

test('individual objects can exist before their shared rules, with a useful warning',()=>{
  const project=fixture();project.sceneConsistency.groups=[];
  assert.ok(sceneConsistencyPreflight(project).warnings.some(message=>message.includes('without saved shared appearance rules')));
  project.sceneConsistency.objects[0].label='';
  assert.ok(sceneConsistencyPreflight(project).warnings.some(message=>message.includes('Object 2A has no numbered group')));
});

test('unsupported values and ambiguous duplicate identifiers are rejected',()=>{
  for(const mutate of [
    value=>{value.version=2;},
    value=>{value.groups.push({...value.groups[0],label:' 2 '});},
    value=>{value.objects.push({...value.objects[0],id:' 2A '});},
    value=>{value.objects[0].direction='northwest';},
    value=>{value.objects[0].view='generic';},
    value=>{value.objects[0].cardRank='Ace';},
    value=>{value.objects[0].cardSuit='joker';},
    value=>{value.objects[0].visibility='guess';},
    value=>{value.groups[0].expectedObjectCount=-1;},
    value=>{value.groups[0].expectedObjectCount=1.5;},
    value=>{value.global.preserveText='true';},
    value=>{value.continuity.referenceIds=['previous','previous'];},
    value=>{value.extra='Unvalidated instruction';},
  ]) {
    const project=fixture();mutate(project.sceneConsistency);
    assert.throws(()=>validateSceneConsistency(project));
  }
});

test('bounded counts and text prevent unbounded saved contracts',()=>{
  for(const mutate of [
    value=>{value.objects=Array.from({length:129},(_,i)=>object(`2-${i}`));},
    value=>{value.groups=Array.from({length:101},(_,i)=>({label:String(i),...groupPreset('other')}));},
    value=>{value.objects[0].notes='x'.repeat(1001);},
    value=>{value.global.notes='x'.repeat(2001);},
    value=>{value.continuity.changes='x'.repeat(2001);},
  ]) {
    const project=fixture();mutate(project.sceneConsistency);
    assert.throws(()=>validateSceneConsistency(project));
  }
});

test('reusable defaults strip source and previous-frame bindings without mutating saved settings',()=>{
  const project=fixture();project.sceneConsistency.continuity={shot:'Intro',frame:'20',camera:'Main camera',previousFrame:'1',referenceIds:['previous'],changes:'Raise the camera.'};
  const before=structuredClone(project);freeze(project);
  const template=sceneConsistencyTemplate(project.sceneConsistency);
  assert.equal(template.enabled,false);assert.equal(template.mainAssetId,'');
  assert.deepEqual(template.continuity,{shot:'Intro',frame:'',camera:'Main camera',previousFrame:'',referenceIds:[],changes:''});
  assert.equal(template.objects[0].id,'2A');
  const applied=sceneConsistencyFromTemplate({assets:{newMain:{}}},template);
  assert.equal(applied.enabled,false);assert.equal(applied.mainAssetId,'');
  applied.objects[0].name='Changed in next shot';
  assert.equal(template.objects[0].name,'Far-lane car');
  assert.deepEqual(project,before);
});

test('retrieval, preflight and prompt generation are pure and preserve Unicode user notes',()=>{
  const project=fixture();project.sceneConsistency.global.notes='保留 “MAIN”\nOnly façade detail. 🏙️';
  const before=structuredClone(project);freeze(project);
  const draft=getSceneConsistency(project);draft.global.notes='Another draft';
  sceneConsistencyPreflight(project);
  const first=sceneConsistencyInstructions(project),second=sceneConsistencyInstructions(project);
  assert.equal(first,second);assert.ok(first.includes(JSON.stringify(before.sceneConsistency.global.notes)));
  assert.deepEqual(project,before);
});

test('presets explicitly limit borrowing for identity-sensitive assets',()=>{
  assert.match(groupPreset('card').keepFromMain,/rank, suit/);
  assert.match(groupPreset('card').ignoreFromReference,/example card rank or suit/);
  assert.match(groupPreset('car').keepFromMain,/Nose direction/);
  assert.match(groupPreset('text').keepFromMain,/Exact wording/);
  assert.match(groupPreset('architecture').ignoreFromReference,/extra structures/);
  assert.throws(()=>groupPreset('unknown'),/supported/);
  assert.ok(SCENE_KINDS.includes('car'));assert.ok(SCENE_DIRECTIONS.includes('from-main'));
  assert.ok(SCENE_VIEWS.includes('top-rear-three-quarter'));assert.ok(SCENE_VISIBILITIES.includes('partial'));
});
