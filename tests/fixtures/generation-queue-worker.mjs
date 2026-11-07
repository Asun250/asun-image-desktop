// This worker never contacts a provider: its mock uses a cross-process lock to
// fail if two schedulers ever enter the paid-request boundary concurrently.
import {writeFile,appendFile,unlink} from 'node:fs/promises';
import path from 'node:path';
import {createGenerationQueue} from '../../desktop-generation-queue.mjs';
import {createDesktopSheetService,SHEET_MODELS} from '../../desktop-sheet-service.mjs';
import {prepareImageRequest} from '../../desktop-image-request.mjs';
const root=process.argv[2],pause=ms=>new Promise(resolve=>setTimeout(resolve,ms));
const pixel='iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a7x8AAAAASUVORK5CYII=';
const json=value=>new Response(JSON.stringify(value),{headers:{'Content-Type':'application/json'}});
const queue=createGenerationQueue({directory:path.join(root,'queue'),pollMs:10});
const fetchImpl=async(url,init={})=>{
  if(url.endsWith('/models'))return json({data:SHEET_MODELS.map(model=>({id:model.id}))});
  const lock=path.join(root,'provider-active');await writeFile(lock,String(process.pid),{flag:'wx'});
  try{const prompt=typeof init.body==='string'?JSON.parse(init.body).prompt:init.body.get('prompt');await appendFile(path.join(root,'provider-log.jsonl'),JSON.stringify({pid:process.pid,prompt})+'\n');await pause(55);return json({data:[{b64_json:pixel}]});}
  finally{await unlink(lock);}
};
const common={queue,getKey:()=> 'sk-mocked-cross-process-only',fetchImpl};
const images=createDesktopSheetService({...common,label:'image',prepareRequest:prepareImageRequest,directory:path.join(root,'images')});
const sheets=createDesktopSheetService({...common,directory:path.join(root,'sheets')});
process.send('ready');await new Promise(resolve=>process.once('message',resolve));queue.resume();
try{
  let complete=false;
  for(let index=0;index<600;index++){const status=await queue.status();if(status.counts.failed)throw new Error(JSON.stringify(status));if(status.counts.completed===3){complete=true;break;}await pause(10);}
  if(!complete)throw new Error('The cross-process queue timed out.');
}finally{queue.dispose();images.dispose();sheets.dispose();process.disconnect();}
