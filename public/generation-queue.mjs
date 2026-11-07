import {generationAPI, generationDate, generationJSON, blockoutReviewDisplay} from './generation-details.mjs';
import {isLocalGenerationAuthError,isLocalGenerationAuthResponse} from './local-generation-auth.mjs';

const jobID = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;
const mounts = new WeakMap();
const active = status => status === 'queued' || status === 'running';
const kindName = kind => kind === 'sheet' ? 'Character / item sheet' : 'Image';
const statusName = status => ({queued:'Queued',running:'Generating',completed:'Ready',failed:'Failed',cancelled:'Canceled',canceled:'Canceled',expired:'Expired'}[status] || 'Unknown');
const recorded = value => value === undefined || value === null || value === '' ? 'Not recorded' : String(value);
function element(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

/** The queue reads server metadata; completion never changes the current project. */
export function mountGenerationQueue({onOpenResult,onEditOutput,onRedo,onOpenWorkflow,onNewProject,onError=()=>{},fetchImpl=globalThis.fetch}={}) {
  const header = document.querySelector('#app > .header');
  if (!header) throw new Error('The desktop header is not available.');
  if (mounts.has(header)) return mounts.get(header);
  if (!document.querySelector('link[data-generation-queue-style]')) {
    const link = document.createElement('link');link.rel = 'stylesheet';link.href = new URL('./generation-queue.css',import.meta.url).href;link.dataset.generationQueueStyle = '';document.head.append(link);
  }
  header.classList.add('has-generation-queue');
  const button = element('button','quiet');button.id = 'generationQueueButton';button.type = 'button';button.setAttribute('aria-haspopup','dialog');button.setAttribute('aria-controls','generationQueueDialog');
  const icon = element('span','generation-queue-symbol','▤');icon.setAttribute('aria-hidden','true');
  const count = element('span','generation-queue-count');count.id = 'generationQueueCount';count.hidden = true;count.setAttribute('aria-hidden','true');
  button.append(icon,element('span','','Job queue'),count);const exportButton = header.querySelector('#export');if(exportButton)exportButton.before(button);else header.append(button);
  const dialog = document.createElement('dialog');dialog.id = 'generationQueueDialog';dialog.setAttribute('aria-labelledby','generationQueueTitle');
  const heading = element('div','generation-queue-heading'), titleGroup = element('div');
  const title = element('h2','','Job queue');title.id = 'generationQueueTitle';
  titleGroup.append(title,element('p','','Keep creating while your images and sheets generate.'));
  const closeButton = element('button','','Close ×');closeButton.id = 'generationQueueClose';closeButton.type = 'button';closeButton.setAttribute('aria-label','Close job queue');heading.append(titleGroup,closeButton);
  const toolbar = element('div','generation-queue-toolbar');
  const newButton = element('button','primary','＋ New project');newButton.id = 'generationQueueNewProject';newButton.type = 'button';newButton.hidden = typeof onNewProject !== 'function';
  const refreshButton = element('button','','Refresh');refreshButton.id = 'generationQueueRefresh';refreshButton.type = 'button';
  const history = element('a','','Full generation history ↗');history.href = './generation-history.html';history.target = '_blank';history.rel = 'noopener';
  toolbar.append(newButton,refreshButton,history);
  const status = element('p','generation-queue-status','Loading your job queue…');status.id = 'generationQueueStatus';status.setAttribute('role','status');status.setAttribute('aria-live','polite');
  const list = element('div','generation-queue-list');list.id = 'generationQueueList';
  const note = element('p','generation-queue-note','Jobs use the images, references and settings saved when you pressed Generate. You can close this window and work on another project.');
  dialog.append(heading,toolbar,status,list,note);document.body.append(dialog);
  const listeners = new AbortController(), tokens = {image:null,sheet:null}, actionControllers = new Set(), downloadURLs = new Set(), busyItems = new Set();
  let disposed = false, timer, controller, pending = null, refreshAgain = false, items = [], counts = {}, errorMessage = '', actionMessage = '', actionError = false, loaded = false, priorList = '', revision = 0;

  async function authorize(kind, signal) {
    const api = generationAPI(kind);
    if (!tokens[kind]) {
      const result = await generationJSON(fetchImpl,api.endpoint+'/status',{signal});
      if (!result.token) throw new Error('Restart Asun IMG to connect to its local job queue.');
      tokens[kind] = result.token;
    }
    return {[api.tokenHeader]:tokens[kind]};
  }
  async function requestQueue(signal) {
    let lastError;
    for (const kind of ['image','sheet']) {
      try {
        let headers = await authorize(kind,signal);
        try {return await generationJSON(fetchImpl,'/api/generation-queue/status',{headers,signal});}
        catch (error) {
          if (!isLocalGenerationAuthError(error)) throw error;
          tokens[kind] = null;headers = await authorize(kind,signal);
          return await generationJSON(fetchImpl,'/api/generation-queue/status',{headers,signal});
        }
      } catch (error) {lastError = error;if (error.name === 'AbortError') throw error;}
    }
    throw lastError;
  }
  function totals() {
    return {queued:Number.isFinite(counts.queued)?Math.max(0,counts.queued):items.filter(item=>item.status==='queued').length,running:Number.isFinite(counts.running)?Math.max(0,counts.running):items.filter(item=>item.status==='running').length};
  }
  function updateStatus() {
    const total = totals(), activeCount = total.queued+total.running;
    button.dataset.active = String(activeCount>0);button.dataset.error = String(Boolean(errorMessage));
    count.hidden = !activeCount && !errorMessage;count.textContent = errorMessage ? '!' : String(activeCount);
    button.setAttribute('aria-label',errorMessage?'Job queue — connection unavailable':`Job queue${activeCount?`, ${activeCount} active ${activeCount===1?'job':'jobs'}`:''}`);
    button.title = errorMessage || (activeCount?`${total.running} generating · ${total.queued} queued`:'View image and sheet generation jobs');
    refreshButton.disabled = Boolean(pending);refreshButton.textContent = pending?'Refreshing…':'Refresh';
    status.classList.toggle('is-error',Boolean(errorMessage) || actionError);
    if (errorMessage) status.textContent = `${errorMessage}${loaded?' Last known jobs are shown below.':''}`;
    else if (actionMessage) status.textContent = actionMessage;
    else if (!loaded) status.textContent = 'Loading your job queue…';
    else if (activeCount) status.textContent = `${total.running} generating · ${total.queued} queued. You can start your next project now.`;
    else status.textContent = items.length?'No jobs are waiting. Your recent results are below.':'Your queue is empty. Generate an image or a character / item sheet to start.';
  }
  function makeAction(record, label, action, callback, className='') {
    const node = element('button',className,label);node.type = 'button';node.dataset.queueAction = action;node.disabled = busyItems.has(`${record.kind}:${record.id}`);
    node.addEventListener('click',()=>runAction(record,callback));return node;
  }
  function jobCard(record) {
    const reviewDisplay = blockoutReviewDisplay(record);
    const card = element('article','generation-queue-card');card.dataset.jobId = record.id;card.dataset.kind = record.kind;card.dataset.status = record.status;
    const top = element('div','generation-queue-card-top'), badge = element('span','generation-queue-state');badge.dataset.status = record.status;
    if (record.status === 'running') {const spinner = element('span','generation-queue-spinner');spinner.setAttribute('aria-hidden','true');badge.append(spinner);}
    badge.append(document.createTextNode(record.outputCheck?.matches===false?'Output size mismatch':reviewDisplay?.label || statusName(record.status)));top.append(element('span','generation-queue-kind',kindName(record.kind)),badge);
    const projectName = record.projectName || record.sourceProjectName || record.sourceName || 'Untitled creation';
    const name = element('h3','',projectName), meta = element('dl','generation-queue-meta');
    for (const [key,value] of [['Source',record.sourceName],['Model',record.settings?.model||record.model],['Quality',record.settings?.quality],['Size',record.settings?.size]]) {const group=element('div');group.append(element('dt','',key),element('dd','',recorded(value)));meta.append(group);}
    let description = record.statusmessage || record.message || '';
    if (record.status === 'queued') description = Number.isFinite(record.queuePosition)?`Position ${record.queuePosition} in the queue. Waiting for an available generation slot.`:'Waiting for an available generation slot.';
    else if (record.status === 'running') description = record.message || 'Generation is in progress. Your result will appear here when it is ready.';
    else if (record.status === 'completed') description = record.outputAvailable ? reviewDisplay ? reviewDisplay.accepted ? 'The visual match review passed. Inspect the result before saving or editing.' : 'This image has no recorded review approval. Inspect its review details.' : 'Your image is ready to inspect, save or edit.' : 'The job finished, but its output is no longer stored.';
    else if (record.status === 'cancelled' || record.status === 'canceled') description = 'Canceled before generation started.';
    const detail = element('p','generation-queue-description',description), date = element('p','generation-queue-date',`Created ${generationDate(record.queuedAt || record.createdAt)}`);
    const actions = element('div','generation-queue-actions');
    const payload = {kind:record.kind,id:record.id,record};
    if (record.outputAvailable && (record.status === 'completed' || (record.status === 'failed' && reviewDisplay))) {
      if (typeof onOpenResult === 'function') actions.append(makeAction(record,reviewDisplay && !reviewDisplay.accepted?'Inspect unapproved image':'Open result','open',()=>invoke(onOpenResult,payload),'primary'));
      actions.append(makeAction(record,'Download','download',()=>download(record)));
      if (typeof onEditOutput === 'function') actions.append(makeAction(record,'Edit output image','edit',()=>invoke(onEditOutput,payload)));
    }
    if (record.sourceProjectAvailable && typeof onOpenWorkflow === 'function') actions.append(makeAction(record,'Open workflow','workflow',()=>invoke(onOpenWorkflow,payload)));
    if (record.sourceProjectAvailable && typeof onRedo === 'function') actions.append(makeAction(record,record.status==='completed'?'Redo with references':'Reopen setup','redo',()=>invoke(onRedo,payload)));
    if (record.status === 'queued' && record.cancellable) actions.append(makeAction(record,'Cancel queued job','cancel',()=>cancel(record),'generation-queue-cancel'));
    card.append(top,name,meta,detail,date,actions);return card;
  }
  function render() {
    updateStatus();
    // Avoid replacing focused controls on an unchanged polling response.
    const signature = JSON.stringify([items,[...busyItems],loaded]);
    if (signature === priorList) return;priorList = signature;
    const focused = document.activeElement?.closest('[data-job-id]'), action = document.activeElement?.dataset.queueAction;
    const focusKey = focused?`${focused.dataset.kind}:${focused.dataset.jobId}`:null, scrollTop = list.scrollTop;
    list.replaceChildren();
    for (const [label,records] of [['In progress',items.filter(item=>active(item.status))],['Recent jobs',items.filter(item=>!active(item.status))]]) {
      if (!records.length) continue;
      const section = element('section','generation-queue-group');section.append(element('h3','generation-queue-group-title',`${label} · ${records.length}`));
      records.forEach(record=>section.append(jobCard(record)));list.append(section);
    }
    if (loaded && !items.length) {const empty=element('div','generation-queue-empty');empty.append(element('span','','▤'),element('h3','','A clear queue, a new idea'),element('p','','Your images and character / item sheets will be collected here.'));list.append(empty);}
    list.scrollTop = scrollTop;
    if (focusKey && action) for (const card of list.querySelectorAll('[data-job-id]')) if (`${card.dataset.kind}:${card.dataset.jobId}`===focusKey) {const target=[...card.querySelectorAll('[data-queue-action]')].find(node=>node.dataset.queueAction===action);if(target&&!target.disabled)target.focus({preventScroll:true});}
  }
  function schedule() {
    clearTimeout(timer);if (disposed || document.hidden) return;
    const total = totals();timer = setTimeout(refresh,total.queued+total.running?2500:15000);
  }
  function refresh() {
    if (disposed) return Promise.resolve();
    if (pending) {refreshAgain = true;return pending;}
    clearTimeout(timer);controller = new AbortController();const thisController = controller, started = revision;
    const timeout = setTimeout(()=>thisController.abort(),15000);
    pending = (async()=>{
      try {
        const result = await requestQueue(thisController.signal);
        if (disposed) return;
        if (!Array.isArray(result.items)) throw new Error('The local service did not return a job queue. Restart Asun IMG and try again.');
        // Cancellation must not be undone by an older response already in flight.
        if (started !== revision) return;
        items = result.items.filter(item=>item && jobID.test(item.id) && (item.kind==='image'||item.kind==='sheet')).map(item=>({...item}));
        counts = result.counts || {};errorMessage = typeof result.message==='string'?result.message:'';loaded = true;
      } catch (error) {
        if (!disposed) errorMessage = error.name==='AbortError'?'The job queue took too long to respond. Refresh to reconnect.':error.message;
      } finally {clearTimeout(timeout);pending = null;if(!disposed){render();if(refreshAgain){refreshAgain=false;queueMicrotask(refresh);}else schedule();}}
    })();updateStatus();return pending;
  }
  async function runAction(record,callback) {
    const key = `${record.kind}:${record.id}`;if (busyItems.has(key)) return;
    busyItems.add(key);actionMessage = '';actionError = false;render();
    try {await callback();}
    catch (error) {if(!disposed){actionMessage = error.message;actionError = true;onError(error);}}
    finally {busyItems.delete(key);if(!disposed)render();}
  }
  async function invoke(callback,payload) {close();await callback(payload);}
  async function cancel(record) {
    const request = new AbortController();actionControllers.add(request);
    try {
      const api = generationAPI(record.kind);
      let headers = await authorize(record.kind,request.signal);
      try {await generationJSON(fetchImpl,`${api.endpoint}/jobs/${encodeURIComponent(record.id)}/cancel`,{method:'POST',headers,signal:request.signal});}
      catch(error) {
        if(!isLocalGenerationAuthError(error))throw error;tokens[record.kind]=null;headers=await authorize(record.kind,request.signal);
        await generationJSON(fetchImpl,`${api.endpoint}/jobs/${encodeURIComponent(record.id)}/cancel`,{method:'POST',headers,signal:request.signal});
      }
      revision++;record.status='cancelled';record.cancellable=false;counts={};actionMessage = 'Job canceled before generation started.';
    } finally {actionControllers.delete(request);if(pending)await pending;await refresh();}
  }
  async function download(record) {
    const request = new AbortController();actionControllers.add(request);
    try {
      const api=generationAPI(record.kind),url=`${api.endpoint}/jobs/${encodeURIComponent(record.id)}/output`;
      let response=await fetchImpl(url,{cache:'no-store',headers:await authorize(record.kind,request.signal),signal:request.signal});
      if(await isLocalGenerationAuthResponse(response)){tokens[record.kind]=null;response=await fetchImpl(url,{cache:'no-store',headers:await authorize(record.kind,request.signal),signal:request.signal});}
      if(!response.ok)throw new Error(response.status===404||response.status===410?'This output is no longer stored.':'The image could not be downloaded. Try again.');
      const blob=await response.blob();if(!/^image\/(png|jpeg|webp)(?:;|$)/i.test(blob.type)||!blob.size||blob.size>50*1024*1024)throw new Error('The saved output is not a supported image.');
      if(disposed)return;
      const objectURL=URL.createObjectURL(blob);downloadURLs.add(objectURL);const link=element('a');link.href=objectURL;link.download=(record.output?.name||'Asun IMG result.png').replace(/[\\/:*?"<>|\u0000-\u001f]/g,'_');document.body.append(link);link.click();link.remove();
      setTimeout(()=>{URL.revokeObjectURL(objectURL);downloadURLs.delete(objectURL);},10000);actionMessage='Your image download is ready.';
    } finally {actionControllers.delete(request);}
  }
  function open() {if(disposed)return;if(!dialog.open)dialog.showModal();refresh();}
  function close() {if(dialog.open)dialog.close();}
  button.addEventListener('click',open,{signal:listeners.signal});closeButton.addEventListener('click',close,{signal:listeners.signal});
  refreshButton.addEventListener('click',()=>{actionMessage='';actionError=false;refresh();},{signal:listeners.signal});
  newButton.addEventListener('click',async()=>{close();try{await onNewProject?.();}catch(error){onError(error);}},{signal:listeners.signal});
  document.addEventListener('visibilitychange',()=>{if(document.hidden)clearTimeout(timer);else refresh();},{signal:listeners.signal});
  const api = {open,close,refresh,dispose(){disposed=true;clearTimeout(timer);controller?.abort();for(const request of actionControllers)request.abort();listeners.abort();for(const url of downloadURLs)URL.revokeObjectURL(url);downloadURLs.clear();close();dialog.remove();button.remove();header.classList.remove('has-generation-queue');mounts.delete(header);}};
  mounts.set(header,api);refresh();return api;
}
