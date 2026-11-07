import test from 'node:test';
import assert from 'node:assert/strict';
import {createDesktopImageSearch,commonsImageUrl} from '../desktop-image-search.mjs';
import {createServer} from '../server.mjs';

const png=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jv18AAAAASUVORK5CYII=','base64');
const json=(data,status=200)=>new Response(JSON.stringify(data),{status,headers:{'Content-Type':'application/json'}});
const record=(extra={})=>({title:'File:Hotel view.png',index:1,imageinfo:[{mime:'image/png',width:800,height:600,size:1024,url:'https://upload.wikimedia.org/wikipedia/commons/a/aa/Hotel.png',thumburl:'https://thumb.wikimedia.org/wikipedia/commons/thumb/a/aa/Hotel.png/320px-Hotel.png',descriptionurl:'https://commons.wikimedia.org/wiki/File:Hotel.png',extmetadata:{LicenseShortName:{value:'CC BY 4.0'},Artist:{value:'<b>A &amp; B</b>'}},...extra}]});

test('Commons search sends only typed query and offset, returns real result metadata and continuing pages',async()=>{
  const calls=[];
  const service=createDesktopImageSearch({fetchImpl:async(url,options)=>{calls.push({url,options});return json({query:{pages:[record()]},continue:{gsroffset:2018}});}});
  const result=await service.search('  Example hotel  ',{page:2000}),sent=new URL(calls[0].url);
  assert.equal(sent.origin,'https://commons.wikimedia.org');assert.equal(sent.searchParams.get('gsrsearch'),'Example hotel filetype:bitmap');assert.equal(sent.searchParams.get('gsroffset'),'2000');assert.equal(sent.searchParams.get('gsrlimit'),'18');
  assert.equal(calls[0].options.credentials,'omit');assert.equal(calls[0].options.redirect,'error');assert.equal(Object.keys(calls[0].options.headers).some(key=>/cookie|authorization/i.test(key)),false);
  assert.equal(result.provider,'Wikimedia Commons');assert.equal(result.nextPage,2018);assert.equal(result.images.length,1);
  const image=result.images[0];assert.equal(image.title,'Hotel view.png');assert.equal(image.artist,'A & B');assert.equal(image.license,'CC BY 4.0');assert.equal(image.width,800);assert.equal(image.imageUrl,record().imageinfo[0].url);assert.match(image.thumbnailUrl,/^\/api\/image-search\/thumbnail\?id=[a-f0-9]{32}$/);
});

test('search validation rejects empty, oversized and invalid paging before contacting the provider',async()=>{
  let calls=0;const service=createDesktopImageSearch({fetchImpl:async()=>{calls++;return json({});}});
  for(const query of ['', '  ',null,42,'x'.repeat(251)])await assert.rejects(service.search(query));
  for(const page of [-1,1.5,NaN,Infinity,Number.MAX_SAFE_INTEGER+1,'2'])await assert.rejects(service.search('hotel',{page}));
  assert.equal(calls,0);
});

test('unsafe URLs, unsupported formats and oversized originals never become result handles',async()=>{
  for(const url of ['http://upload.wikimedia.org/wikipedia/commons/a.png','https://upload.wikimedia.org.evil.example/wikipedia/commons/a.png','https://user:pass@upload.wikimedia.org/wikipedia/commons/a.png','https://upload.wikimedia.org:444/wikipedia/commons/a.png','file:///C:/photo.png','http://127.0.0.1/a.png'])assert.throws(()=>commonsImageUrl(url));
  assert.throws(()=>commonsImageUrl('https://commons.wikimedia.org/wiki/Main_Page',{page:true}));
  assert.throws(()=>commonsImageUrl('https://upload.wikimedia.org/wikipedia/commons/thumb/a/aa/a.png/320px-a.png',{original:true}));
  const pages=[record({mime:'image/svg+xml'}),record({mime:'image/gif'}),record({width:9000}),record({width:8000,height:8000}),record({size:51*1024*1024}),record({url:'https://evil.example/image.png'}),record({thumburl:'http://localhost/a.png'}),record({descriptionurl:'javascript:alert(1)'}),record({thumburl:undefined}),record()];
  const service=createDesktopImageSearch({fetchImpl:async()=>json({query:{pages}})});
  assert.equal((await service.search('hotel')).images.length,1);
});

