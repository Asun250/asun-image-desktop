import {DEFAULT_GENERATION_QUALITY,generationQualityOptions,validateGenerationQuality,DEFAULT_GENERATION_COMPLEXITY,generationComplexityOptions,validateGenerationComplexity} from './generation-settings.mjs';
import {loadGenerationProject} from './generation-result-actions.mjs';
import {isLocalGenerationAuthError} from './local-generation-auth.mjs';

const liveStatuses=new Set(['queued','running','submission-unknown']);
const terminalStatuses=new Set(['completed','failed','cancelled','unknown','expired']);
const finishedTime=record=>Date.parse(record?.finishedAt||record?.createdAt||record?.queuedAt||'')||0;
// Queue entries retain metadata only. Only the latest result keeps image bytes.
function compact(record) {
  const keys=['id','kind','mode','status','model','sourceName','queuePosition','queuedAt','createdAt','startedAt','finishedAt','cancellable','outputAvailable','outputCheck','sourceProjectAvailable','sourceProjectMessage','message','error','connectionError','uncertain'];
  const result=Object.fromEntries(keys.filter(key=>record[key]!==undefined).map(key=>[key,record[key]]));
  if(record.settings)result.settings=Object.fromEntries(['model','quality','complexity','size','outputFormat','background'].filter(key=>record.settings[key]!==undefined).map(key=>[key,record.settings[key]]));
  return result;
}

