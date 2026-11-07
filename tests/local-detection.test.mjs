import {test} from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {mkdtemp,mkdir,writeFile,rm} from 'node:fs/promises';
import path from 'node:path';
import {tmpdir} from 'node:os';
import {randomUUID} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {createServer} from '../server.mjs';
import {createLocalDetection, validateDetectionInput, MAX_DETECTION_BODY} from '../local-sam.mjs';

const image = {width:1,height:1,source:'data:image/png;base64,aGVsbG8='};
test('local detection accepts bounded embedded images and rejects remote URLs, paths and malformed data', () => {
  assert.deepEqual(validateDetectionInput(image),image);
  for (const source of ['https://example.com/image.png','file:///C:/image.png','C:\\image.png','data:image/svg+xml;base64,aGVsbG8=','data:image/png;base64,a!==','data:image/png;base64,a']) assert.throws(() => validateDetectionInput({...image,source}));
  for (const width of [0,1601,1.2,'1',null]) assert.throws(() => validateDetectionInput({...image,width}));
  assert.throws(() => validateDetectionInput(null));
});

test('missing local runtime reports unavailable without spawning or downloading anything', async () => {
  const runtime = createLocalDetection({runtimeRoot:path.join(tmpdir(),'asun-missing-runtime-'+randomUUID()),spawnWorker(){throw new Error('Must not spawn');}});
  try {
    assert.equal((await runtime.status()).available,false);
    await assert.rejects(runtime.detect(image),/unavailable/);
  } finally { runtime.dispose(); }
});

async function withWorkerRuntime(run) {
  const qaRoot = fileURLToPath(new URL('../qa/',import.meta.url));
  await mkdir(qaRoot,{recursive:true});
  const runtimeRoot = await mkdtemp(path.join(qaRoot,'worker-runtime-test-'));
  try {
    for (const directory of ['env/Scripts','checkpoints','source/sam2']) await mkdir(path.join(runtimeRoot,directory),{recursive:true});
    for (const filename of ['env/Scripts/python.exe','checkpoints/sam2.1_hiera_base_plus.pt','source/sam2/build_sam.py']) await writeFile(path.join(runtimeRoot,filename),'');
    await writeFile(path.join(runtimeRoot,'runtime.json'),JSON.stringify({status:'installed'}));
    await run(runtimeRoot);
  } finally {
    assert.ok(path.resolve(runtimeRoot).startsWith(path.resolve(qaRoot)+path.sep));
    await rm(runtimeRoot,{recursive:true,force:true});
  }
}
function fakeChild() {
  const child = new EventEmitter();
  child.stdout = new EventEmitter(); child.stderr = new EventEmitter(); child.stdin = new EventEmitter();
  child.stdin.write = message => { child.message = JSON.parse(message); };
  child.kills = 0; child.kill = () => { child.kills++; };
  return child;
}
const tick = () => new Promise(resolve => setTimeout(resolve,20));

test('worker reuses its process, rejects simultaneous calls and releases idle GPU process', async () => {
  await withWorkerRuntime(async runtimeRoot => {
    let child, starts=0;
    const runtime = createLocalDetection({runtimeRoot,idleMs:30,spawnWorker(){starts++; child=fakeChild(); return child;}});
    try {
      const first = runtime.detect(image);
      await tick();
      await assert.rejects(runtime.detect(image),error => error.statusCode===409);
      const result = {width:1,height:1,regions:[]};
      child.stdout.emit('data',Buffer.from(JSON.stringify({id:child.message.id,result})+'\n'));
      assert.deepEqual(await first,result);
      const second = runtime.detect(image);
      await tick();
      child.stdout.emit('data',Buffer.from(JSON.stringify({id:child.message.id,result})+'\n'));
      await second;
      assert.equal(starts,1);
      await new Promise(resolve => setTimeout(resolve,50));
      assert.equal(child.kills,1);
    } finally { runtime.dispose(); }
  });
});

