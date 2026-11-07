import {test} from 'node:test';
import assert from 'node:assert/strict';
import {assertImageDropFiles,captureDroppedImageFiles,validateImageFile,MAX_ORIGINAL_FILE_BYTES} from '../public/image-import-validation.mjs';

test('empty, unavailable and oversized files get different truthful import errors',()=>{
  assert.throws(()=>validateImageFile(new File([],'Blender blockout')),error=>error.code==='IMAGE_FILE_EMPTY'&&/empty \(0 bytes\)/.test(error.message)&&!/50 MB/.test(error.message));
  for(const value of [{name:'Blender blockout'},{name:'x',size:NaN},{name:'x',size:-1},{name:'x',size:8,source:'not a File'}]){
    assert.throws(()=>validateImageFile(value),error=>error.code==='IMAGE_FILE_UNAVAILABLE'&&/not a readable image file/.test(error.message));
  }
  assert.throws(()=>validateImageFile({name:'Large.png',size:MAX_ORIGINAL_FILE_BYTES+1}),error=>error.code==='IMAGE_FILE_TOO_LARGE'&&/50\.1 MB/.test(error.message)&&/under 50 MB/.test(error.message));
});

test('valid extensionless files and the existing exact size boundary remain accepted',()=>{
  validateImageFile(new File(['image data'],'Blender blockout'));
  validateImageFile({name:'Boundary.png',size:MAX_ORIGINAL_FILE_BYTES,slice(){},arrayBuffer(){}});
  assert.throws(()=>validateImageFile(new File(['data'],'x'.repeat(501))),/filename up to 500/);
});

test('directory entries are rejected synchronously, including folders mixed with photos',()=>{
  for(const method of ['getAsEntry','webkitGetAsEntry']){
    const photo={kind:'file',[method](){return {isDirectory:false,name:'photo.png'};}};
    const folder={kind:'file',[method](){assert.equal(this,folder);return {isDirectory:true,name:'Blender blockout'};}};
    assert.throws(()=>assertImageDropFiles({items:[photo,folder]}),error=>error.code==='IMAGE_DROP_FOLDER'&&/Blender blockout is a folder/.test(error.message)&&!/50 MB/.test(error.message));
  }
});

test('missing or unsupported entry APIs use ordinary file validation without guessing folders',()=>{
  assertImageDropFiles(null);
  assertImageDropFiles({items:[{kind:'string'},{kind:'file'},{kind:'file',webkitGetAsEntry(){return null;}},{kind:'file',getAsEntry(){throw new Error('Not available');}}]});
  assertImageDropFiles({items:[{kind:'file',webkitGetAsEntry(){return {isDirectory:false,name:'Blender blockout'};}}]});
});

test('drop recovers an empty FileList placeholder from its real item and captures before transfer expires',async()=>{
  const photo=new File(['original bytes'],'Blender blockout',{type:'image/png'}),transfer={files:[new File([],'Blender blockout')],items:[{kind:'file',getAsFile:()=>photo}]};
  const pending=captureDroppedImageFiles(transfer);transfer.files=[];transfer.items=[];
  const [recovered]=await pending;assert.equal(recovered,photo);assert.equal(await recovered.text(),'original bytes');
});

test('drop recovers a delayed filesystem entry while preserving other files and their order',async()=>{
  const first=new File(['first'],'A.png'),second=new File(['second'],'B.png');
  const pending=captureDroppedImageFiles({files:[first,new File([],'B.png')],items:[{kind:'file',getAsFile:()=>first},{kind:'file',getAsFile:()=>null,webkitGetAsEntry(){return {isFile:true,file(resolve){setTimeout(()=>resolve(second),5);}};}}]});
  assert.deepEqual(await pending,[first,second]);
});

test('failed entry recovery keeps the empty file for an honest error instead of dropping a batch member',async()=>{
  const empty=new File([],'B.png'),valid=new File(['A'],'A.png');
  const files=await captureDroppedImageFiles({files:[valid,empty],items:[{kind:'file',getAsFile:()=>valid},{kind:'file',webkitGetAsEntry(){return {isFile:true,file(_ok,fail){fail(new Error('Unavailable'));}};}}]});
  assert.deepEqual(files,[valid,empty]);assert.throws(()=>validateImageFile(files[1]),/empty \(0 bytes\)/);
});