test('thumbnails fetch only recorded provider URLs, validate image bytes, expire and never fetch caller URLs',async()=>{
  let time=10,calls=0;
  const service=createDesktopImageSearch({now:()=>time,fetchImpl:async(url)=>{calls++;return String(url).startsWith('https://commons.wikimedia.org/')?json({query:{pages:[record()]}}):new Response(png,{headers:{'Content-Type':'image/png'}});}});
  const {images}=await service.search('hotel');
  for(const id of ['https://evil.example/photo.png','a'.repeat(32),'../api/status'])await assert.rejects(service.thumbnail(id),/expired/);
  assert.equal(calls,1);
  const preview=await service.thumbnail(images[0].id);assert.deepEqual(preview.bytes,png);assert.equal(preview.mimeType,'image/png');
  time+=16*60*1000;await assert.rejects(service.thumbnail(images[0].id),/expired/);assert.equal(calls,2);
});

test('provider outages, bad JSON, errors, oversized responses and corrupt thumbnails are explicit',async()=>{
  for(const reply of [()=>{throw new Error('offline');},()=>json({},503),()=>new Response('not JSON'),()=>json({error:{code:'badquery'}}),()=>json({query:{pages:{}}}),()=>new Response('large',{headers:{'Content-Length':String(3*1024*1024)}})]){
    const service=createDesktopImageSearch({fetchImpl:reply});await assert.rejects(service.search('hotel'),error=>error.statusCode===502);
  }
  const service=createDesktopImageSearch({fetchImpl:async url=>String(url).startsWith('https://commons.wikimedia.org/')?json({query:{pages:[record()]}}):new Response('<html>not an image</html>',{headers:{'Content-Type':'text/html'}})});
  const {images}=await service.search('hotel');await assert.rejects(service.thumbnail(images[0].id));
});

test('search handles empty results and continuation loops without fabricating another page',async()=>{
  for(const next of [undefined,null,'18',0,-1]){
    const service=createDesktopImageSearch({fetchImpl:async()=>json({continue:{gsroffset:next}})});
    const result=await service.search('no results');assert.deepEqual(result.images,[]);assert.equal(result.nextPage,null);
  }
});

test('search concurrency is bounded and disposal prevents future network requests',async()=>{
  let release;const pending=new Promise(resolve=>{release=resolve;}),service=createDesktopImageSearch({fetchImpl:async()=>{await pending;return json({});}});
  const first=service.search('a'),second=service.search('b');await assert.rejects(service.search('c'),error=>error.statusCode===429);release();await Promise.all([first,second]);service.dispose();await assert.rejects(service.search('d'),/Reopen/);
});

test('HTTP search routes stay local, reject cross-site requests and proxy only issued thumbnail handles',async t=>{
  const seen=[],stub={dispose(){}},imageSearch={dispose(){},async search(q,options){seen.push({q,...options});return {provider:'Wikimedia Commons',images:[],nextPage:null};},async thumbnail(id){if(id!=='a'.repeat(32))throw Object.assign(new Error('expired'),{statusCode:404});return {bytes:png,mimeType:'image/png'};}};
  const server=createServer({detection:stub,sheets:stub,images:stub,imageSearch});await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));t.after(()=>new Promise(resolve=>server.close(resolve)));
  const base=`http://127.0.0.1:${server.address().port}`,url=base+'/api/image-search?q=hotel&page=18';
  assert.equal((await fetch(url,{headers:{Origin:'https://evil.example'}})).status,403);assert.equal((await fetch(url,{headers:{'Sec-Fetch-Site':'same-site'}})).status,403);assert.equal((await fetch(url,{method:'POST'})).status,405);
  assert.equal((await fetch(base+'/api/image-search?q=hotel&page=-1')).status,400);assert.equal((await fetch(base+'/api/image-search?q=hotel&url=https://evil.example')).status,400);
  const result=await fetch(url,{headers:{Origin:base}});assert.equal(result.status,200);assert.deepEqual(seen,[{q:'hotel',page:18}]);assert.match(result.headers.get('content-security-policy'),/img-src 'self' data: blob:/);
  assert.equal((await fetch(base+'/api/image-search/thumbnail?id=unknown')).status,404);assert.equal((await fetch(base+'/api/image-search/thumbnail?id='+'a'.repeat(32)+'&url=https://evil.example')).status,400);
  const preview=await fetch(base+'/api/image-search/thumbnail?id='+'a'.repeat(32));assert.equal(preview.status,200);assert.equal(preview.headers.get('content-type'),'image/png');assert.deepEqual(Buffer.from(await preview.arrayBuffer()),png);
  assert.equal((await fetch(base+'/api/image-search/unknown')).status,404);
});
