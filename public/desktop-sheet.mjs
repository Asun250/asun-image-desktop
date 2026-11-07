import {mountSheetCreator} from './sheet-creator.mjs';
import {withSheetPreset} from './sheet-preset.mjs';
import {createDesktopSheetGeneration} from './desktop-sheet-generation.mjs';
import {buildSheetGenerationInput} from './sheet-generation-input.mjs';

// Direct desktop generation and the optional portable request pack share a preset.
export function mountDesktopSheetCreation({editor,showCanvasCreator,download,onStatus,bridge,onQueued,onOpenQueue,beforeGenerate}) {
  const generationBridge=bridge||createDesktopSheetGeneration({editor,prepareInput:buildSheetGenerationInput});
  const sheet=mountSheetCreator({editor,download,onStatus,onQueued,onOpenQueue,beforeGenerate,bridge:generationBridge});
  const chooser=document.createElement('dialog');
  chooser.id='desktopCreateDialog';chooser.className='desktop-create-dialog';
  chooser.setAttribute('aria-labelledby','desktopCreateTitle');
  chooser.innerHTML='<div class="dialog-heading"><h2 id="desktopCreateTitle">What would you like to create?</h2><button type="button" class="desktop-create-close" aria-label="Close creation options">×</button></div><p class="dialog-note">Choose a starting point. Your current project stays available.</p><div class="desktop-create-options"></div><div class="dialog-actions"><button type="button" class="desktop-create-blank">New blank canvas</button><button type="button" class="desktop-create-continue">Continue editing</button></div>';
  const choices=chooser.querySelector('.desktop-create-options');
  choices.append(sheet.card());
  const imageEdit=document.createElement('button');imageEdit.type='button';imageEdit.className='desktop-create-image-edit';
  imageEdit.innerHTML='<span class="desktop-create-canvas-icon" aria-hidden="true">✎</span><span><strong>Image edit</strong><small>Make a change to your photo with layers, numbered areas and references.</small></span><span aria-hidden="true">→</span>';
  imageEdit.onclick=()=>{
    chooser.close();
    try{const current=editor.peek();if(current.sheetPreset?.active)editor.apply(withSheetPreset(current,{active:false}),'Return to image editing');}
    catch(error){onStatus?.(error.message,true);}
  };choices.append(imageEdit);
  chooser.querySelector('.desktop-create-blank').onclick=()=>{chooser.close();showCanvasCreator();};
  const close=()=>chooser.close();
  chooser.querySelector('.desktop-create-close').onclick=close;
  chooser.querySelector('.desktop-create-continue').onclick=close;
  document.body.append(chooser);
  const styles=document.createElement('style');styles.textContent=`
    .desktop-create-dialog{width:min(620px,calc(100vw - 32px));max-width:none;max-height:90dvh;padding:26px;border-radius:22px;overflow:auto}
    .desktop-create-dialog .desktop-create-options{display:grid;gap:16px;margin:22px 0}
    .desktop-create-dialog .desktop-create-options>button{width:100%;text-align:left}
    .desktop-create-image-edit{display:flex;align-items:center;gap:16px;min-height:100px;border-radius:16px;padding:18px}
    .desktop-create-image-edit strong{display:block;font-size:18px;margin-bottom:7px}
    .desktop-create-image-edit small{display:block;font-size:13px;line-height:1.5;opacity:.75}
    .desktop-create-canvas-icon{font-size:32px;color:#e68759;flex:none}
    .desktop-create-image-edit>span:nth-child(2){flex:1}
  `;document.head.append(styles);
  function open(){
    try{editor.snapshot();if(!chooser.open)chooser.showModal();}
    catch(error){onStatus?.(error.message,true);}
  }
  document.getElementById('newProject').onclick=open;
  const directButton=document.getElementById('characterItemSheet');
  if(directButton)directButton.onclick=()=>{
    try{editor.snapshot();sheet.open();}
    catch(error){onStatus?.(error.message,true);}
  };
  return Object.freeze({open,sheet,bridge:generationBridge,dispose(){sheet.dispose();generationBridge.dispose?.();chooser.remove();styles.remove();}});
}
