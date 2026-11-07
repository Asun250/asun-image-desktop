import {DEFAULT_GENERATION_COMPLEXITY,generationComplexityOptions} from './generation-settings.mjs';

/** Shared UI for image and sheet planning effort, separate from render quality. */
export function mountGenerationComplexity({host,bridge,id='imageComplexity',before=null,onStatus=()=>{}}) {
  if(!document.querySelector('link[data-generation-complexity-style]')){
    const link=document.createElement('link');link.rel='stylesheet';link.href=new URL('./generation-complexity-controls.css',import.meta.url).href;link.dataset.generationComplexityStyle='';document.head.append(link);
  }
  const section=document.createElement('div');section.className='generation-complexity';
  const label=document.createElement('label');label.htmlFor=id;label.textContent='Complexity';
  const select=document.createElement('select');select.id=id;select.setAttribute('aria-label',id==='sheetComplexity'?'Sheet image complexity':'Image complexity');select.setAttribute('aria-describedby',id+'Help');
  const help=document.createElement('p');help.id=id+'Help';help.className='generation-complexity-help';
  section.append(label,select,help);host.insertBefore(section,before);
  let lastOptions='';
  function sync(state=bridge.state(),{disabled=false}={}) {
    const options=state.complexityOptions||generationComplexityOptions(state.model),value=state.complexity??DEFAULT_GENERATION_COMPLEXITY,supported=options.length>0,key=JSON.stringify([options,value]);
    section.dataset.supported=String(supported);
    if(lastOptions!==key){
      lastOptions=key;select.replaceChildren();
      for(const item of options)select.add(new Option(item===DEFAULT_GENERATION_COMPLEXITY?'High (default)':item[0].toUpperCase()+item.slice(1),item));
      if(supported&&!options.includes(value)){const option=new Option(value+' (unsupported)',value);option.disabled=true;select.add(option);}
      select.value=supported?value:'';
      help.textContent=supported?'Planning before rendering, separate from quality. High can take longer and change more.':'Complexity unavailable for this model.';
    }
    label.hidden=select.hidden=!supported;select.disabled=disabled||state.working||!supported;
    select.setAttribute('aria-invalid',String(supported&&!options.includes(value)));
  }
  select.addEventListener('change',()=>{
    try{bridge.selectComplexity(select.value);onStatus('Complexity set to '+select.value+'. This controls planning, independently of quality.');}
    catch(error){onStatus(error.message,true);}sync();
  });
  return {sync};
}