test('timeout kills local worker and leaves detection retryable; disposal prevents restart', async () => {
  await withWorkerRuntime(async runtimeRoot => {
    let child, starts=0;
    const runtime = createLocalDetection({runtimeRoot,timeoutMs:40,spawnWorker(){starts++; child=fakeChild(); return child;}});
    const keepAlive = setInterval(() => {},100);
    try {
      await assert.rejects(runtime.detect(image),/took too long/);
      assert.equal(child.kills,1);
      const retry = runtime.detect(image);
      await tick();
      assert.equal(starts,2);
      child.stdout.emit('data',Buffer.from(JSON.stringify({id:child.message.id,result:{regions:[]}})+'\n'));
      await retry;
      runtime.dispose();
      await assert.rejects(runtime.detect(image),/closed/);
      assert.equal(starts,2);
    } finally { clearInterval(keepAlive); runtime.dispose(); }
  });
});

test('worker protocol errors and process crashes reject requests without leaking workers', async () => {
  await withWorkerRuntime(async runtimeRoot => {
    let child;
    const runtime = createLocalDetection({runtimeRoot,spawnWorker(){child=fakeChild(); return child;}});
    try {
      const first = runtime.detect(image);
      await tick();
      child.stdout.emit('data',Buffer.from('not-json\n'));
      await assert.rejects(first,/invalid response/);
      assert.equal(child.kills,1);
      const second = runtime.detect(image);
      await tick();
      child.stderr.emit('data',Buffer.from('GPU unavailable'));
      child.emit('exit',1);
      await assert.rejects(second,/GPU unavailable/);
    } finally { runtime.dispose(); }
  });
});

test('local detection endpoint requires same origin and fresh token; generation stays disconnected', async () => {
  let calls = 0, disposed = false;
  const detection = {token:'test-local-token',status:async () => ({available:true,token:'test-local-token'}),detect:async value => {calls++; return {width:value.width,height:value.height,regions:[]};},dispose(){disposed=true;}};
  const server = createServer({detection});
  await new Promise(resolve => server.listen(0,'127.0.0.1',resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  const submit = (headers,body=JSON.stringify(image)) => fetch(base+'/api/local-detection',{method:'POST',headers,body});
  const headers = {'Origin':base,'Content-Type':'application/json','X-Asun-Detection-Token':detection.token};
  try {
    assert.equal((await (await fetch(base+'/api/local-detection/status')).json()).token,detection.token);
    assert.equal((await fetch(base+'/api/local-detection/status',{headers:{Origin:'https://outside.example'}})).status,403);
    assert.equal((await submit({...headers,Origin:'https://outside.example'})).status,403);
    assert.equal((await submit({...headers,Origin:'null'})).status,403);
    assert.equal((await submit({'Content-Type':'application/json'})).status,403);
    assert.equal((await submit({...headers,'X-Asun-Detection-Token':'old'})).status,403);
    assert.equal((await submit({...headers,'Content-Type':'text/plain'})).status,415);
    assert.equal((await submit(headers,'{bad')).status,400);
    assert.equal((await submit(headers,JSON.stringify({...image,source:'https://outside.example/photo.jpg'}))).status,400);
    assert.equal((await submit(headers,JSON.stringify({...image,width:1601}))).status,400);
    assert.equal((await submit(headers)).status,200);
    assert.equal(calls,1);
    assert.equal((await fetch(base+'/api/local-detection')).status,405);
    assert.equal((await fetch(base+'/api/local-detection/status',{method:'POST'})).status,405);
    assert.equal((await fetch(base+'/generate',{method:'POST'})).status,405);
    const tooLarge = await submit(headers,' '.repeat(MAX_DETECTION_BODY+1));
    assert.equal(tooLarge.status,413);
    assert.equal(calls,1);
    assert.equal(tooLarge.headers.get('access-control-allow-origin'),null);
  } finally { await new Promise(resolve => server.close(resolve)); }
  assert.equal(disposed,true);
});
