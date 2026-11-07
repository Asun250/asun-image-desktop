// Manual local GPU smoke test. Opt in; default input is synthetic artwork.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {writeFile,mkdir} from 'node:fs/promises';
import {createLocalDetection} from '../local-sam.mjs';
import {validateDetectionResult,regionMaskInfo} from '../public/object-regions.mjs';
import {gpuFixture,gpuSkip} from './fixtures/portable-images.mjs';

test('local SAM returns valid regions and caches an unchanged working image', {skip:gpuSkip,timeout:240000}, async () => {
  const runtime = createLocalDetection();
  const fixture = await gpuFixture(), {width,height,source}=fixture, input={width,height,source};
  try {
    assert.equal((await runtime.status()).available,true,'Install the documented SAM runtime or set ASUN_SAM_ROOT.');
    const first = await runtime.detect(input);
    assert.match(first.device,/cuda|NVIDIA|RTX|GPU/i);
    assert.ok(first.regions.length > 0 && first.regions.length <= 256);
    const normalized=validateDetectionResult(first);
    let totalRuns = 0;
    for (const region of normalized.regions) {
      assert.equal(region.mask.width,width); assert.equal(region.mask.height,height);
      assert.equal(region.mask.counts.reduce((sum,n)=>sum+n,0),width*height);
      assert.ok(regionMaskInfo(region.mask).area>0);
      totalRuns += region.mask.counts.length;
    }
    assert.ok(totalRuns <= 4_000_000);
    const second = await runtime.detect(input);
    assert.equal(second.cached,true); assert.deepEqual(second.regions,first.regions);
    await assert.rejects(runtime.detect({...input,width:width-1}),/dimensions/);
    await mkdir(new URL('../qa/',import.meta.url),{recursive:true});
    await writeFile(new URL('../qa/local-detection-gpu-result.json',import.meta.url),JSON.stringify(first));
    console.log(JSON.stringify({fixture:fixture.fixture,model:first.model,device:first.device,width,height,regions:first.regions.length,totalRuns,firstMs:first.elapsedMs,cachedMs:second.elapsedMs}));
  } finally { runtime.dispose(); }
});
