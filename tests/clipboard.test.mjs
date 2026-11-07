import {test} from 'node:test';
import assert from 'node:assert/strict';
import {chromium} from 'playwright';
import {createServer} from '../server.mjs';
import {clipboardImageFiles,readClipboardImages,MAX_EMBEDDED_IMAGE_BYTES,MAX_CLIPBOARD_HTML_LENGTH} from '../public/clipboard.mjs';

const file = (bytes,type='image/png',name='clipboard.png') => new File([new Uint8Array(bytes)],name,{type,lastModified:123});
const bytes = async image => Array.from(new Uint8Array(await image.arrayBuffer()));
const transfer = (files=[],items=[],html='',plain='') => ({files,items,getData:type => type === 'text/html' ? html : plain});

test('paste uses one binary representation and preserves original bytes and separate images',async () => {
  const first=file([0,255,8,42]),second=file([1,254,9,43]);
  const items=[first,second].map(image => ({kind:'file',type:image.type,getAsFile:()=>image}));
  const images=clipboardImageFiles({...transfer([first,second],items),getData(){throw new Error('Binary paste must not parse HTML');}});
  assert.equal(images.length,2,'Files and matching file items are not imported twice');
  assert.deepEqual(images.map(image=>image.name),['Pasted image.png','Pasted image 2.png']);
  assert.deepEqual(await bytes(images[0]),[0,255,8,42]);
  assert.deepEqual(await bytes(images[1]),[1,254,9,43]);
  assert.equal(images[0].type,'image/png');
  assert.equal(first.name,'clipboard.png','Original file metadata remains unchanged');
});
test('file items are a fallback when the event files list is empty',async () => {
  const jpeg=file([2,3,4],'image/jpeg','original.jpg');
  const images=clipboardImageFiles(transfer([], [{kind:'string',type:'text/plain'},{kind:'file',getAsFile:()=>null},{kind:'file',getAsFile:()=>jpeg}]));
  assert.equal(images.length,1);assert.equal(images[0].name,'Pasted image.jpg');
  assert.deepEqual(await bytes(images[0]),[2,3,4]);
  const emptyMime=file([5,6],'','known.webp');
  assert.equal(clipboardImageFiles(transfer([emptyMime]))[0].type,'image/webp');
});
test('unsupported files, text-only and empty clipboard payloads give useful errors',() => {
  assert.throws(()=>clipboardImageFiles(null),/empty/);
  assert.throws(()=>clipboardImageFiles(transfer()),/empty/);
  assert.throws(()=>clipboardImageFiles(transfer([file([1],'image/gif','image.gif')])),/PNG, JPEG, or WebP/);
  assert.throws(()=>clipboardImageFiles(transfer([],[],'','https://example.com/image.png')),/Copy image.*browser.*ChatGPT/);
  assert.throws(()=>clipboardImageFiles(transfer([file([1],'text/plain','spoofed.png')])),/does not contain/);
});
test('clipboard read picks PNG once per item and preserves multiple supported images',async () => {
  const calls=[];
  const first={types:['text/html','image/jpeg','image/png'],getType:async type=>{calls.push(type);return new Blob([new Uint8Array([0,7,255])],{type});}};
  const second={types:['image/webp'],getType:async type=>{calls.push(type);return new Blob([new Uint8Array([3,2,1])],{type});}};
  const ignored={types:['text/plain'],getType:async()=>{throw new Error('Text must not be read');}};
  const images=await readClipboardImages({read:async()=>[first,ignored,second]});
  assert.deepEqual(calls,['image/png','image/webp']);
  assert.deepEqual(images.map(image=>[image.name,image.type]),[['Pasted image.png','image/png'],['Pasted image 2.webp','image/webp']]);
  assert.deepEqual(await bytes(images[0]),[0,7,255]);assert.deepEqual(await bytes(images[1]),[3,2,1]);
});
test('clipboard read reports unavailable/empty/unsupported data and preserves permission denials',async () => {
  await assert.rejects(readClipboardImages({}),/Ctrl\+V/);
  await assert.rejects(readClipboardImages({read:async()=>[]}),/empty/);
  await assert.rejects(readClipboardImages({read:async()=>[{types:['text/html']}]}),/does not contain/);
  const denied=new Error('Clipboard permission denied');denied.name='NotAllowedError';
  await assert.rejects(readClipboardImages({read:async()=>{throw denied;}}),error=>error===denied);
});
test('embedded size limits reject before DOM parsing or base64 decoding',() => {
  assert.throws(()=>clipboardImageFiles(transfer([],[],'x'.repeat(MAX_CLIPBOARD_HTML_LENGTH+1))),/HTML is too large/);
  const priorDocument=globalThis.document,priorAtob=globalThis.atob;
  let decoded=false;
  try {
    const source='data:image/png;base64,'+'A'.repeat(Math.ceil(MAX_EMBEDDED_IMAGE_BYTES/3)*4+4);
    globalThis.document={createElement:()=>({content:{querySelectorAll:()=>[{getAttribute:()=>source}]}})};
    globalThis.atob=()=>{decoded=true;throw new Error('Oversized payload must not be decoded');};
    assert.throws(()=>clipboardImageFiles(transfer([],[],'<img>')),/exceeds 50 MB/);
    assert.equal(decoded,false);
  } finally {
    if(priorDocument===undefined)delete globalThis.document;else globalThis.document=priorDocument;
    globalThis.atob=priorAtob;
  }
});
test('browser HTML fallback reads embedded image bytes, dedupes markup, and refuses URLs without requests',async () => {
  const server=createServer();let browser;
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  try {
    browser=await chromium.launch({headless:true});const page=await browser.newPage();
    await page.goto(`http://127.0.0.1:${server.address().port}`);
    const requests=[];page.on('request',request=>{if(request.url().includes('clipboard-test.invalid'))requests.push(request.url());});
    const result=await page.evaluate(async()=>{
      const {clipboardImageFiles}=await import('/clipboard.mjs');
      const png='data:image/png;base64,AP8IKg==',webp='data:image/webp;base64,AwIB';
      const html=`<script>window.clipboardMarkupExecuted=true</script><iframe src="https://clipboard-test.invalid/frame"></iframe><img src="https://clipboard-test.invalid/image.png"><img src="${png}"><img src="${png}"><img src="${webp}">`;
      const transfer=html=>({files:[],items:[{kind:'string',type:'text/html'}],getData:type=>type==='text/html'?html:''});
      const images=clipboardImageFiles(transfer(html));
      const values=await Promise.all(images.map(async image=>({name:image.name,type:image.type,bytes:Array.from(new Uint8Array(await image.arrayBuffer()))})));
      const errors=[];
      for(const markup of ['<img src="https://clipboard-test.invalid/image.png">','<img src="javascript:alert(1)">','<img src="data:image/svg+xml;base64,PHN2Zz4=">','<img src="data:image/png;base64,invalid***">']) {
        try{clipboardImageFiles(transfer(markup));}catch(error){errors.push(error.message);}
      }
      return {values,errors,executed:Boolean(window.clipboardMarkupExecuted)};
    });
    assert.deepEqual(result.values,[{name:'Pasted image.png',type:'image/png',bytes:[0,255,8,42]},{name:'Pasted image 2.webp',type:'image/webp',bytes:[3,2,1]}]);
    assert.equal(result.errors.length,4);for(const error of result.errors)assert.match(error,/does not contain/);
    assert.equal(result.executed,false,'Scripts in clipboard markup stay inert');
    assert.deepEqual(requests,[],'Pasted remote URLs are never fetched');
  } finally {if(browser)await browser.close();await new Promise(resolve=>server.close(resolve));}
});
