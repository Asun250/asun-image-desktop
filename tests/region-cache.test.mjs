import {test,beforeEach} from 'node:test';
import assert from 'node:assert/strict';
import {regionMaskInfo,regionContainsPoint,clearRegionCache} from '../public/object-regions.mjs';

beforeEach(()=>clearRegionCache());
function observedMask(width=16,height=16,values=[0,width*height]){
  let reads=0;
  const counts=new Proxy(values,{get(target,key,receiver){if(typeof key==='string'&&/^\d+$/.test(key))reads++;return Reflect.get(target,key,receiver);}});
  return{mask:{width,height,counts},reads:()=>reads};
}
test('expanded geometry is LRU bounded even when history retains all mask objects',()=>{
  const masks=Array.from({length:257},()=>observedMask());
  for(const entry of masks)regionMaskInfo(entry.mask);
  const old=masks[0],recent=masks.at(-1),before=old.reads(),recentBefore=recent.reads();
  assert.deepEqual(regionMaskInfo(recent.mask),{area:256,bbox:[0,0,16,16]});assert.equal(recent.reads(),recentBefore);
  assert.deepEqual(regionMaskInfo(old.mask),{area:256,bbox:[0,0,16,16]});assert(old.reads()>before);
  assert.equal(regionContainsPoint(old.mask,15.5,15.5),true);assert.equal(regionContainsPoint(old.mask,16,15),false);
});
test('expanded complex masks obey a geometry budget independently of entry count',()=>{
  const masks=Array.from({length:4},()=>observedMask(512,512,[0,...new Array(512*512).fill(1)]));
  for(const entry of masks)regionMaskInfo(entry.mask);
  const first=masks[0],before=first.reads();
  assert.equal(regionContainsPoint(first.mask,0,0),true);assert(first.reads()>before,'Four checker masks exceed the64 MiB derived-geometry allowance.');
  assert.equal(regionContainsPoint(first.mask,1,0),false);assert.equal(regionContainsPoint(first.mask,2,0),true);
  assert.deepEqual(regionMaskInfo(first.mask),{area:131072,bbox:[0,0,511,512]});
});
test('clearing derived geometry releases old mask cache without changing saved RLE',()=>{
  const entry=observedMask(4,4,[0,3,10,3]),beforeCounts=[...entry.mask.counts];
  const expected=regionMaskInfo(entry.mask),before=entry.reads();clearRegionCache();
  assert.deepEqual(regionMaskInfo(entry.mask),expected);assert(entry.reads()>before);assert.deepEqual([...entry.mask.counts],beforeCounts);
  assert.equal(regionContainsPoint(entry.mask,0,0),true);assert.equal(regionContainsPoint(entry.mask,3,0),false);assert.equal(regionContainsPoint(entry.mask,1,3),true);
});
