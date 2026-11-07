// Project capture, switching, confirmation and persistence belong to the editor.
// This strip only reflects the supplied workflow state and requests an action.
const mounted=new WeakMap();
const statuses={checking:['Checking…','checking'],queued:['Queued','queued'],running:['Generating','running'],generating:['Generating','running'],completed:['Ready','ready'],ready:['Ready','ready'],failed:['Failed','failed'],cancelled:['Canceled','cancelled'],canceled:['Canceled','cancelled']};

export function mountWorkflowTabs({onSelect,onNew,onClose,onOpenQueue,onOpenResult,onError=()=>{}}={}) {
  const app=document.getElementById('app');
  if(!app)throw new Error('The editor workspace is not available.');
  if(mounted.has(app))return mounted.get(app);
  if(!document.querySelector('link[data-workflow-tabs]')){
    const style=document.createElement('link');style.rel='stylesheet';style.href=new URL('./workflow-tabs.css',import.meta.url).href;style.dataset.workflowTabs='';document.head.append(style);
  }
  const strip=document.createElement('section');strip.id='workflowTabStrip';strip.setAttribute('aria-label','Image workflows');
  strip.innerHTML=`<div class="workflow-tabs-scroll"><button id="workflowScrollLeft" type="button" aria-label="Scroll workflows left" title="Scroll workflows left" hidden>‹</button><div id="workflowTabList" role="tablist" aria-label="Open image workflows" aria-orientation="horizontal"></div><button id="workflowScrollRight" type="button" aria-label="Scroll workflows right" title="Scroll workflows right" hidden>›</button></div><div class="workflow-tabs-actions"><div><button id="newWorkflowTab" type="button" title="Start a separate image workflow"><span aria-hidden="true">＋</span> New tab</button><button id="workflowTabsQueue" type="button" title="View all generation jobs"><span aria-hidden="true">≡</span> Queue<span id="workflowQueueCount" hidden></span></button></div><span id="workflowSaveStatus" role="status" aria-live="polite" hidden></span></div>`;
  app.querySelector(':scope > .header').after(strip);document.body.classList.add('has-workflow-tabs');
  const list=strip.querySelector('#workflowTabList'),left=strip.querySelector('#workflowScrollLeft'),right=strip.querySelector('#workflowScrollRight'),newButton=strip.querySelector('#newWorkflowTab'),queueButton=strip.querySelector('#workflowTabsQueue'),queueCount=strip.querySelector('#workflowQueueCount'),saveStatus=strip.querySelector('#workflowSaveStatus');
  let current={tabs:[],activeId:'',busy:false,savingMessage:''},disposed=false,pending=false,frame=0,focusFrame=0,focusRevision=0,lastActive='',sequence=0;
  const nodes=new Map();
  const blocked=()=>pending||Boolean(current.busy);
  function scrollState(){
    if(disposed)return;
    const overflow=list.scrollWidth>list.clientWidth+1;left.hidden=right.hidden=!overflow;
    left.disabled=list.scrollLeft<=1;right.disabled=list.scrollLeft+list.clientWidth>=list.scrollWidth-1;
  }
  function scheduleScroll(){cancelAnimationFrame(frame);frame=requestAnimationFrame(scrollState);}
  function reveal(id){
    const node=nodes.get(id)?.wrapper;if(!node)return;
    const area=list.getBoundingClientRect(),box=node.getBoundingClientRect();
    if(box.left<area.left)list.scrollLeft-=area.left-box.left+4;
    else if(box.right>area.right)list.scrollLeft+=box.right-area.right+4;
    scheduleScroll();
  }
  async function invoke(callback,id,{independent=false,focusSelectedTab=false}={}){
    if(disposed||(!independent&&blocked())||typeof callback!=='function')return;
    const revision=++focusRevision;
    const returnFocus=strip.contains(document.activeElement)?document.activeElement:null;
    if(!independent){pending=true;render();}
    try{await callback(id);}catch(error){onError(error?.message||String(error));}
    finally{
      if(!independent){
        pending=false;
        if(!disposed){
          render();
          if(focusSelectedTab){
            const activeId=current.activeId,target=nodes.get(id)?.tab;
            if(target&&!target.disabled)target.focus({preventScroll:true});
            // A restored sheet also focuses its close button on the next frame.
            // Run after that focus, unless another action or workflow took over.
            cancelAnimationFrame(focusFrame);focusFrame=requestAnimationFrame(()=>{
              if(!disposed&&revision===focusRevision&&current.activeId===activeId&&target?.isConnected&&!target.disabled)target.focus({preventScroll:true});
            });
          }else if(returnFocus&&document.activeElement===document.body){
            const target=returnFocus.isConnected?returnFocus:nodes.get(current.activeId)?.tab;if(target&&!target.disabled)target.focus({preventScroll:true});
          }
        }
      }
    }
  }
  function makeNode(id){
    const wrapper=document.createElement('div');wrapper.className='workflow-tab';wrapper.setAttribute('role','presentation');
    const tab=document.createElement('button');tab.type='button';tab.id=`workflowTab-${++sequence}`;tab.dataset.workflowTab=id;tab.className='workflow-tab-select';tab.setAttribute('role','tab');
    const title=document.createElement('span');title.className='workflow-tab-title';
    const dirty=document.createElement('span');dirty.className='workflow-tab-dirty';dirty.textContent='●';dirty.setAttribute('aria-hidden','true');
    const name=document.createElement('span');name.className='workflow-tab-name';title.append(name,dirty);
    const subtitle=document.createElement('span');subtitle.className='workflow-tab-subtitle';const indicator=document.createElement('span');indicator.className='workflow-tab-indicator';indicator.setAttribute('aria-hidden','true');const status=document.createElement('span');status.className='workflow-tab-status';subtitle.append(indicator,status);tab.append(title,subtitle);
    const result=document.createElement('button');result.type='button';result.dataset.workflowResult=id;result.className='workflow-tab-result';result.textContent='↗';
    const close=document.createElement('button');close.type='button';close.dataset.workflowClose=id;close.className='workflow-tab-close';close.textContent='×';
    wrapper.append(tab,result,close);
    tab.onclick=()=>invoke(onSelect,id,{focusSelectedTab:true});result.onclick=()=>invoke(onOpenResult,id);close.onclick=()=>invoke(onClose,id);
    const node={wrapper,tab,name,dirty,status,result,close};nodes.set(id,node);return node;
  }
  function render(){
    const activeElement=document.activeElement,focusedId=activeElement?.dataset?.workflowTab;
    const surviving=new Set(current.tabs.map(tab=>tab.id));
    const removedFocus=[...nodes.entries()].some(([id,node])=>!surviving.has(id)&&node.wrapper.contains(activeElement));
    for(const [id,node] of nodes)if(!surviving.has(id)){node.wrapper.remove();nodes.delete(id);}
    let activeWorkflows=0;
    current.tabs.forEach((item,index)=>{
      const node=nodes.get(item.id)||makeNode(item.id),active=item.id===current.activeId;
      const [status,kind]=statuses[item.status]||['Draft','draft'],jobs=Math.max(0,Math.trunc(Number(item.jobCount)||0));
      if(kind==='running'||kind==='queued')activeWorkflows++;
      node.wrapper.dataset.status=kind;node.wrapper.classList.toggle('is-active',active);node.tab.setAttribute('aria-selected',String(active));
      node.tab.tabIndex=item.id===(surviving.has(focusedId)?focusedId:current.activeId)?0:-1;
      node.name.textContent=item.name||'Untitled';node.dirty.hidden=!item.dirty;
      node.status.textContent=jobs>1?`${status} · ${jobs} jobs`:status;
      const description=`${item.name||'Untitled'}${item.dirty?', unsaved changes':''}, ${node.status.textContent}`;
      node.tab.setAttribute('aria-label',description);node.tab.title=description;
      node.result.hidden=!item.hasResult;node.result.title=`View result for ${item.name||'Untitled'}`;node.result.setAttribute('aria-label',node.result.title);
      node.close.title=`Close ${item.name||'Untitled'}`;node.close.setAttribute('aria-label',node.close.title);
      node.tab.disabled=node.result.disabled=node.close.disabled=blocked();
      if(list.children[index]!==node.wrapper)list.insertBefore(node.wrapper,list.children[index]||null);
    });
    newButton.disabled=blocked();list.setAttribute('aria-busy',String(blocked()));
    queueCount.hidden=activeWorkflows===0;queueCount.textContent=String(activeWorkflows);queueButton.setAttribute('aria-label',activeWorkflows?`Job queue, ${activeWorkflows} active ${activeWorkflows===1?'workflow':'workflows'}`:'Job queue');
    saveStatus.hidden=!current.savingMessage;saveStatus.textContent=current.savingMessage||'';saveStatus.title=current.savingMessage||'';
    if(removedFocus)nodes.get(current.activeId)?.tab.focus({preventScroll:true});
    if(current.activeId!==lastActive){lastActive=current.activeId;reveal(current.activeId);}scheduleScroll();
  }
  function update(state={}){
    if(disposed)return;
    const seen=new Set(),tabs=[];
    for(const item of Array.isArray(state.tabs)?state.tabs:[]){if(!item||typeof item.id!=='string'||!item.id||seen.has(item.id))continue;seen.add(item.id);tabs.push({...item,name:String(item.name||'Untitled')});}
    current={...state,tabs,activeId:typeof state.activeId==='string'?state.activeId:'',busy:Boolean(state.busy),savingMessage:String(state.savingMessage||'')};render();
  }
  function keydown(event){
    const button=event.target.closest('[data-workflow-tab]');if(!button||blocked())return;
    if(event.ctrlKey||event.metaKey)return;
    if(event.key==='Delete'){event.preventDefault();void invoke(onClose,button.dataset.workflowTab);return;}
    const index=current.tabs.findIndex(tab=>tab.id===button.dataset.workflowTab),length=current.tabs.length;
    let next;
    if(event.key==='ArrowRight')next=(index+1)%length;else if(event.key==='ArrowLeft')next=(index-1+length)%length;else if(event.key==='Home')next=0;else if(event.key==='End')next=length-1;else return;
    event.preventDefault();for(const node of nodes.values())node.tab.tabIndex=-1;const id=current.tabs[next]?.id,node=nodes.get(id);if(node){node.tab.tabIndex=0;node.tab.focus({preventScroll:true});reveal(id);}
  }
  function wheel(event){if(list.scrollWidth<=list.clientWidth+1||Math.abs(event.deltaX)>Math.abs(event.deltaY)||event.ctrlKey||event.shiftKey)return;const before=list.scrollLeft;list.scrollLeft+=event.deltaY;if(list.scrollLeft!==before)event.preventDefault();}
  list.addEventListener('keydown',keydown);list.addEventListener('scroll',scheduleScroll,{passive:true});list.addEventListener('wheel',wheel,{passive:false});
  // Keys used to navigate/close workflows must not delete or move canvas objects.
  strip.addEventListener('keydown',event=>{if(!event.ctrlKey&&!event.metaKey)event.stopPropagation();});
  left.onclick=()=>{list.scrollLeft-=Math.max(180,list.clientWidth*.75);scheduleScroll();};right.onclick=()=>{list.scrollLeft+=Math.max(180,list.clientWidth*.75);scheduleScroll();};
  newButton.onclick=()=>invoke(onNew);queueButton.onclick=()=>invoke(onOpenQueue,undefined,{independent:true});
  const observer=new ResizeObserver(scheduleScroll);observer.observe(list);window.addEventListener('resize',scheduleScroll);
  const api={update,dispose(){if(disposed)return;disposed=true;cancelAnimationFrame(frame);cancelAnimationFrame(focusFrame);observer.disconnect();window.removeEventListener('resize',scheduleScroll);strip.remove();document.body.classList.remove('has-workflow-tabs');mounted.delete(app);}};
  mounted.set(app,api);update();return api;
}
