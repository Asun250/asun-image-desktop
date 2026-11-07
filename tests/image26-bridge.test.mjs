import test from 'node:test';
import assert from 'node:assert/strict';
import {createDesktopGeneration} from '../public/desktop-sheet-generation.mjs';

const sunburst='gpt-image-2.6-sunburst',flare='gpt-image-2.6-flare',older='gpt-image-2.5-sunburst';
function fixture(t,kind='image',seed={}){
  const previous=Object.getOwnPropertyDescriptor(globalThis,'localStorage'),values=new Map(Object.entries(seed)),key='image26.'+kind;
  Object.defineProperty(globalThis,'localStorage',{configurable:true,value:{getItem:key=>values.get(key)??null,setItem:(key,value)=>values.set(key,value),removeItem:key=>values.delete(key)}});
  t.after(()=>previous?Object.defineProperty(globalThis,'localStorage',previous):delete globalThis.localStorage);
  const requests=[],records=new Map();
  const response=(body,status=200)=>new Response(JSON.stringify(body),{status,headers:{'Content-Type':'application/json'}});
  const options={kind,storageKey:key,autoPoll:false,editor:{snapshot:()=>({prompt:'Create the scene'})},fetchImpl:async(url,init={})=>{
    if(url==='/api/generation-queue/status')return response({items:[...records.values()]});
    if(url.endsWith('/status'))return response({authenticated:true,token:'test',models:[older,sunburst,flare].map(id=>({id,available:true}))});
    if(init.method==='POST'){const input=JSON.parse(init.body);requests.push(input);const record={id:input.requestId,kind,status:'queued',model:input.model,settings:{model:input.model,quality:input.quality,...(input.complexity===undefined?{}:{complexity:input.complexity})}};records.set(record.id,record);return response(record,202);}
    return response(records.get(url.split('/').at(-1)));
  }};
  const bridges=[],make=()=>{const bridge=createDesktopGeneration(options);bridges.push(bridge);return bridge;};
  t.after(()=>bridges.forEach(bridge=>bridge.dispose()));return{bridge:make(),make,requests,values,key};
}
for(const kind of ['image','sheet']){
  test(`${kind}: 2.6 complexity is separate from quality, sent unchanged, and compact jobs retain it`,async t=>{
    const f=fixture(t,kind);await f.bridge.prepare();assert.equal(f.bridge.state().model,older);assert.equal(f.bridge.state().quality,'high');
    f.bridge.selectModel(sunburst);assert.equal(f.bridge.state().complexity,'high');assert.deepEqual(f.bridge.state().complexityOptions,['low','medium','high']);f.bridge.selectQuality('max');
    for(const complexity of ['low','medium','high']){f.bridge.selectComplexity(complexity);await f.bridge.generate();assert.equal(f.requests.at(-1).complexity,complexity);assert.equal(f.requests.at(-1).quality,'max');assert.equal(f.bridge.state().jobs.at(-1).settings.complexity,complexity);}
    f.bridge.selectModel(flare);await f.bridge.generate();assert.equal(f.requests.at(-1).model,flare);assert.equal(f.requests.at(-1).complexity,'high');
  });
  test(`${kind}: legacy models omit complexity while preserving it for return to 2.6 and reload`,async t=>{
    const f=fixture(t,kind);await f.bridge.prepare();f.bridge.selectModel(sunburst);f.bridge.selectComplexity('medium');f.bridge.selectModel(older);await f.bridge.generate();
    assert.equal(Object.hasOwn(f.requests.at(-1),'complexity'),false);assert.deepEqual(f.bridge.state().complexityOptions,[]);assert.equal(f.bridge.state().complexity,'medium');
    assert.throws(()=>f.bridge.selectComplexity('low'),/complexity|support/i);f.bridge.selectModel(flare);assert.equal(f.bridge.state().complexity,'medium');
    const reloaded=f.make();await reloaded.prepare();assert.equal(reloaded.state().model,flare);assert.equal(reloaded.state().complexity,'medium');assert.equal(reloaded.state().quality,'high');
  });
  test(`${kind}: unsupported stored complexity blocks submission and is never downgraded`,async t=>{
    const f=fixture(t,kind,{['image26.'+kind+'.model']:sunburst,['image26.'+kind+'.complexity']:'max'});await f.bridge.prepare();
    assert.equal(f.bridge.state().complexity,'max');assert.match(f.bridge.state().settingsError,/complexity/i);await assert.rejects(f.bridge.generate(),/complexity/i);assert.equal(f.requests.length,0);
    f.bridge.selectComplexity('low');assert.equal(f.bridge.state().settingsError,'');await f.bridge.generate();assert.equal(f.requests[0].complexity,'low');
  });
  test(`${kind}: tab settings and redo restore complexity without changing an earlier queued job`,async t=>{
    const f=fixture(t,kind);await f.bridge.prepare();f.bridge.selectModel(sunburst);f.bridge.selectComplexity('low');const first=await f.bridge.generate();
    f.bridge.setWorkflowContext({settings:{model:flare,quality:'medium',complexity:'high'}});await f.bridge.generate();assert.equal(f.requests[0].complexity,'low');assert.equal(f.requests[1].complexity,'high');
    f.bridge.useSettings(first);assert.equal(f.bridge.state().model,sunburst);assert.equal(f.bridge.state().complexity,'low');assert.equal(f.bridge.state().quality,'high');
    f.bridge.setWorkflowContext({settings:{model:flare,quality:'low',complexity:'medium'}});assert.equal(f.bridge.state().complexity,'medium');
  });
}
