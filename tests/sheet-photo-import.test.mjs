import test from 'node:test';
import assert from 'node:assert/strict';
import {publicImageAddress,resolveImageURL,importSheetWebPhoto} from '../sheet-photo-import.mjs';
import {createServer} from '../server.mjs';

const png=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jv18AAAAASUVORK5CYII=','base64');
test('web imports reject local, private, metadata, documentation and mapped addresses',()=>{
  for(const ip of ['0.0.0.0','10.1.2.3','127.0.0.1','100.100.100.200','169.254.169.254','172.16.1.2','172.31.255.255','192.168.1.1','192.0.2.1','198.18.0.1','198.51.100.1','203.0.113.2','224.1.2.3','255.255.255.255','::1','::','fe80::1','fc00::1','::ffff:127.0.0.1','64:ff9b::a00:1','2001:db8::1','2001:0:4136:e378::1','2002:a00:1::1','3fff::1'])assert.equal(publicImageAddress(ip),false,ip);
  for(const ip of ['8.8.8.8','93.184.216.34','172.15.255.255','172.32.0.1','2001:4860:4860::8888','2606:4700:4700::1111'])assert.equal(publicImageAddress(ip),true,ip);
});
test('URL validation rejects protocols, credentials, local names, hidden IP forms and private DNS answers',async()=>{
  for(const url of ['file:///C:/secret.png','ftp://example.com/a.png','https://user:pass@example.com/a.png','http://localhost/a.png','https://printer.local/a.png','http://2130706433/a.png','http://0x7f000001/a.png','https://example.com:8080/a.png','https://[::1]/a.png'])await assert.rejects(resolveImageURL(url,async()=>[{address:'8.8.8.8',family:4}]));
  await assert.rejects(resolveImageURL('https://photos.example/a.png',async()=>[{address:'8.8.8.8',family:4},{address:'10.0.0.1',family:4}]),/private/);
  const target=await resolveImageURL('https://photos.example/a.png',async()=>[{address:'8.8.8.8',family:4},{address:'2606:4700::1111',family:6}]);
  assert.equal(target.addresses.length,2);assert.equal(target.url.hostname,'photos.example');
});
test('a chosen public photo is validated and returned as exact original bytes',async()=>{
  const result=await importSheetWebPhoto('https://photos.example/Hotel%20view.png',{resolve:async value=>({url:new URL(value),addresses:[{address:'8.8.8.8',family:4}]}),request:async()=>({bytes:png})});
  assert.equal(result.name,'Hotel view.png');assert.equal(result.mimeType,'image/png');assert.deepEqual(Buffer.from(result.source.split(',')[1],'base64'),png);
});
test('every redirect is independently resolved before fetching and a private redirect is stopped',async()=>{
  const visited=[],requests=[];
  await assert.rejects(importSheetWebPhoto('https://photos.example/a',{resolve:async value=>{visited.push(value);return resolveImageURL(value,async()=>[{address:'8.8.8.8',family:4}]);},request:async target=>{requests.push(target.url.href);return {redirect:'http://169.254.169.254/credentials'};}}),/private/);
  assert.equal(visited.length,2);assert.equal(requests.length,1);
  let count=0;
  await assert.rejects(importSheetWebPhoto('https://photos.example/a',{resolve:async value=>({url:new URL(value),addresses:[]}),request:async()=>{count++;return {redirect:'/again'};}}),/too many/);assert.equal(count,4);
});
test('HTML and corrupt content never become imported images',async()=>{
  for(const bytes of [Buffer.from('<html><script>alert(1)</script></html>'),png.subarray(0,25)])await assert.rejects(importSheetWebPhoto('https://photos.example/a.png',{resolve:async value=>({url:new URL(value)}),request:async()=>({bytes})}));
});
test('the total deadline also bounds hanging DNS without starting an HTTP request',async()=>{
  let requested=false;
  await assert.rejects(importSheetWebPhoto('https://photos.example/a.png',{timeoutMs:10,resolve:()=>new Promise(()=>{}),request:async()=>{requested=true;return {bytes:png};}}),/could not be imported/);
  assert.equal(requested,false);
});
test('image import route requires same-origin JSON and passes only the explicit URL',async t=>{
  const seen=[],stub={dispose(){}};
  const server=createServer({detection:stub,sheets:stub,images:stub,photoImporter:async url=>{seen.push(url);return {name:'Photo.png',source:'data:image/png;base64,'+png.toString('base64')};}});
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));t.after(()=>new Promise(resolve=>server.close(resolve)));
  const base=`http://127.0.0.1:${server.address().port}`,url=base+'/api/sheet-photo-import';
  assert.equal((await fetch(url)).status,405);
  assert.equal((await fetch(url,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({url:'https://example.com/photo.png'})})).status,403);
  assert.equal((await fetch(url,{method:'POST',headers:{Origin:'https://evil.example','Content-Type':'application/json'},body:'{}'})).status,403);
  assert.equal((await fetch(url,{method:'POST',headers:{Origin:base,'Content-Type':'text/plain'},body:'{}'})).status,415);
  assert.equal((await fetch(url,{method:'POST',headers:{Origin:base,'Content-Type':'application/json'},body:JSON.stringify({url:'https://example.com/a.png',headers:{Authorization:'secret'}})})).status,400);
  assert.equal((await fetch(url,{method:'POST',headers:{Origin:base,'Content-Type':'application/json'},body:JSON.stringify({url:'x'.repeat(12000)})})).status,413);
  const good=await fetch(url,{method:'POST',headers:{Origin:base,'Content-Type':'application/json'},body:JSON.stringify({url:'https://example.com/photo.png'})});
  assert.equal(good.status,200);assert.deepEqual(seen,['https://example.com/photo.png']);
});
