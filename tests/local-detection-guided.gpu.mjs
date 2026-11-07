// Manual real-GPU guided inference/cache check; default fixture is synthetic.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {writeFile,mkdir} from 'node:fs/promises';
import {createLocalDetection} from '../local-sam.mjs';
import {validateDetectionResult,regionMaskInfo} from '../public/object-regions.mjs';
import {gpuFixture,gpuSkip} from './fixtures/portable-images.mjs';

test('local SAM guides two different boxes and preserves the automatic cache',{skip:gpuSkip,timeout:240000},async()=>{
  const runtime=createLocalDetection(),fixture=await gpuFixture(),{width,height,source}=fixture;
  const input={width,height,source};
  const boxes=[[.08,.12,.4,.55],[.55,.08,.9,.55]].map(box=>box.map((value,index)=>Math.round(value*(index%2?height:width))));
  try{
    assert.equal((await runtime.status()).available,true,'Install the documented SAM runtime or set ASUN_SAM_ROOT.');
    const automatic=await runtime.detect(input),guided=[];
    for(const box of boxes){
      const result=await runtime.detect({...input,prompt:{box}});
      assert.match(result.device,/cuda|NVIDIA|RTX|GPU/i);assert.equal(result.width,width);assert.equal(result.height,height);
      assert.ok(result.regions.length>0&&result.regions.length<=3);
      for(const region of validateDetectionResult(result).regions){
        assert.ok(regionMaskInfo(region.mask).area>0);
        assert.equal(region.mask.counts.reduce((sum,count)=>sum+count,0),width*height);
        assert.ok(region.mask.counts.length<=512001);
      }
      assert.notEqual(result.cached,true);guided.push(result);
    }
    const cached=await runtime.detect(input);
    assert.equal(cached.cached,true);assert.deepEqual(cached.regions,automatic.regions);
    await assert.rejects(runtime.detect({...input,prompt:{box:[0,0,width+1,height]}}),/box/);
    const report={fixture:fixture.fixture,model:guided[0].model,device:guided[0].device,width,height,boxes,automaticRegions:automatic.regions.length,automaticMs:automatic.elapsedMs,guided:guided.map(result=>({regions:result.regions.length,elapsedMs:result.elapsedMs})),cachedAutomaticMs:cached.elapsedMs};
    await mkdir(new URL('../qa/',import.meta.url),{recursive:true});
    await writeFile(new URL('../qa/guided-detection-gpu-result.json',import.meta.url),JSON.stringify({report,results:guided},null,2));
    console.log(JSON.stringify(report));
  }finally{runtime.dispose();}
});
