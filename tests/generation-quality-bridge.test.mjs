import test from 'node:test';
import assert from 'node:assert/strict';
import {createDesktopGeneration} from '../public/desktop-sheet-generation.mjs';

const sunburst='gpt-image-2.5-sunburst',older='gpt-image-1.5';
const qualities=['auto','low','medium','high','xhigh','max'];
function fixture(t,kind='image',seed={}){
  const previous=Object.getOwnPropertyDescriptor(globalThis,'localStorage'),values=new Map(Object.entries(seed));
  Object.defineProperty(globalThis,'localStorage',{configurable:true,value:{getItem:key=>values.get(key)??null,setItem:(key,value)=>values.set(key,value),removeItem:key=>values.delete(key)}});
  t.after(()=>previous?Object.defineProperty(globalThis,'localStorage',previous):delete globalThis.localStorage);
  const requests=[],endpoint=kind==='image'?'/api/images':'/api/sheets',key='quality-test.'+kind;
  let complete=true,available=[sunburst,older];
  const response=(body,status=200)=>new Response(JSON.stringify(body),{status,headers:{'Content-Type':'application/json'}});
  const bridge=createDesktopGeneration({kind,endpoint,storageKey:key,pollMs:0,autoPoll:false,editor:{snapshot:()=>({prompt:'one blue bird'})},fetchImpl:async(url,init={})=>{
    if(url==='/api/generation-queue/status')return response({error:'Legacy fixture'},404);
    if(url.endsWith('/status'))return response({authenticated:true,token:'local-test',models:available.map(id=>({id,available:true}))});
    if(init.method==='POST'){const input=JSON.parse(init.body);requests.push(input);return response({id:input.requestId,status:'running'},202);}
    if(!complete)throw new Error('Temporary poll interruption');
    const request=requests.find(item=>url.endsWith(item.requestId));return response({id:request.requestId,status:'completed',model:request.model,settings:{model:request.model,quality:request.quality},image:{source:'data:image/png;base64,test',width:1,height:1}});
  }});
  t.after(()=>bridge.dispose());
  return{bridge,requests,values,key,interrupt:()=>{complete=false;},resume:()=>{complete=true;},catalog:models=>{available=models;}};
}

for(const kind of ['image','sheet']){
  test(`${kind} sends every Sunburst quality unchanged and keeps high as the initial default`,async t=>{
    const f=fixture(t,kind);await f.bridge.prepare();assert.equal(f.bridge.state().quality,'high');
    assert.deepEqual(f.bridge.state().qualityOptions,qualities);
    for(const quality of qualities){f.bridge.selectQuality(quality);const accepted=await f.bridge.generate();const result=await f.bridge.fetchResult(accepted.id);assert.equal(f.requests.at(-1).quality,quality);assert.equal(result.settings.quality,quality);assert.equal(f.requests.at(-1).model,sunburst);}
    assert.equal(f.requests.length,6);
    assert.equal(f.values.get(f.key+'.quality'),'max');
  });
  test(`${kind} preserves an unsupported quality on a model change and rejects it before any POST`,async t=>{
    const f=fixture(t,kind);await f.bridge.prepare();f.bridge.selectQuality('max');f.bridge.selectModel(older);
    assert.equal(f.bridge.state().quality,'max');assert.match(f.bridge.state().settingsError,/quality|support/i);
    await assert.rejects(f.bridge.generate(),/quality|support/i);assert.equal(f.requests.length,0);
    assert.throws(()=>f.bridge.selectQuality('ultra'),/quality|support/i);assert.equal(f.bridge.state().quality,'max');
    f.bridge.selectQuality('high');assert.equal(f.bridge.state().settingsError,'');await f.bridge.generate();assert.equal(f.requests[0].quality,'high');
  });
  test(`${kind} keeps queued quality immutable while next-job settings remain editable through a poll interruption`,async t=>{
    const f=fixture(t,kind);await f.bridge.prepare();f.bridge.selectQuality('xhigh');const accepted=await f.bridge.generate();f.interrupt();await assert.rejects(f.bridge.refreshJob(accepted.id),/poll interruption/);
    f.bridge.selectQuality('low');f.bridge.selectModel(older);assert.equal(f.bridge.state().quality,'low');assert.equal(f.bridge.state().model,older);
    f.resume();const result=await f.bridge.fetchResult(accepted.id);assert.equal(f.requests.length,1);assert.equal(result.settings.quality,'xhigh');assert.equal(result.settings.model,sunburst);assert.equal(f.bridge.state().quality,'low');assert.equal(f.bridge.state().model,older);
  });
  test(`${kind} reports a selected model disappearing instead of silently replacing it`,async t=>{
    const f=fixture(t,kind);await f.bridge.prepare();f.catalog([older]);await f.bridge.prepare();
    assert.equal(f.bridge.state().model,sunburst);assert.equal(f.bridge.state().canAttach,false);assert.match(f.bridge.state().settingsError,/unavailable/);
    await assert.rejects(f.bridge.generate(),/unavailable/);assert.equal(f.requests.length,0);
  });
}
