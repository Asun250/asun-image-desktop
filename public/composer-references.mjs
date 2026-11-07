import {clipboardImageFiles,readClipboardImages} from './clipboard.mjs';
import {sheetDropInput,sheetWebPhotoFile} from './sheet-photo-drop.mjs';

// Global generation references do not require a selected layer or numbered area.
export function mountComposerReferences({getProject,isBusy,onChoose,onImport,onRemove,onError,setPreviewImage}){
  const section=document.querySelector('.reference-section');
  const view=document.createElement('button');view.id='viewAllReferences';view.type='button';view.textContent='View all';view.setAttribute('aria-haspopup','dialog');view.setAttribute('aria-controls','composerReferencesDialog');
  section.querySelector('.composer-label').append(view);
  section.tabIndex=0;section.setAttribute('aria-label','Generation references. Drop or paste multiple photos here.');
  const help=document.createElement('div');help.className='composer-reference-help';
  const hint=document.createElement('span');hint.textContent='Drop photos here · No areas needed';
  const paste=document.createElement('button');paste.id='pasteComposerReferences';paste.type='button';paste.textContent='Paste';paste.title='Paste photos into generation references';
  help.append(hint,paste);section.append(help);
  const dialog=document.createElement('dialog');dialog.id='composerReferencesDialog';dialog.setAttribute('aria-labelledby','composerReferencesTitle');
  dialog.innerHTML=`<header><div><h2 id="composerReferencesTitle">Generation references</h2><p>Add 20 or more photos. These guide your generation without selecting or numbering areas.</p></div><button id="closeComposerReferences" type="button" aria-label="Close generation references">×</button></header><div class="composer-reference-actions"><button id="addComposerReferencePhotos" class="primary" type="button">+ Add photos</button><button id="pasteComposerReferencePhotos" class="quiet" type="button">Paste photos</button><span id="composerReferenceTotal" role="status"></span></div><div id="composerReferenceGallery" aria-label="All generation reference photos"></div><p id="composerReferenceEmpty">Drop photos here, paste them, or choose several files with Add photos.</p><p class="composer-reference-note">Use the photo names in your prompt to explain what each image should guide. Your original files stay intact.</p><footer><button id="doneComposerReferences" class="primary" type="button">Done</button></footer>`;
  document.body.append(dialog);
  const find=id=>dialog.querySelector('#'+id),gallery=find('composerReferenceGallery');
  let displayed=[];
  const report=error=>onError(error?.message||String(error));
  const ready=()=>{if(isBusy())throw new Error('Please wait for the current photo import to finish.');};
  async function runImport(input){
    try{ready();const target=getProject();await onImport(async()=>{
      const value=await input;
      const files=[...(value.files||[])];for(const url of value.urls||[])files.push(await sheetWebPhotoFile(url));
      if(getProject()!==target)throw new Error('Your project changed while loading photos. Add them again to the current project.');
      return files;
    });}catch(error){report(error);}finally{sync();}
  }
  function pastePhotos(){try{ready();void runImport(readClipboardImages().then(files=>({files})));}catch(error){report(error);}}
  for(const control of [paste,find('pasteComposerReferencePhotos')])control.onclick=pastePhotos;
  find('addComposerReferencePhotos').onclick=()=>{try{ready();onChoose();}catch(error){report(error);}};
  for(const id of ['closeComposerReferences','doneComposerReferences'])find(id).onclick=()=>dialog.close();
  function open(){try{ready();dialog.showModal();sync();}catch(error){report(error);}}
  view.onclick=open;
  const accepted=transfer=>Array.from(transfer?.types||[]).some(type=>['Files','text/uri-list','text/html','text/plain'].includes(type));
  for(const zone of [section,dialog]){
    let depth=0;
    dialog.addEventListener('close',()=>{depth=0;zone.classList.remove('is-reference-drop');});
    for(const type of ['dragenter','dragover'])zone.addEventListener(type,event=>{
      if(!accepted(event.dataTransfer))return;event.preventDefault();event.stopPropagation();
      event.dataTransfer.dropEffect=isBusy()?'none':'copy';if(type==='dragenter')depth++;
      zone.classList.toggle('is-reference-drop',!isBusy());
    });
    zone.addEventListener('dragleave',()=>{if(--depth<=0){depth=0;zone.classList.remove('is-reference-drop');}});
    zone.addEventListener('drop',event=>{
      event.preventDefault();event.stopPropagation();depth=0;zone.classList.remove('is-reference-drop');
      try{ready();void runImport(sheetDropInput(event.dataTransfer));}catch(error){report(error);}
    });
    zone.addEventListener('paste',event=>{
      event.preventDefault();event.stopPropagation();
      try{ready();void runImport(Promise.resolve({files:clipboardImageFiles(event.clipboardData)}));}catch(error){report(error);}
    });
  }
  dialog.addEventListener('close',()=>{gallery.replaceChildren();displayed=[];section.classList.remove('is-reference-drop');});
  function sync(){
    const refs=getProject().references,busy=isBusy();
    for(const control of [document.getElementById('addReference'),view,paste,find('addComposerReferencePhotos'),find('pasteComposerReferencePhotos')])control.disabled=busy;
    for(const control of section.querySelectorAll('.reference-card button'))control.disabled=busy;
    section.setAttribute('aria-busy',String(busy));dialog.setAttribute('aria-busy',String(busy));
    find('composerReferenceTotal').textContent=`${refs.length} photo${refs.length===1?'':'s'}`;
    document.getElementById('referenceCount').textContent=`${refs.length} photo${refs.length===1?'':'s'}`;
    find('composerReferenceEmpty').hidden=refs.length>0;
    view.textContent='View all';view.setAttribute('aria-label',`View all ${refs.length} reference photos`);
    if(!dialog.open)return;
    const same=displayed.length===refs.length&&refs.every((ref,index)=>displayed[index].id===ref.id&&displayed[index].source===ref.source&&displayed[index].name===ref.name);
    if(!same){
      gallery.replaceChildren();displayed=refs.map(({id,source,name})=>({id,source,name}));
      for(const [index,ref] of refs.entries()){
        const card=document.createElement('article');card.className='composer-reference-photo';card.dataset.referenceId=ref.id;
        const photo=document.createElement('img');photo.alt=ref.name;photo.draggable=false;setPreviewImage(photo,ref);
        const name=document.createElement('strong');name.textContent=`${index+1}. ${ref.name}`;name.title=ref.name;
        const remove=document.createElement('button');remove.type='button';remove.textContent='Remove';remove.setAttribute('aria-label',`Remove generation reference ${ref.name}`);
        remove.onclick=()=>{try{ready();onRemove(ref.id);sync();}catch(error){report(error);}};
        card.append(photo,name,remove);gallery.append(card);
      }
    }
    for(const control of gallery.querySelectorAll('button'))control.disabled=busy;
  }
  sync();return {sync,open};
}
