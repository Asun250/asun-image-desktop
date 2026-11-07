const crcTable=Uint32Array.from({length:256},(_,value)=>{for(let bit=0;bit<8;bit++)value=(value&1)?0xedb88320^(value>>>1):value>>>1;return value>>>0;});
async function blobCrc32(blob){let crc=0xffffffff;const reader=blob.stream().getReader();try{for(;;){const {value,done}=await reader.read();if(done)break;for(let index=0;index<value.length;index++)crc=crcTable[(crc^value[index])&255]^(crc>>>8);}}finally{reader.releaseLock();}return (crc^0xffffffff)>>>0;}
function header(size){const bytes=new Uint8Array(size);return {bytes,view:new DataView(bytes.buffer)};}
const folded=value=>value.normalize('NFC').toUpperCase();
export function isWindowsReservedName(segment){return /^(?:CON|PRN|AUX|NUL|COM[1-9\u00b9\u00b2\u00b3]|LPT[1-9\u00b9\u00b2\u00b3]|CONIN\$|CONOUT\$|CLOCK\$)$/i.test(segment.split('.')[0].replace(/[ .]+$/,''));}
export function validateZipPath(path){
  if(typeof path!=='string'||!path||/[\\<>:"|?*\x00-\x1f\x7f-\x9f]/.test(path)||path.startsWith('/')||new TextDecoder().decode(new TextEncoder().encode(path))!==path)throw new Error('Invalid ZIP file path.');
  for(const segment of path.split('/'))if(!segment||segment==='.'||segment==='..'||/[. ]$/.test(segment)||isWindowsReservedName(segment))throw new Error('Invalid ZIP file path segment.');else if(segment.length>255)throw new Error('The ZIP filename segment is too long.');
  if(new TextEncoder().encode(path).length>65535)throw new Error('The ZIP filename is too long.');
  return path;
}

// Store PNG pages without recompressing them. This downloads one archive even
// when a browser blocks multiple automatic file downloads from the same click.
export async function zipReferencePages(files){
  if(!Array.isArray(files)||!files.length)throw new Error('There are no reference pages to download.');
  if(files.length>65535)throw new Error('This collection is too large for one ZIP. Copy individual pages instead.');
  const encoder=new TextEncoder(),decoder=new TextDecoder(),names=new Set();
  for(const file of files){
    if(!file||!(file.blob instanceof Blob)||typeof file.name!=='string'||!file.name||/[\\/\x00-\x1f\x7f]/.test(file.name)||['.','..'].includes(file.name))throw new Error('Invalid reference page file.');
    const name=encoder.encode(file.name);if(name.length>65535)throw new Error('The reference page filename is too long.');
    if(decoder.decode(name)!==file.name)throw new Error('Invalid reference page filename.');
    if(names.has(file.name))throw new Error('Reference page filenames must be unique.');names.add(file.name);
  }
  return zipFiles(files);
}

// Stored entries retain each Blob's exact bytes. Validate every path and size
// before reading payloads, and stream checksums to avoid another full-size copy.
export async function zipFiles(files){
  if(!Array.isArray(files)||!files.length)throw new Error('There are no files to download.');
  if(files.length>65535)throw new Error('This collection is too large for one ZIP.');
  const encoder=new TextEncoder(),names=new Set(),folders=new Set(),prepared=[];let size=22;
  for(const file of files){
    if(!file||!(file.blob instanceof Blob))throw new Error('Invalid ZIP file.');
    validateZipPath(file.name);const key=folded(file.name),segments=key.split('/');
    if(names.has(key))throw new Error('ZIP filenames must be unique, including case and Unicode equivalents.');
    if(folders.has(key))throw new Error('ZIP file paths conflict with a folder.');
    for(let count=1;count<segments.length;count++){const folder=segments.slice(0,count).join('/');if(names.has(folder))throw new Error('ZIP file paths conflict with a folder.');folders.add(folder);}
    names.add(key);const name=encoder.encode(file.name);size+=30+46+name.length*2+file.blob.size;
    if(file.blob.size>0xffffffff||size>0xffffffff)throw new Error('This collection is too large for one ZIP.');
    prepared.push({...file,encodedName:name});
  }
  const parts=[],directory=[];let offset=0;
  for(const file of prepared){
    const name=file.encodedName,crc=await blobCrc32(file.blob),length=file.blob.size;
    const local=header(30),v=local.view;v.setUint32(0,0x04034b50,true);v.setUint16(4,20,true);v.setUint16(6,0x800,true);v.setUint16(12,0x21,true);v.setUint32(14,crc,true);v.setUint32(18,length,true);v.setUint32(22,length,true);v.setUint16(26,name.length,true);
    parts.push(local.bytes,name,file.blob);
    const central=header(46),c=central.view;c.setUint32(0,0x02014b50,true);c.setUint16(4,20,true);c.setUint16(6,20,true);c.setUint16(8,0x800,true);c.setUint16(14,0x21,true);c.setUint32(16,crc,true);c.setUint32(20,length,true);c.setUint32(24,length,true);c.setUint16(28,name.length,true);c.setUint32(42,offset,true);directory.push(central.bytes,name);
    offset+=30+name.length+length;
  }
  const directorySize=directory.reduce((total,bytes)=>total+bytes.length,0);
  if(offset+directorySize+22>0xffffffff)throw new Error('This collection is too large for one ZIP. Copy individual pages instead.');
  const end=header(22),v=end.view;v.setUint32(0,0x06054b50,true);v.setUint16(8,files.length,true);v.setUint16(10,files.length,true);v.setUint32(12,directorySize,true);v.setUint32(16,offset,true);
  return new Blob([...parts,...directory,end.bytes],{type:'application/zip'});
}
