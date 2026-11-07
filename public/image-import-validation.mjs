export const MAX_ORIGINAL_FILE_BYTES=50*1024*1024;
const fail=(code,message)=>{throw Object.assign(new Error(message),{code});};

// Read entries synchronously while the drop still owns its DataTransfer data.
// A directory can appear in files as an extensionless, zero-byte File.
export function assertImageDropFiles(transfer){
  for(const item of Array.from(transfer?.items||[])){
    if(item.kind!=='file')continue;
    const readEntry=item.getAsEntry||item.webkitGetAsEntry;
    if(typeof readEntry!=='function')continue;
    let entry;
    try{entry=readEntry.call(item);}catch{continue;}
    if(entry?.isDirectory){
      const name=typeof entry.name==='string'&&entry.name?entry.name:'This item';
      fail('IMAGE_DROP_FOLDER',`${name} is a folder. Open it and choose the PNG, JPEG or WebP images inside.`);
    }
  }
}

// Explorer and other apps can expose an empty placeholder in FileList while
// the corresponding item or filesystem entry holds the readable photo.
// Capture every item now: DataTransfer becomes protected after drop returns.
export function captureDroppedImageFiles(transfer){
  assertImageDropFiles(transfer);
  const listed=Array.from(transfer?.files||[]),items=Array.from(transfer?.items||[]).filter(item=>item.kind==='file');
  const readable=file=>file&&Number.isFinite(file.size)&&file.size>0&&typeof file.slice==='function';
  const records=items.map(item=>{
    let file=null,entry=null;
    try{file=item.getAsFile?.();}catch{}
    try{const read=item.getAsEntry||item.webkitGetAsEntry;if(typeof read==='function')entry=read.call(item);}catch{}
    return {file,entry};
  });
  const slots=listed.length?listed.map((file,index)=>{
    const record=records.length===listed.length?records[index]:records.find(record=>record.file?.name===file.name||record.entry?.name===file.name);
    return {file:readable(file)?file:readable(record?.file)?record.file:file,entry:record?.entry};
  }):records;
  return Promise.all(slots.map(({file,entry})=>{
    if(readable(file)||!entry?.isFile||typeof entry.file!=='function')return file;
    return new Promise(resolve=>{
      let settled=false;
      const finish=value=>{if(settled)return;settled=true;clearTimeout(timer);resolve(readable(value)?value:file);};
      const timer=setTimeout(()=>finish(null),5000);
      try{entry.file(finish,()=>finish(null));}catch{finish(null);}
    });
  })).then(files=>files.filter(Boolean));
}

export function validateImageFile(file){
  if(!file||typeof file.name!=='string'||!file.name||file.name.length>500)fail('IMAGE_FILE_NAME','Choose an image with a filename up to 500 characters.');
  if(!Number.isFinite(file.size)||file.size<0)fail('IMAGE_FILE_UNAVAILABLE',`${file.name}: this is not a readable image file. Choose a PNG, JPEG or WebP image.`);
  if(file.size===0)fail('IMAGE_FILE_EMPTY',`${file.name}: this file is empty (0 bytes). Choose a non-empty PNG, JPEG or WebP image.`);
  if(file.size>MAX_ORIGINAL_FILE_BYTES){
    const megabytes=(Math.ceil(file.size/(1024*1024)*10)/10).toFixed(1);
    fail('IMAGE_FILE_TOO_LARGE',`${file.name}: this image is ${megabytes} MB. Choose an image under 50 MB.`);
  }
  if(typeof file.slice!=='function'||typeof file.arrayBuffer!=='function')fail('IMAGE_FILE_UNAVAILABLE',`${file.name}: this is not a readable image file. Choose a PNG, JPEG or WebP image.`);
}