// Explicit clicks upload immutable requests. Waiting for outputs never locks
// the editor; API credentials stay in the local server.
export function createDesktopGeneration({editor,fetchImpl=globalThis.fetch,pollMs=1500,autoPoll=true,endpoint='/api/sheets',tokenHeader='x-asun-sheet-token',storageKey='asun.desktop.sheet.last-job.v1',kind='sheet',prepareInput=async project=>({project})}={}) {
  let connection=null,connectionRefresh=null,selectedModel='',selectedQuality=DEFAULT_GENERATION_QUALITY,selectedComplexity=DEFAULT_GENERATION_COMPLEXITY,working=false,result=null,lastRequestId=null,disposed=false,timer=null,polling=null,queueSupported=null,workflowIds=null,workflowVersion=0,recordsRevision=0;
  const records=new Map(),requests=new Map(),listeners=new Set(),ownedIds=new Set();
  const read=key=>{try{return localStorage.getItem(key);}catch{return null;}};
  const emit=event=>{if(disposed)return;for(const listener of listeners){try{listener(event);}catch{/* A view listener cannot change an accepted submission. */}}};
  selectedModel=read(storageKey+'.model')||'';selectedQuality=read(storageKey+'.quality')??DEFAULT_GENERATION_QUALITY;selectedComplexity=read(storageKey+'.complexity')??DEFAULT_GENERATION_COMPLEXITY;
  const active=()=>[...records.values()].filter(record=>liveStatuses.has(record.status));
  const uncertain=()=>active().find(record=>record.uncertain||record.status==='submission-unknown');
  const belongsToWorkflow=id=>workflowIds===null||workflowIds.includes(id);
  const contextJobs=()=>workflowIds===null?[...records.values()]:workflowIds.map(id=>records.get(id)).filter(Boolean);
  const contextResultId=()=>workflowIds===null?result?.id||null:contextJobs().filter(record=>record.status==='completed'&&record.outputAvailable!==false).sort((a,b)=>finishedTime(b)-finishedTime(a)||workflowIds.indexOf(b.id)-workflowIds.indexOf(a.id))[0]?.id||null;
  const contextResult=()=>result&&result.id===contextResultId()?result:null;
  function persist() {
    try {
      const stored=JSON.parse(localStorage.getItem(storageKey+'.jobs')||'[]');
      const merged=new Map((Array.isArray(stored)?stored:[]).filter(item=>item?.id&&!ownedIds.has(item.id)).map(item=>[item.id,item]));
      for(const record of active())merged.set(record.id,{id:record.id,status:record.status,uncertain:Boolean(record.uncertain)});
      localStorage.setItem(storageKey+'.jobs',JSON.stringify([...merged.values()]));
      if(lastRequestId)localStorage.setItem(storageKey,lastRequestId);
    }catch{/* In-memory IDs still prevent a duplicate when storage is disabled. */}
  }
  function restoreIds() {
    if(ownedIds.size)return;
    try{const saved=JSON.parse(read(storageKey+'.jobs')||'[]');for(const item of Array.isArray(saved)?saved:[])if(typeof item?.id==='string'){ownedIds.add(item.id);records.set(item.id,{id:item.id,kind,status:item.uncertain?'submission-unknown':'queued',uncertain:Boolean(item.uncertain)});}}catch{}
    lastRequestId=read(storageKey)||null;
    if(lastRequestId&&!records.has(lastRequestId)){ownedIds.add(lastRequestId);records.set(lastRequestId,{id:lastRequestId,kind,status:'queued'});}
  }
  function settingsError() {
    if(selectedModel&&connection?.authenticated&&!connection.models?.some(model=>model.id===selectedModel&&model.available))return 'The selected image model is unavailable. Choose an available model; no replacement was selected.';
    try{if(selectedModel){validateGenerationQuality(selectedModel,selectedQuality);if(generationComplexityOptions(selectedModel).length)validateGenerationComplexity(selectedModel,selectedComplexity);}return '';}catch(error){return error.message;}
  }
  async function json(url,options={}) {
    const response=await fetchImpl(url,{cache:'no-store',...options});let data;
    try{data=await response.json();}catch{throw new Error('The local image service did not respond. Check the generation queue before trying again.');}
    if(!response.ok)throw Object.assign(new Error(data.error||data.message||'The image request could not be completed.'),{status:response.status,code:data.code});
    return data;
  }
  async function refreshConnection(rejectedToken) {
    if(connectionRefresh)return connectionRefresh;
    // Another request may have renewed the token while this old response arrived.
    if(rejectedToken!==undefined&&connection?.token&&connection.token!==rejectedToken)return connection;
    connectionRefresh=(async()=>{connection=await json(endpoint+'/status');emit({type:'connection'});return connection;})();
    try{return await connectionRefresh;}finally{connectionRefresh=null;}
  }
  async function authenticatedJson(url,options={}) {
    const token=connection?.token||'';
    const attempt=currentToken=>json(url,{...options,headers:{...options.headers,[tokenHeader]:currentToken}});
    try{return await attempt(token);}catch(error){
      if(!isLocalGenerationAuthError(error))throw error;
      try{await refreshConnection(token);}catch(refreshError){
        throw Object.assign(new Error('Could not reconnect to the local image service. '+refreshError.message),{cause:refreshError,status:refreshError.status,code:refreshError.code,authRefreshFailed:true,preAdmissionRejected:options.method==='POST'});
      }
      // Retry only once, with the already serialized body and original request ID.
      // A lost retry response remains ambiguous and uses the normal ID recovery.
      return attempt(connection?.token||'');
    }
  }
  function trimRecords() {
    const recent=[...records.values()].filter(record=>!liveStatuses.has(record.status)).sort((a,b)=>finishedTime(b)-finishedTime(a)).slice(0,20);
    const keep=new Set([...active().map(record=>record.id),...recent.map(record=>record.id),...(workflowIds||[]),lastRequestId,result?.id]);
    for(const id of records.keys())if(!keep.has(id)){records.delete(id);ownedIds.delete(id);}
  }
  function accept(record,{notify=true,full=false}={}) {
    if(!record||typeof record.id!=='string'||(!liveStatuses.has(record.status)&&!terminalStatuses.has(record.status)))throw new Error('The local service returned an invalid generation status. Check the queue before generating again.');
    const previous=records.get(record.id);
    // A slow queue response may describe the state before a newer result GET.
    // Never turn a finished job back into queued/running or notify it twice.
    if(terminalStatuses.has(previous?.status)&&liveStatuses.has(record.status))return result?.id===record.id?result:previous;
    const next=compact({...previous,...record,kind:record.kind||record.mode||kind,uncertain:false,connectionError:undefined});
    if(full&&record.status==='completed') {
      if(!record.image?.source)throw new Error('The completed request has no image. Check the local result files.');
      if(belongsToWorkflow(record.id))result=record;
    }
    // Polling returns fresh objects even when every recorded field is unchanged.
    // Avoid repeating localStorage writes and rebuilding all subscribed views
    // once per historical job while a different tab is being edited.
    if(previous&&JSON.stringify(previous)===JSON.stringify(next)){trimRecords();return record;}
    ownedIds.add(record.id);records.set(record.id,next);recordsRevision++;
    if(lastRequestId===record.id&&['failed','cancelled','unknown','expired'].includes(record.status)) {
      lastRequestId=null;try{if(read(storageKey)===record.id)localStorage.removeItem(storageKey);}catch{}
    }
    persist();trimRecords();
    if(notify)emit({type:record.status==='completed'&&previous?.status!=='completed'?'completed':terminalStatuses.has(record.status)&&record.status!=='completed'&&previous?.status!==record.status?'failed':'status',record:next});
    return record;
  }
  async function refreshJob(id,{notify=true}={}) {
    if(typeof id!=='string'||!id)throw new Error('Choose a generation to check.');
    if(requests.has(id))return requests.get(id);
    const request=(async()=>{
      try {
        const record=await authenticatedJson(endpoint+'/jobs/'+encodeURIComponent(id));
        if(record.id!==id)throw new Error('The returned generation does not match the requested job.');
        return accept(record,{notify,full:true});
      }catch(error){
        const previous=records.get(id);
        if(error.status===404&&previous&&!previous.uncertain&&previous.status!=='submission-unknown')return accept({id,kind,status:'expired',message:'This earlier generation is no longer stored.'},{notify});
        if(previous){const next={...previous,connectionError:error.message};records.set(id,next);if(notify)emit({type:'connection-error',record:next});}
        throw error;
      }finally{requests.delete(id);}
    })();requests.set(id,request);return request;
  }
  async function refreshJobs({notify=true}={}) {
    if(polling)return polling;
    polling=(async()=>{
      let usedQueue=false,completedRecord=null;const listedIds=new Set(),previousRevision=recordsRevision;
      if(queueSupported!==false) {
        try {
          const queue=await authenticatedJson('/api/generation-queue/status');
          if(!Array.isArray(queue.items))throw new Error('The generation queue response is unavailable.');
          queueSupported=true;usedQueue=true;
          for(const item of queue.items) {
            if((item.kind||item.mode)!==kind)continue;
            listedIds.add(item.id);
            const previous=records.get(item.id);
            if(item.status==='completed'&&previous&&previous.status!=='completed'&&belongsToWorkflow(item.id)&&(!completedRecord||finishedTime(item)>finishedTime(completedRecord)))completedRecord=item;
            accept(item,{notify:notify&&Boolean(previous)});
          }
        }catch(error){if(isLocalGenerationAuthError(error)||error.authRefreshFailed)throw error;if(error.status===404||error.status===405)queueSupported=false;}
      }
      if(!usedQueue)await Promise.allSettled(active().map(record=>refreshJob(record.id,{notify})));
      else {
        // Recover lost upload responses using that exact ID, including requests
        // absent from the compact queue. No replacement POST is permitted.
        await Promise.allSettled(active().filter(record=>record.uncertain||!listedIds.has(record.id)).map(record=>refreshJob(record.id,{notify})));
        if(completedRecord)await refreshJob(completedRecord.id,{notify:false}).catch(()=>{});
      }
      if(recordsRevision!==previousRevision)emit({type:'queue',records:[...records.values()]});return [...records.values()];
    })();
    try{return await polling;}finally{polling=null;schedule();}
  }
  function schedule() {
    if(timer!==null){clearTimeout(timer);timer=null;}
    if(disposed||!autoPoll||!connection?.token||!active().length)return;
    timer=setTimeout(()=>{timer=null;void refreshJobs().catch(()=>{});},Math.max(10,pollMs));timer?.unref?.();
  }
  function useSettings(record) {
    if(working)throw new Error('Wait for the current request upload to finish before changing its setup.');
    if(typeof record?.settings?.model==='string')selectedModel=record.settings.model;else if(typeof record?.model==='string')selectedModel=record.model;
    if(typeof record?.settings?.quality==='string')selectedQuality=record.settings.quality;
    if(typeof record?.settings?.complexity==='string')selectedComplexity=record.settings.complexity;
    else if(generationComplexityOptions(selectedModel).length)selectedComplexity=DEFAULT_GENERATION_COMPLEXITY;
    try{localStorage.setItem(storageKey+'.model',selectedModel);localStorage.setItem(storageKey+'.quality',selectedQuality);localStorage.setItem(storageKey+'.complexity',selectedComplexity);}catch{}emit({type:'settings'});
  }
  function setWorkflowContext({jobIds=[],settings={}}={}) {
    if(working)throw new Error('Wait for the current request upload to finish before switching workflows.');
    if(!Array.isArray(jobIds))throw new Error('Workflow job IDs must be a list.');
    restoreIds();
    workflowIds=[...new Set(jobIds.filter(job=>typeof job==='string'||!job?.kind||job.kind===kind).map(job=>typeof job==='string'?job:job?.id).filter(id=>typeof id==='string'&&id))];
    workflowVersion++;
    if(result&&!belongsToWorkflow(result.id))result=null;
    for(const id of workflowIds)if(!records.has(id)){ownedIds.add(id);records.set(id,{id,kind,status:'queued'});}
    if(typeof settings.model==='string'&&settings.model.trim())selectedModel=settings.model;
    if(typeof settings.quality==='string'&&settings.quality.trim())selectedQuality=settings.quality;
    if(typeof settings.complexity==='string')selectedComplexity=settings.complexity;
    // Root persists tab settings. This event must not look like a user settings edit.
    emit({type:'workflow',version:workflowVersion});schedule();return workflowVersion;
  }
  return {
    state:()=>({connected:Boolean(connection?.authenticated),canAttach:Boolean(connection?.authenticated&&connection.models?.some(model=>model.id===selectedModel&&model.available)),working,pending:false,backgroundPending:active().length>0,activeCount:active().length,jobs:[...records.values()],contextJobs:contextJobs(),contextActiveCount:contextJobs().filter(record=>liveStatuses.has(record.status)).length,workflowScoped:workflowIds!==null,workflowVersion,workflowJobIds:workflowIds===null?null:[...workflowIds],resultId:contextResultId(),resultReady:Boolean(contextResultId()),uncertain:Boolean(uncertain()),uncertainRequestId:uncertain()?.id||null,models:connection?.models||[],model:selectedModel,quality:selectedQuality,complexity:selectedComplexity,complexityOptions:generationComplexityOptions(selectedModel),qualityOptions:generationQualityOptions(selectedModel),settingsError:settingsError(),result:contextResult(),direct:true,message:connection?.message||`Check the local image connection to generate your ${kind}.`}),
    subscribe(listener){listeners.add(listener);return()=>listeners.delete(listener);},
    dispose(){disposed=true;if(timer!==null)clearTimeout(timer);timer=null;listeners.clear();},
    selectModel(id){if(!working&&connection?.models?.some(model=>model.id===id&&model.available)){selectedModel=id;try{localStorage.setItem(storageKey+'.model',id);}catch{}}emit({type:'settings'});},
    selectQuality(value){if(working)return;validateGenerationQuality(selectedModel,value);selectedQuality=value;try{localStorage.setItem(storageKey+'.quality',value);}catch{}emit({type:'settings'});},
    selectComplexity(value){if(working)return;validateGenerationComplexity(selectedModel,value);selectedComplexity=value;try{localStorage.setItem(storageKey+'.complexity',value);}catch{}emit({type:'settings'});},
    useSettings,setWorkflowContext,refreshJob,refreshJobs,
    async fetchResult(id=workflowIds===null?lastRequestId:contextResultId()){const record=await refreshJob(id);if(record.status!=='completed')throw new Error(record.message||'This generation is not ready yet.');return record;},
    async editOutput(record=contextResult()){
      if(working)throw new Error('Wait for the current request upload to finish before editing a result.');
      if(!record?.image)throw new Error('This output image is unavailable.');
      if(!editor.editGeneratedImage)throw new Error('Refresh the desktop editor to edit output images.');
      return editor.editGeneratedImage(record.image);
    },
    async restoreSource(record=contextResult(),{beforeApply,signal}={}){
      if(working)throw new Error('Wait for the current request upload to finish before restoring its setup.');
      const expected=JSON.stringify(editor.peek()),project=await loadGenerationProject(record,{kind,fetchImpl,signal});
      if(signal?.aborted)throw new Error('Restoring the generation setup was canceled.');
      if(working||JSON.stringify(editor.peek())!==expected)throw new Error('Your project changed while loading the saved setup. Choose Redo again.');
      if(!editor.restoreGenerationProject)throw new Error('Refresh the desktop editor to restore generation setups.');
      beforeApply?.();const restored=await editor.restoreGenerationProject(project);useSettings(record);return restored;
    },
    async prepare(){
      await refreshConnection();if(!selectedModel)selectedModel=connection.models?.find(model=>model.available)?.id||'';
      restoreIds();emit({type:'connection'});
      if(!working&&connection.token){const previousResult=result;await refreshJobs({notify:false});const id=workflowIds===null?lastRequestId:contextResultId();if(id&&result===previousResult&&records.get(id)?.status==='completed')await refreshJob(id,{notify:false}).catch(()=>{});}
      schedule();return connection;
    },
    async generate({prepareProject}={}){
      if(working)throw new Error(`Your ${kind} request is still being prepared or uploaded.`);
      working=true;emit({type:'preparing'});
      try {
        const unresolved=uncertain();
        if(unresolved){try{return {...await refreshJob(unresolved.id),recovered:true};}catch(error){throw Object.assign(new Error('The previous upload is still unconfirmed. Check the generation queue; no new request was submitted. '+error.message),{requestId:unresolved.id,submissionUncertain:true});}}
        if(!connection?.authenticated||!selectedModel)throw new Error(connection?.message||'Check the image connection first.');
        if(settingsError())throw new Error(settingsError());
        const model=selectedModel,quality=validateGenerationQuality(model,selectedQuality),complexity=generationComplexityOptions(model).length?validateGenerationComplexity(model,selectedComplexity):undefined;
        const original=structuredClone(editor.snapshot()),prepared=prepareProject?await prepareProject(original):original,snapshot=structuredClone(prepared),input=await prepareInput(snapshot);
        const id=crypto.randomUUID();lastRequestId=id;ownedIds.add(id);
        const provisional={id,kind,status:'submission-unknown',uncertain:true,model,settings:{model,quality,...(complexity===undefined?{}:{complexity})},createdAt:new Date().toISOString()};records.set(id,provisional);persist();
        try {
          const record=await authenticatedJson(endpoint+'/generate',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({...input,project:snapshot,requestId:id,model,quality,complexity})});
          if(record.id!==id)throw new Error('The returned generation does not match this request.');
          accept(record,{full:true,notify:false});emit({type:'queued',record:compact(record)});return record;
        }catch(error){
          if(error.preAdmissionRejected||(error.status>=400&&error.status<500&&error.status!==408)){accept({id,kind,status:'failed',message:error.message});throw error;}
          try{return {...await refreshJob(id),recovered:true};}catch{}
          records.set(id,{...provisional,connectionError:error.message});persist();emit({type:'uncertain',record:records.get(id)});
          throw Object.assign(new Error('The upload response was interrupted. Your request ID was kept; check the queue before trying again. '+error.message),{requestId:id,submissionUncertain:true});
        }
      }finally{working=false;emit({type:'idle'});schedule();}
    },
  };
}
export const createDesktopSheetGeneration=createDesktopGeneration;
