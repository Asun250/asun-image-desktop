import {test} from 'node:test';
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {zipReferencePages,zipFiles,validateZipPath} from '../public/reference-download.mjs';

// Python's standard ZIP reader independently validates CRCs and archive structure.
function readZip(bytes) {
  const script=`import sys,io,zipfile,json,base64
archive=zipfile.ZipFile(io.BytesIO(sys.stdin.buffer.read()))
bad=archive.testzip()
if bad is not None: raise RuntimeError('CRC check failed for '+bad)
entries=[]
for info in archive.infolist():
 entries.append({'name':info.filename,'crc':info.CRC,'size':info.file_size,'storedSize':info.compress_size,'method':info.compress_type,'flags':info.flag_bits,'offset':info.header_offset,'date':list(info.date_time),'bytes':base64.b64encode(archive.open(info).read()).decode('ascii')})
print(json.dumps(entries))`;
  return JSON.parse(execFileSync('python',['-c',script],{input:Buffer.from(bytes),encoding:'utf8',stdio:['pipe','pipe','pipe'],maxBuffer:4*1024*1024}));
}
const png=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg==','base64');

test('independent ZIP reader preserves page names and exact payloads, including UTF-8 and empty files',async()=>{
  const files=[{name:'Scene - page 1.png',blob:new Blob([png],{type:'image/png'})},{name:'Scene café 東京 - page 2.png',blob:new Blob(['123456789'])},{name:'Scene - page 3.png',blob:new Blob([])}];
  const archive=await zipReferencePages(files),bytes=new Uint8Array(await archive.arrayBuffer()),entries=readZip(bytes);
  assert.equal(archive.type,'application/zip');assert.deepEqual(entries.map(entry=>entry.name),files.map(file=>file.name));
  assert.deepEqual(entries.map(entry=>Buffer.from(entry.bytes,'base64')),[png,Buffer.from('123456789'),Buffer.alloc(0)]);
  assert.equal(entries[1].crc,0xcbf43926,'Known CRC-32 fixture verifies the checksum polynomial');assert.equal(entries[2].crc,0);
  for(const entry of entries){assert.equal(entry.method,0);assert.equal(entry.size,entry.storedSize);assert.equal(entry.flags&0x800,0x800);assert.deepEqual(entry.date,[1980,1,1,0,0,0]);}
});
test('local and central headers describe the same ordered pages and directory offsets',async()=>{
  const files=[{name:'page 1.png',blob:new Blob([new Uint8Array([0,255,8,42])])},{name:'page 2.png',blob:new Blob([new Uint8Array([3,2,1])])}],archive=await zipReferencePages(files),bytes=new Uint8Array(await archive.arrayBuffer()),view=new DataView(bytes.buffer),entries=readZip(bytes),encoder=new TextEncoder();
  let offset=0;
  for(const [index,entry] of entries.entries()){
    const name=encoder.encode(files[index].name);assert.equal(view.getUint32(offset,true),0x04034b50);assert.equal(view.getUint16(offset+4,true),20);assert.equal(view.getUint16(offset+6,true),0x800);assert.equal(view.getUint16(offset+8,true),0);assert.equal(view.getUint32(offset+14,true),entry.crc);assert.equal(view.getUint32(offset+18,true),entry.size);assert.equal(view.getUint32(offset+22,true),entry.size);assert.equal(view.getUint16(offset+26,true),name.length);assert.equal(view.getUint16(offset+28,true),0);assert.deepEqual(bytes.slice(offset+30,offset+30+name.length),name);assert.equal(entry.offset,offset);
    offset+=30+name.length+entry.size;
  }
  const directoryOffset=offset;
  for(const [index,entry] of entries.entries()){
    const name=encoder.encode(files[index].name);assert.equal(view.getUint32(offset,true),0x02014b50);assert.equal(view.getUint16(offset+8,true),0x800);assert.equal(view.getUint16(offset+10,true),0);assert.equal(view.getUint32(offset+16,true),entry.crc);assert.equal(view.getUint32(offset+20,true),entry.size);assert.equal(view.getUint32(offset+24,true),entry.size);assert.equal(view.getUint32(offset+42,true),entry.offset);assert.deepEqual(bytes.slice(offset+46,offset+46+name.length),name);offset+=46+name.length;
  }
  assert.equal(view.getUint32(offset,true),0x06054b50);assert.equal(view.getUint16(offset+8,true),files.length);assert.equal(view.getUint16(offset+10,true),files.length);assert.equal(view.getUint32(offset+12,true),offset-directoryOffset);assert.equal(view.getUint32(offset+16,true),directoryOffset);assert.equal(bytes.length,offset+22);
});
test('independent reader detects a corrupted stored page through CRC validation',async()=>{
  const archive=await zipReferencePages([{name:'page.png',blob:new Blob([png])}]),bytes=new Uint8Array(await archive.arrayBuffer()),nameLength=new DataView(bytes.buffer).getUint16(26,true);
  bytes[30+nameLength+5]^=0xff;
  assert.throws(()=>readZip(bytes),/CRC check failed/);
});
test('invalid, ambiguous and lossy names are rejected before creating an archive',async()=>{
  await assert.rejects(zipReferencePages([]),/no reference pages/);
  for(const name of ['', '../page.png','folder/page.png','folder\\page.png','page\0.png','page\n.png','.','..','bad\ud800.png'])await assert.rejects(zipReferencePages([{name,blob:new Blob(['x'])}]),/Invalid reference page/);
  await assert.rejects(zipReferencePages([null]),/Invalid reference page/);
  await assert.rejects(zipReferencePages([{name:'page.png',blob:new Blob(['first'])},{name:'page.png',blob:new Blob(['second'])}]),/must be unique/);
  await assert.rejects(zipReferencePages([{name:'é'.repeat(32768),blob:new Blob([])}]),/filename is too long/);
});

