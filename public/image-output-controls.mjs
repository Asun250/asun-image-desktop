import {resolveImageOutput,supportedImageAspects,isSelectedAreaEdit} from './image-output-settings.mjs';
import {readImageAspectPreference,writeImageAspectPreference} from './image-output-preferences.mjs';

const choices=[['source','Match source'],['9:16','9:16 portrait'],['16:9','16:9 landscape'],['2:3','2:3 portrait'],['3:2','3:2 landscape'],['1:1','1:1 square']];
const sourceLabels={main:'Original MAIN',blockout:'Blender blockout',canvas:'Canvas',reference:'First global reference',preset:'Chosen aspect ratio','edit-canvas':'Edit canvas kept exactly'};

/** Output framing belongs to the editable project, including Undo, tabs and Redo. */
export function mountImageOutputControls({editor,quality,getModel=()=>'',onStatus=()=>{}}) {
  if(!document.querySelector('link[data-image-output-styles]')){
    const style=document.createElement('link');style.rel='stylesheet';style.href=new URL('./image-output-controls.css',import.meta.url).href;style.dataset.imageOutputStyles='';document.head.append(style);
  }
  const host=quality.closest('.model-section'),qualityRow=quality.closest('.image-quality-row');
  const options=document.createElement('div');options.className='image-generation-options';qualityRow.before(options);options.append(qualityRow);
  const control=document.createElement('div');control.className='image-output-controls';
  const label=document.createElement('label');label.htmlFor='imageOutputAspect';label.textContent='Aspect Ratio';
  const select=document.createElement('select');select.id='imageOutputAspect';select.setAttribute('aria-label','Aspect Ratio');select.setAttribute('aria-describedby','imageOutputSummary imageOutputExperimental');
  control.append(label,select);options.append(control);
  const summary=document.createElement('p');summary.id='imageOutputSummary';summary.className='image-output-summary';summary.setAttribute('role','status');summary.setAttribute('aria-live','polite');host.append(summary);
  const experimental=document.createElement('p');experimental.id='imageOutputExperimental';experimental.className='image-output-experimental';experimental.hidden=true;experimental.setAttribute('role','note');experimental.textContent='Experimental size · above 3,686,400 pixels.';host.append(experimental);
  let lastRevision=-1,lastModel=null,lastPreference=null,error='',resolved=null,selectedEdit=false;
  function sync({disabled=false}={}) {
    const state=editor.state(),model=getModel(),preferredAspect=readImageAspectPreference();select.disabled=disabled||state.busy||selectedEdit||!model;
    // Queue polls must not clone a large project repeatedly.
    if(state.projectRevision===lastRevision&&model===lastModel&&preferredAspect===lastPreference)return {error,resolved};
    lastRevision=state.projectRevision;lastModel=model;lastPreference=preferredAspect;const project=editor.peek();
    const aspect=project.imageOutput?.aspect||preferredAspect;error='';resolved=null;experimental.hidden=true;selectedEdit=isSelectedAreaEdit(project);
    select.replaceChildren();
    if(selectedEdit){
      select.add(new Option(`Keep edit canvas · ${project.width} × ${project.height}`,'canvas'));select.value='canvas';
      select.title='Selected-area edits keep the full current canvas and selection alignment. Your preferred aspect ratio is unchanged.';
    }else{
      const supported=new Set(supportedImageAspects(model));
      for(const [value,text] of choices){
        if(value!=='source'&&!supported.has(value))continue;
        try{resolveImageOutput({...project,imageOutput:{version:1,aspect:value}},model,{preferredAspect});select.add(new Option(text,value));}catch{/* Invalid choices are not offered as selectable fallbacks. */}
      }
      if(![...select.options].some(option=>option.value===aspect)){
        const unsupported=new Option(`${choices.find(([value])=>value===aspect)?.[1]||aspect} (unsupported)`,aspect);unsupported.disabled=true;select.add(unsupported,0);
      }
      select.value=aspect;select.title='Choose an aspect ratio. This choice is remembered for new projects; saved projects keep their own choice.';
    }
    select.disabled=disabled||state.busy||selectedEdit||!model;
    if(!model)summary.textContent='Choose a model to see output dimensions.';
    else try {
      resolved=resolveImageOutput(project,model,{preferredAspect});
      const origin=sourceLabels[resolved.source]||'Source';
      summary.textContent=`${resolved.width} × ${resolved.height} px (${resolved.ratio}) · ${origin}${resolved.source==='reference'&&resolved.sourceName?' · '+resolved.sourceName:''}`;
      summary.title=`Requested output: ${resolved.width} × ${resolved.height} pixels (${resolved.ratio}). ${origin}${resolved.sourceName?': '+resolved.sourceName:''}. Source: ${resolved.sourceWidth} × ${resolved.sourceHeight} pixels. No crop or stretch.`;
      experimental.hidden=!resolved.experimental;
    } catch(cause){error=cause.message;summary.textContent=error;summary.title=error;}
    summary.classList.toggle('is-error',Boolean(error));select.setAttribute('aria-invalid',String(Boolean(error)));
    return {error,resolved};
  }
  select.addEventListener('change',()=>{
    try {
      if(selectedEdit||select.disabled||select.selectedOptions[0]?.disabled)return;
      const next=editor.peek();next.imageOutput={version:1,aspect:select.value};
      editor.apply(next,'Change aspect ratio');const remembered=writeImageAspectPreference(select.value);lastRevision=-1;
      const state=sync();onStatus(state.error||`Aspect ratio set to ${state.resolved?.size?.replace('x',' × ')||select.selectedOptions[0].textContent}.${remembered?' Remembered for new projects.':' Saved in this project; this browser could not remember it for new projects.'} Your source images stay intact.`,Boolean(state.error));
    }catch(cause){lastRevision=-1;sync();onStatus(cause.message,true);}
  });
  return {sync};
}
