import {test,before,after} from 'node:test';
import assert from 'node:assert/strict';
import {chromium} from 'playwright';
import {createServer} from '../server.mjs';

let server,browser,base;
before(async()=>{
  server=createServer({images:{dispose(){}},sheets:{dispose(){}},detection:{dispose(){}}});
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  base=`http://127.0.0.1:${server.address().port}`;
  browser=await chromium.launch({headless:true});
});
after(async()=>{await browser?.close();if(server)await new Promise(resolve=>server.close(resolve));});

async function preview(t,mode,count=1){
  const context=await browser.newContext();t.after(()=>context.close());
  const page=await context.newPage();
  await page.route(base+'/auth-preview-fixture',route=>route.fulfill({contentType:'text/html',body:'<!doctype html><html><body><main id="preview"></main></body></html>'}));
  await page.goto(base+'/auth-preview-fixture');
  return page.evaluate(async({mode,count})=>{
    const {renderGenerationDetails}=await import('./generation-details.mjs');
    const png=Uint8Array.from(atob('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+j7fQAAAAASUVORK5CYII='),char=>char.charCodeAt(0));
    const attempts=[],record={id:'11111111-1111-4111-8111-111111111111',status:'completed',settings:{prompt:'Keep the exact original instructions.',inputs:Array.from({length:count},(_,i)=>({index:i+1,name:`Reference ${i+1}`,role:'original reference photo'}))}};
    let statusCalls=0;
    const json=(data,status=200)=>new Response(JSON.stringify(data),{status,headers:{'Content-Type':'application/json'}});
    const fetchImpl=async(url,options)=>{
      if(url.endsWith('/status')){
        statusCalls++;
        await new Promise(resolve=>setTimeout(resolve,25));
        return json({token:'renewed-token'});
      }
      const token=options.headers['x-asun-image-token'];attempts.push({url,token});
      if(mode==='denied')return json({error:'Provider account is not authorized.'},403);
      if(token==='old-token'||mode==='rejected-again')return json({code:'ASUN_LOCAL_TOKEN_EXPIRED',error:'Local session expired.'},403);
      return new Response(png,{headers:{'Content-Type':'image/png'}});
    };
    const mounted=renderGenerationDetails(document.getElementById('preview'),record,{kind:'image',token:'old-token',fetchImpl});
    await mounted.ready;
    const result={statusCalls,attempts,images:document.querySelectorAll('.generation-input-preview').length,states:[...document.querySelectorAll('.generation-input-state')].map(node=>node.textContent),prompt:document.querySelector('.generation-detail-prompt').value};
    mounted.dispose();return result;
  },{mode,count});
}

test('saved reference previews renew a stale token once across parallel images',async t=>{
  const result=await preview(t,'recover',3);
  assert.equal(result.statusCalls,1);assert.equal(result.images,3);assert.equal(result.attempts.length,6);
  assert.equal(result.attempts.filter(item=>item.token==='renewed-token').length,3);
  assert.equal(result.prompt,'Keep the exact original instructions.');assert.deepEqual(result.states,[]);
});
test('unrelated forbidden previews are reported without token retries',async t=>{
  const result=await preview(t,'denied');
  assert.equal(result.statusCalls,0);assert.equal(result.images,0);assert.equal(result.attempts.length,1);
  assert.match(result.states[0],/could not be loaded/);
});
test('preview authorization retry is bounded when renewal is rejected again',async t=>{
  const result=await preview(t,'rejected-again');
  assert.equal(result.statusCalls,1);assert.equal(result.images,0);assert.equal(result.attempts.length,2);
  assert.match(result.states[0],/could not be loaded/);
});