test('generic ZIP subpaths extract as exact UTF-8 payloads with independently verified CRCs',async()=>{
  const files=[{name:'originals/main/MAIN.jpg',blob:new Blob([new Uint8Array([255,216,255,0,128,42])])},{name:'originals/references/東京 café/photo.webp',blob:new Blob(['123456789'])},{name:'mapping.json',blob:new Blob(['{}\n'])}];
  const bytes=await(await zipFiles(files)).arrayBuffer(),entries=readZip(bytes);assert.deepEqual(entries.map(entry=>entry.name),files.map(file=>file.name));for(const [index,entry]of entries.entries())assert.deepEqual(Buffer.from(entry.bytes,'base64'),Buffer.from(await files[index].blob.arrayBuffer()));assert.equal(entries[1].crc,0xcbf43926);assert.ok(entries.every(entry=>entry.method===0&&entry.flags&0x800));
});

test('generic ZIP rejects traversal, Windows unsafe paths and file/folder aliasing before reading blobs',async()=>{
  let reads=0;class ObservedBlob extends Blob{stream(){reads++;return super.stream();}}const blob=new ObservedBlob(['payload']);
  const invalid=['/absolute.png','C:/absolute.png','../outside.png','folder/../outside.png','folder/./photo.png','folder//photo.png','folder/','folder\\photo.png','folder/CON.png','aux.jpg','folder/LPT9','folder/COM¹.png','folder/name.','folder/name ','folder/<name>.png','folder/a:b.png','folder/a?b.png','folder/a|b.png','folder/a\u0085b.png','bad\ud800.png','a'.repeat(256)];
  for(const name of invalid){assert.throws(()=>validateZipPath(name),/ZIP/);await assert.rejects(zipFiles([{name:'valid/first.bin',blob},{name,blob}]),/ZIP/);}assert.equal(reads,0,'Invalid late paths are rejected before any source payload is read');
  for(const names of [['A.png','a.png'],['café.png','cafe\u0301.png'],['file','file/child.png'],['FILE/child.png','file']])await assert.rejects(zipFiles(names.map(name=>({name,blob}))),/unique|conflict/);assert.equal(reads,0);
});

test('flat reference-page API still rejects subpaths while generic ZIP accepts safe segments',async()=>{
  await assert.rejects(zipReferencePages([{name:'folder/page.png',blob:new Blob(['page'])}]),/Invalid reference page/);assert.equal(validateZipPath('originals/references/1/CONtrast.png'),'originals/references/1/CONtrast.png');assert.equal(validateZipPath('originals/references/葉っぱ/Photo.PNG'),'originals/references/葉っぱ/Photo.PNG');await assert.rejects(zipFiles([]),/no files/);
});
