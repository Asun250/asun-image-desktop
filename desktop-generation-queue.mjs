import {mkdir,readFile,writeFile,unlink,rename} from 'node:fs/promises';
import path from 'node:path';
import {randomUUID} from 'node:crypto';

const localLocks=new Map();
const error=(message,statusCode=503)=>Object.assign(new Error(message),{statusCode});
const delay=ms=>new Promise(resolve=>setTimeout(resolve,ms));
const alive=pid=>{if(!Number.isInteger(pid)||pid<=0)return false;try{process.kill(pid,0);return true;}catch{return false;}};

// The short lock covers admission, cancellation and the persisted transition
// to running. It is never held while waiting for an image provider response.
// Every worker sees the same running record before it can dispatch another job.
async function diskLock(directory,operation,lockWaitMs) {
  await mkdir(directory,{recursive:true});
  const filename=path.join(directory,'scheduler.lock'),reaper=filename+'.reaper',nonce=randomUUID(),started=Date.now();
  for(;;){
    try{await writeFile(filename,JSON.stringify({pid:process.pid,nonce}),{flag:'wx'});break;}
    catch(cause){
      if(cause.code!=='EEXIST')throw cause;
      let owner;try{owner=JSON.parse(await readFile(filename,'utf8'));}catch{await delay(20);if(Date.now()-started>lockWaitMs)throw error('The local generation queue lock could not be read. No request was sent.');continue;}
      if(!alive(owner.pid)){
        // Only one process may retire a dead lock. Never automatically retire
        // a second reaper lock: an uncertain filesystem recovery must stop
        // dispatch instead of risking two paid submissions.
        let ownsReaper=false;
        try{
          await writeFile(reaper,JSON.stringify({pid:process.pid,nonce}),{flag:'wx'});ownsReaper=true;
          let current;try{current=JSON.parse(await readFile(filename,'utf8'));}catch(cause){if(cause.code!=='ENOENT')throw cause;}
          if(current&&!alive(current.pid))await unlink(filename);
        }catch(cause){if(cause.code!=='EEXIST'&&cause.code!=='ENOENT')throw cause;}
        finally{if(ownsReaper)await unlink(reaper).catch(()=>{});}
      }
      if(Date.now()-started>lockWaitMs)throw error('The local generation queue is busy or needs recovery. No new request was sent.');
      await delay(20);
    }
  }
  try{return await operation();}
  finally{try{const current=JSON.parse(await readFile(filename,'utf8'));if(current.nonce===nonce)await unlink(filename);}catch{/* Keep a failed release visible for safe recovery. */}}
}

export function createGenerationQueue({directory,pollMs=1000,lockWaitMs=30000}={}) {
  if(typeof directory!=='string'||!directory)throw new Error('Choose a local generation queue directory.');
  directory=path.resolve(directory);
  const services=new Map();let disposed=false,enabled=false,pumping=false,timer=null,lastError='';
  function withLock(operation){
    const previous=localLocks.get(directory)||Promise.resolve(),pending=previous.catch(()=>{}).then(()=>diskLock(directory,operation,lockWaitMs));
    localLocks.set(directory,pending);
    return pending.finally(()=>{if(localLocks.get(directory)===pending)localLocks.delete(directory);});
  }
  async function records(){
    const groups=await Promise.all([...services.entries()].map(async([kind,service])=>(await service.scan()).map(value=>({...value,kind}))));
    return groups.flat();
  }
  const order=(a,b)=>(a.queueSequence??Number.MAX_SAFE_INTEGER)-(b.queueSequence??Number.MAX_SAFE_INTEGER)||(a.queuedAt||a.createdAt||'').localeCompare(b.queuedAt||b.createdAt||'')||a.kind.localeCompare(b.kind)||a.id.localeCompare(b.id);
  const waiting=items=>items.filter(value=>value.status==='queued').sort(order);
  function schedule(){if(disposed||!enabled||timer)return;timer=setTimeout(()=>{timer=null;void pump();},pollMs);timer.unref?.();}
  async function pump(){
    if(disposed||!enabled||pumping)return;pumping=true;
    try{
      for(;;){
        if(disposed)break;
        const run=await withLock(async()=>{
          const all=await records();
          if(all.some(value=>value.status==='running'))return null;
          const next=waiting(all)[0];if(!next)return null;
          return services.get(next.kind).dispatch(next.id);
        });
        // A successful scan also clears an earlier recovery error when the
        // last queued job was cancelled or another worker already ran it.
        lastError='';if(!run)break;
        await run.completion;
      }
    }catch(cause){lastError=String(cause?.message||'The local generation queue could not advance.').slice(0,700);}
    finally{pumping=false;schedule();}
  }
  function wake(){if(disposed)return;enabled=true;if(timer){clearTimeout(timer);timer=null;}void pump();}
  return {
    directory,withLock,
    register(kind,service){if(!['image','sheet'].includes(kind)||services.has(kind))throw new Error('Register each image queue service once.');services.set(kind,service);},
    async admit(operation){
      return withLock(async()=>{
        const file=path.join(directory,'sequence.json');let previous=0;
        try{previous=JSON.parse(await readFile(file,'utf8')).sequence;}catch(cause){if(cause.code!=='ENOENT')throw error('The local generation queue sequence is invalid. No request was sent.');}
        if(!Number.isSafeInteger(previous)||previous<0||previous>=Number.MAX_SAFE_INTEGER)throw error('The local generation queue sequence is invalid. No request was sent.');
        const sequence=previous+1,temp=file+'.'+randomUUID()+'.tmp';
        try{await writeFile(temp,JSON.stringify({sequence}),{flag:'wx'});await rename(temp,file);}finally{await unlink(temp).catch(()=>{});}
        return operation(sequence);
      });
    },
    wake,
    resume(){wake();},
    async position(kind,id){const items=waiting(await records()),index=items.findIndex(value=>value.kind===kind&&value.id===id);return index<0?null:index+1;},
    async status(){
      const all=await records(),queued=waiting(all),positions=new Map(queued.map((value,index)=>[value.kind+':'+value.id,index+1]));
      const running=all.filter(value=>value.status==='running').sort(order),finished=all.filter(value=>!['queued','running'].includes(value.status)).sort((a,b)=>(b.finishedAt||b.createdAt||'').localeCompare(a.finishedAt||a.createdAt||'')||b.id.localeCompare(a.id)).slice(0,20);
      const counts={queued:0,running:0,completed:0,failed:0,cancelled:0,expired:0};for(const value of all)if(Object.hasOwn(counts,value.status))counts[value.status]++;
      const items=[];for(const value of [...running,...queued,...finished])items.push(await services.get(value.kind).summarize(value,{queuePosition:positions.get(value.kind+':'+value.id)??null}));
      return {items,counts,concurrency:1,message:lastError};
    },
    dispose(){disposed=true;enabled=false;if(timer)clearTimeout(timer);timer=null;},
  };
}
