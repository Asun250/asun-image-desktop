import {referenceSearchUrl} from './reference-search.mjs';
import {sheetDropInput,sheetWebPhotoFile} from './sheet-photo-drop.mjs';
import {clipboardImageFiles,readClipboardImages} from './clipboard.mjs';

// Search is an explicit action. A result becomes a normal editable photo only
// after the user chooses it; closing the dialog invalidates pending imports.
export function mountMainImageSearch({getProject,beforeOpen,onImport,onError}) {
  const $=id=>document.getElementById(id);
  const dialog=document.createElement('dialog');dialog.id='mainImageSearchDialog';
  dialog.setAttribute('aria-labelledby','mainImageSearchTitle');
  dialog.innerHTML=`<header class="main-search-heading"><div><h2 id="mainImageSearchTitle">Find your starting image</h2><p>Choose a photo, then use Auto detect or Highlight to select what you want to change.</p></div><button id="closeMainImageSearch" type="button" aria-label="Close image search">×</button></header>
    <form id="mainImageSearchForm" class="main-search-form"><label for="mainImageSearchQuery">Search images on the web</label><div><input id="mainImageSearchQuery" type="search" maxlength="200" placeholder="Try a city skyline, a bird or a coffee cup" autocomplete="off" required><button id="submitMainImageSearch" class="primary" type="submit">Search images</button></div></form>
    <div class="main-search-options"><button id="mainSearchGoogle" type="button" class="quiet">Search Google Images ↗</button><button id="mainSearchUpload" type="button" class="quiet">Choose a photo</button><button id="mainSearchPaste" type="button" class="quiet">Paste image</button></div>
    <details class="main-search-address"><summary>Use an image link</summary><form id="mainImageURLForm"><label for="mainImageURL">Direct image address</label><div><input id="mainImageURL" type="url" placeholder="https://…/photo.jpg" required><button id="mainImageURLImport" class="quiet" type="submit">Use image</button></div></form></details>
    <p id="mainImageSearchStatus" role="status" aria-live="polite">Search above, or drop a photo here. You can also copy an image from your browser and paste it here.</p>
    <p id="mainImageSearchError" role="alert" hidden></p>
    <div id="mainImageSearchResults" aria-label="Web image results"></div>
    <button id="mainImageSearchMore" type="button" class="quiet" hidden>View more ↓</button>
    <footer class="main-search-footer">Your chosen photo is added to the canvas. Existing layers stay intact.</footer>
    <input id="mainSearchFileInput" type="file" accept="image/png,image/jpeg,image/webp" multiple hidden>`;
  document.body.append(dialog);
  const empty=$('emptyState');empty.querySelector('p').textContent='Find an image on the web, choose a photo, or drop one here to start.';
  const form=document.createElement('form');form.id='mainStartSearchForm';form.className='main-start-search';
  form.innerHTML='<label for="mainStartSearchQuery">Search the web for an image</label><div><input id="mainStartSearchQuery" type="search" maxlength="200" placeholder="What would you like to create?" autocomplete="off"><button type="submit" class="primary">Search images</button></div>';
  const importButton=$('importEmpty');importButton.before(form);
  const actions=document.createElement('div');actions.className='main-start-actions';importButton.before(actions);actions.append(importButton);
  const paste=document.createElement('button');paste.id='pasteEmpty';paste.type='button';paste.className='quiet';paste.textContent='Paste image';actions.append(paste);
  const hint=document.createElement('small');hint.className='main-start-detection';hint.textContent='Choose a photo → Auto detect or Highlight → Add references';empty.append(hint);
  const toolbar=document.createElement('button');toolbar.id='searchMainImages';toolbar.type='button';toolbar.className='quiet';toolbar.textContent='⌕ Search images';toolbar.title='Find a web image or choose a photo to add to the canvas';$('importTop').before(toolbar);
  let session=null,serial=0,searchController=null,importController=null,query='',nextPage=null,loading=false,importing=false;
  const alive=current=>Boolean(current&&session===current&&dialog.open);
  function message(text,error=false){$(error?'mainImageSearchError':'mainImageSearchStatus').textContent=text;if(error)$('mainImageSearchError').hidden=!text;}
  function controls(){
    for(const id of ['submitMainImageSearch','mainImageSearchMore'])$(id).disabled=loading||importing;
    for(const id of ['mainSearchUpload','mainSearchPaste','mainImageURLImport'])$(id).disabled=importing;
    dialog.querySelectorAll('[data-use-web-image]').forEach(button=>button.disabled=importing);
    dialog.setAttribute('aria-busy',String(loading||importing));
  }
  function open(value='') {
    if(dialog.open)return session;
    try{beforeOpen();}catch(error){onError(error.message);return null;}
    session={id:++serial,project:getProject()};loading=false;importing=false;query='';nextPage=null;
    $('mainImageSearchQuery').value=value;$('mainImageURL').value='';$('mainImageSearchResults').replaceChildren();$('mainImageSearchMore').hidden=true;
    message('');message('Search above, or drop a photo here. You can also copy an image from your browser and paste it here.');message('',true);controls();
    dialog.showModal();$('mainImageSearchQuery').focus();return session;
  }
  function close(){dialog.close();}
  dialog.addEventListener('close',()=>{session=null;searchController?.abort();importController?.abort();loading=false;importing=false;});
  $('closeMainImageSearch').onclick=close;
  toolbar.onclick=()=>open();
  form.onsubmit=event=>{event.preventDefault();if(open($('mainStartSearchQuery').value)&&$('mainStartSearchQuery').value.trim())search();};
  paste.onclick=()=>{if(open())pasteImages();};
  function external(){window.open(referenceSearchUrl($('mainImageSearchQuery').value),'_blank','noopener,noreferrer');message('In the browser, copy the image and return to Paste image, or drag the photo into this window.');}
  $('mainSearchGoogle').onclick=external;
  function publicLink(value){try{const url=new URL(value);return ['https:','http:'].includes(url.protocol)&&!url.username&&!url.password?url.href:null;}catch{return null;}}
  function resultCard(item) {
    const imageURL=publicLink(item.imageUrl);if(!imageURL)return null;
    const card=document.createElement('article');card.className='main-search-result';
    const pick=document.createElement('button');pick.type='button';pick.dataset.useWebImage=imageURL;pick.setAttribute('aria-label','Use image: '+(item.title||'Web photo'));
    const img=document.createElement('img');img.alt=item.title||'Web photo';img.loading='lazy';img.referrerPolicy='no-referrer';img.draggable=false;
    const thumbnail=/^\/api\/image-search\/thumbnail\?id=[a-f0-9]{32}$/.test(item.thumbnailUrl||'')?item.thumbnailUrl:publicLink(item.thumbnailUrl);if(thumbnail)img.src=thumbnail;img.onerror=()=>{img.hidden=true;pick.classList.add('preview-unavailable');};
    const label=document.createElement('span');label.textContent='Use image';pick.append(img,label);pick.onclick=()=>importInput({files:[],urls:[imageURL]});
    const title=document.createElement('strong');title.textContent=item.title||'Web photo';
    const source=document.createElement('a');source.textContent=item.sourceName||'View source ↗';source.href=publicLink(item.sourceUrl)||imageURL;source.target='_blank';source.rel='noopener noreferrer';
    card.append(pick,title,source);return card;
  }
  async function search(more=false) {
    if(importing||!session)return;
    const requested=more?query:$('mainImageSearchQuery').value.trim();if(!requested){$('mainImageSearchQuery').focus();return;}
    searchController?.abort();const controller=new AbortController();searchController=controller;const current=session;
    if(!more){query=requested;nextPage=null;$('mainImageSearchResults').replaceChildren();$('mainImageSearchMore').hidden=true;}
    loading=true;controls();message('',true);message(more?'Loading more images…':'Searching the web…');
    try{
      const params=new URLSearchParams({q:requested});if(more&&nextPage!==null)params.set('page',String(nextPage));
      const response=await fetch('/api/image-search?'+params,{signal:controller.signal});let data;
      try{data=await response.json();}catch{throw new Error('Web search is not available yet. Restart the desktop app, or use Search Google Images.');}
      if(!response.ok)throw new Error(data.error||'Web search is unavailable. Try Search Google Images, or paste a photo.');
      if(!alive(current)||searchController!==controller)return;
      let added=0;const seen=new Set([...$('mainImageSearchResults').querySelectorAll('[data-use-web-image]')].map(el=>el.dataset.useWebImage));
      for(const item of data.images||[]){const card=resultCard(item);if(card&&!seen.has(card.querySelector('button').dataset.useWebImage)){seen.add(card.querySelector('button').dataset.useWebImage);$('mainImageSearchResults').append(card);added++;}}
      nextPage=data.nextPage??null;$('mainImageSearchMore').hidden=nextPage===null;
      const count=$('mainImageSearchResults').children.length;
      message(count?`${count} images${data.provider?' · '+data.provider:''}. Choose Use image to start editing.`:'No images found. Try different words, or Search Google Images.');
      if(more&&added===0&&nextPage===null)message('You have reached the end of these results. Try another search for more images.');
    }catch(error){if(alive(current)&&!controller.signal.aborted){message('Search Google Images, choose a photo, or paste an image to continue.');message(error.message,true);}}
    finally{if(alive(current)&&searchController===controller){loading=false;controls();}}
  }
  $('mainImageSearchForm').onsubmit=event=>{event.preventDefault();search();};$('mainImageSearchMore').onclick=()=>search(true);
  async function importInput(inputOrPromise){
    if(importing||!session)return;const current=session;importing=true;searchController?.abort();loading=false;importController=new AbortController();const controller=importController;
    controls();message('',true);message('Loading image…');
    try{
      const input=await inputOrPromise;if(!alive(current))return;
      const files=[...input.files];for(const url of input.urls||[]){files.push(await sheetWebPhotoFile(url,(url,options)=>fetch(url,{...options,signal:controller.signal})));if(!alive(current))return;}
      if(!files.length)throw new Error('Choose a PNG, JPEG or WebP photo.');
      if(getProject()!==current.project)throw new Error('The project changed. Close this window and choose the image again.');
      await onImport(files,current.project,()=>alive(current));if(alive(current))close();
    }catch(error){if(alive(current)&&!controller.signal.aborted){message('Your canvas has not been changed. Choose another image or try pasting it.');message(['NotAllowedError','SecurityError'].includes(error.name)?'Clipboard access was blocked. Copy the image, then press Ctrl+V in this window.':error.message,true);}}
    finally{if(alive(current)){importing=false;controls();}}
  }
  function pasteImages(){if(!importing)importInput(readClipboardImages().then(files=>({files,urls:[]})));}
  $('mainSearchPaste').onclick=pasteImages;
  $('mainSearchUpload').onclick=()=>{$('mainSearchFileInput').value='';$('mainSearchFileInput').click();};
  $('mainSearchFileInput').onchange=event=>{if(event.target.files.length)importInput({files:[...event.target.files],urls:[]});};
  $('mainImageURLForm').onsubmit=event=>{event.preventDefault();importInput({files:[],urls:[$('mainImageURL').value.trim()]});};
  dialog.addEventListener('paste',event=>{
    let files;try{files=clipboardImageFiles(event.clipboardData);}catch{if(event.target.closest('input,textarea'))return;event.preventDefault();message('Copy the actual image, or paste its address under Use an image link.',true);return;}
    event.preventDefault();event.stopPropagation();importInput({files,urls:[]});
  });
  for(const type of ['dragenter','dragover'])dialog.addEventListener(type,event=>{event.preventDefault();event.stopPropagation();event.dataTransfer.dropEffect=importing?'none':'copy';dialog.classList.toggle('is-dragover',!importing);});
  dialog.addEventListener('dragleave',event=>{if(!dialog.contains(event.relatedTarget))dialog.classList.remove('is-dragover');});
  dialog.addEventListener('drop',event=>{event.preventDefault();event.stopPropagation();dialog.classList.remove('is-dragover');if(importing)return;try{importInput(sheetDropInput(event.dataTransfer));}catch(error){message(error.message,true);}});
  return {open,importDrop(transfer){let input;try{input=sheetDropInput(transfer);}catch(error){onError(error.message);return;}if(open())importInput(input);}};
}
