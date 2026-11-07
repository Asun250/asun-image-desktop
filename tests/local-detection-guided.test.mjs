import {test} from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {mkdtemp,mkdir,writeFile,rm} from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {createServer} from '../server.mjs';
import {createLocalDetection,validateDetectionInput} from '../local-sam.mjs';

const image={width:320,height:240,source:'data:image/png;base64,aGVsbG8='};
const guided={...image,prompt:{box:[31.5,20,210.25,198]}};

test('guided detection accepts image-local boxes and isolates validated prompt data',()=>{
  const validated=validateDetectionInput(guided);
  assert.deepEqual(validated,guided);
  assert.notEqual(validated.prompt,guided.prompt);
  assert.notEqual(validated.prompt.box,guided.prompt.box);
  validated.prompt.box[0]=0;
  assert.equal(guided.prompt.box[0],31.5);
  assert.deepEqual(validateDetectionInput({...image,prompt:{box:[0,0,320,240]}}).prompt.box,[0,0,320,240]);
  assert.deepEqual(validateDetectionInput(image),image);
});

test('guided detection rejects ambiguous prompts, invalid coordinates and out-of-image boxes',()=>{
  for(const prompt of [null,undefined,[],{},'box',{points:[[1,2]]},{box:[0,0,2,2],points:[]},{box:[0,0,2]},
    {box:[-1,0,2,2]},{box:[0,-1,2,2]},{box:[0,0,321,2]},{box:[0,0,2,241]},
    {box:[2,0,2,2]},{box:[0,2,2,2]},{box:[3,0,2,2]},{box:[0,3,2,2]},
    {box:['0',0,2,2]},{box:[false,0,2,2]},{box:[NaN,0,2,2]},
    {box:[0,0,Infinity,2]},{box:[0,0,2,-Infinity]}]){
    assert.throws(()=>validateDetectionInput({...image,prompt}),/box|bounding/i);
  }
});

async function withWorkerRuntime(run){
  const qaRoot=fileURLToPath(new URL('../qa/',import.meta.url));
  await mkdir(qaRoot,{recursive:true});
  const runtimeRoot=await mkdtemp(path.join(qaRoot,'guided-worker-test-'));
  try{
    for(const directory of ['env/Scripts','checkpoints','source/sam2'])await mkdir(path.join(runtimeRoot,directory),{recursive:true});
    for(const filename of ['env/Scripts/python.exe','checkpoints/sam2.1_hiera_base_plus.pt','source/sam2/build_sam.py'])await writeFile(path.join(runtimeRoot,filename),'');
    await writeFile(path.join(runtimeRoot,'runtime.json'),JSON.stringify({status:'installed'}));
    await run(runtimeRoot);
  }finally{
    assert.ok(path.resolve(runtimeRoot).startsWith(path.resolve(qaRoot)+path.sep));
    await rm(runtimeRoot,{recursive:true,force:true});
  }
}
const tick=()=>new Promise(resolve=>setTimeout(resolve,20));

test('guided boxes use the same offline worker, enforce mutual exclusion and leave automatic detection usable',async()=>{
  await withWorkerRuntime(async runtimeRoot=>{
    let child,starts=0;
    const runtime=createLocalDetection({runtimeRoot,spawnWorker(_executable,_arguments,options){
      starts++;assert.equal(options.windowsHide,true);assert.equal(options.env.HF_HUB_OFFLINE,'1');assert.equal(options.env.TRANSFORMERS_OFFLINE,'1');
      child=new EventEmitter();child.stdout=new EventEmitter();child.stderr=new EventEmitter();child.stdin=new EventEmitter();
      child.stdin.write=message=>{child.message=JSON.parse(message);};child.kill=()=>{};return child;
    }});
    try{
      const first=runtime.detect(guided);await tick();
      assert.deepEqual(child.message.prompt,guided.prompt);
      assert.equal((await runtime.status()).busy,true);
      await assert.rejects(runtime.detect(image),error=>error.statusCode===409);
      const result={width:320,height:240,regions:[{id:'guided-1'}]};
      child.stdout.emit('data',Buffer.from(JSON.stringify({id:child.message.id,result})+'\n'));
      assert.deepEqual(await first,result);
      const second=runtime.detect(image);await tick();
      assert.equal(Object.hasOwn(child.message,'prompt'),false);
      child.stdout.emit('data',Buffer.from(JSON.stringify({id:child.message.id,result:{width:320,height:240,regions:[]}})+'\n'));
      await second;assert.equal(starts,1);assert.equal((await runtime.status()).busy,false);
    }finally{runtime.dispose();}
  });
});

test('same-origin guided endpoint validates the box before dispatch and preserves its coordinates',async()=>{
  const received=[];
  const detection={token:'guided-local-token',status:async()=>({available:true,token:'guided-local-token'}),
    detect:async value=>{received.push(value);return{width:value.width,height:value.height,regions:[]};},dispose(){}};
  const server=createServer({detection});await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  const base=`http://127.0.0.1:${server.address().port}`;
  const headers={'Origin':base,'Content-Type':'application/json','X-Asun-Detection-Token':detection.token};
  const submit=(input,requestHeaders=headers)=>fetch(base+'/api/local-detection',{method:'POST',headers:requestHeaders,body:JSON.stringify(input)});
  try{
    assert.equal((await submit(guided,{...headers,Origin:'https://outside.example'})).status,403);
    assert.equal((await submit(guided,{...headers,'X-Asun-Detection-Token':'old'})).status,403);
    for(const prompt of [{box:[0,0,321,240]},{box:[0,0,0,20]},{box:[0,0,20,20],unknown:true},null]){
      assert.equal((await submit({...image,prompt})).status,400);
    }
    assert.equal(received.length,0);
    assert.equal((await submit(guided)).status,200);assert.deepEqual(received,[guided]);
    assert.equal((await submit(image)).status,200);assert.deepEqual(received[1],image);
  }finally{await new Promise(resolve=>server.close(resolve));}
});
