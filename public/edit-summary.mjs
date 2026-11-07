// A live, read-only view of current labels and their saved instructions.
// Its generated detail previews never replace native image bytes or thumbnails.
import {editSummary} from './edit-summary-model.mjs';
import {previewSource} from './image-source.mjs';
import {decodeImage,renderProjectPreview} from './render.mjs';
import {isSketchProject,sketchContentLayers} from './sketch-project.mjs';

const element=(tag,className,text)=>{
  const node=document.createElement(tag);
  if(className)node.className=className;
  if(text!==undefined)node.textContent=text;
  return node;
};
const plural=(count,singular,pluralWord=`${singular}s`)=>`${count} ${count===1?singular:pluralWord}`;
const safeSource=source=>typeof source==='string'&&/^data:image\/(?:png|jpeg|webp);base64,[A-Za-z0-9+/=]+$/.test(source);
const annotationCounts=reference=>{
  const annotations=reference.annotations||[];
  return {text:annotations.filter(item=>item.kind==='text').length,pencil:annotations.filter(item=>item.kind==='drawing'&&item.drawing.mode==='pencil').length,highlight:annotations.filter(item=>item.kind==='drawing'&&item.drawing.mode==='highlight').length};
};
function annotationDescription(reference){
  const counts=annotationCounts(reference),parts=[];
  if(counts.text)parts.push(plural(counts.text,'text / number','texts / numbers'));
  if(counts.pencil)parts.push(plural(counts.pencil,'pencil mark'));
  if(counts.highlight)parts.push(plural(counts.highlight,'highlight'));
  return parts.join(' · ');
}

function cardSignature(item){
  // Original data URLs and stroke points are deliberately absent. Small saved
  // metadata tells the card whether to update without copying large sources.
  return JSON.stringify({label:item.label,groupAreaCount:item.objectRegion?.group?.areaCount||0,comment:item.comment,status:item.status,boardIncluded:item.boardIncluded,pending:item.pending,exclusionReasons:item.exclusionReasons,warnings:item.warnings,conflictReasons:item.conflictReasons,references:item.references.map(reference=>({id:reference.id,name:reference.name,notes:reference.notes||'',annotations:annotationCounts(reference)})),source:item.regionSource?{assetId:item.regionSource.asset.id,bounds:item.regionSource.nativeBounds}:null});
}
function sameSources(record,item){
  return record.source===item.regionSource?.asset.source&&record.referenceSources.length===item.references.length&&record.referenceSources.every((source,index)=>source===item.references[index].source);
}

/**
 * The parent supplies saved project snapshots and controls panel placement and
 * collapse. onOpen opens the existing references/comment dialog for a label.
 */
export function createEditSummary(panel,{onOpen=()=>{},onError=()=>{}}={}){
  const list=panel.querySelector('#editSummaryList'),count=panel.querySelector('#editSummaryCount'),prompt=panel.querySelector('#editSummaryPrompt'),content=panel.querySelector('#editSummaryContent');
  if(!list||!count||!prompt||!content)throw new Error('The edit summary panel is incomplete.');
  const cards=new Map(),detailPreviews=new Map();
  let disposed=false,projectIdentity=null,projectSource=null,lastPrompt=null,sketchProject=null,sketchRevision=0;
  const report=error=>{if(!disposed)onError(error);};

  function openCard(event,card){
    if(event.type==='click'){
      const selection=window.getSelection();
      if(selection&&!selection.isCollapsed&&selection.anchorNode&&card.contains(selection.anchorNode))return;
      if(event.button!==0)return;
    }
    try{onOpen(card.dataset.layerId);}catch(error){report(error);}
  }
  function previewImage(holder,{alt,title}){
    const image=element('img');image.alt=alt;image.title=title;image.draggable=false;
    holder.append(image);
    return image;
  }
  function displayPreview(image,pending,record,token){
    pending.then(source=>{
      if(disposed||record.token!==token||!image.isConnected)return;
      if(!safeSource(source))throw new Error('A generated summary preview is unavailable.');
      image.src=source;image.closest('.edit-summary-preview')?.classList.add('has-preview');
    }).catch(()=>{
      if(disposed||record.token!==token||!image.isConnected)return;
      const holder=image.parentElement;
      image.remove();
      holder?.classList.remove('has-preview');
      if(holder){holder.title='Preview unavailable. Original image remains saved in the project.';const fallback=holder.querySelector('.edit-summary-preview-placeholder');if(fallback)fallback.textContent='?';}
      // Preview errors stay local; originals remain present and editable.
    });
  }
  function detailPreview(item,project){
    if(isSketchProject(project)&&item.regionBounds){
      const bounds=item.regionBounds,padding=Math.max(4,Math.max(bounds.width,bounds.height)*.1);
      const x=Math.max(0,Math.floor(bounds.x-padding)),y=Math.max(0,Math.floor(bounds.y-padding));
      const width=Math.max(1,Math.ceil(Math.min(project.width,bounds.x+bounds.width+padding)-x)),height=Math.max(1,Math.ceil(Math.min(project.height,bounds.y+bounds.height+padding)-y));
      const key=JSON.stringify(['sketch',sketchRevision,x,y,width,height]),old=detailPreviews.get(key);
      if(old)return old.pending;
      // Render the crop at thumbnail scale directly. The original white surface
      // is only an anchor; editable pencil content supplies the actual subject.
      const content=sketchContentLayers(project).map(layer=>({...layer,x:layer.x-x,y:layer.y-y}));
      const pending=(async()=>{
        const maxSide=Math.max(1,Math.floor(Math.max(width,height)*Math.min(1,160/width,112/height)));
        const canvas=await renderProjectPreview({...project,width,height,layers:content},document.createElement('canvas'),{maxSide,background:project.sketch.background});
        return canvas.toDataURL('image/png');
      })();
      detailPreviews.set(key,{pending});
      if(detailPreviews.size>100)detailPreviews.delete(detailPreviews.keys().next().value);
      pending.catch(()=>{if(detailPreviews.get(key)?.pending===pending)detailPreviews.delete(key);});
      return pending;
    }
    const {asset,nativeBounds:bounds}=item.regionSource;
    if(!safeSource(asset.source))return Promise.reject(new Error('The selected area has no local source preview.'));
    const key=JSON.stringify([asset.id,bounds.x,bounds.y,bounds.width,bounds.height]);
    const old=detailPreviews.get(key);
    if(old?.source===asset.source)return old.pending;
    const pending=(async()=>{
      const image=await decodeImage(asset.source),padding=Math.max(4,Math.max(bounds.width,bounds.height)*.1);
      const x=Math.max(0,bounds.x-padding),y=Math.max(0,bounds.y-padding),width=Math.max(1,Math.min(asset.width,bounds.x+bounds.width+padding)-x),height=Math.max(1,Math.min(asset.height,bounds.y+bounds.height+padding)-y);
      const scale=Math.min(1,160/width,112/height),canvas=document.createElement('canvas');
      canvas.width=Math.max(1,Math.round(width*scale));canvas.height=Math.max(1,Math.round(height*scale));
      canvas.getContext('2d').drawImage(image,x,y,width,height,0,0,canvas.width,canvas.height);
      return canvas.toDataURL('image/png');
    })();
    detailPreviews.set(key,{source:asset.source,pending});
    if(detailPreviews.size>100)detailPreviews.delete(detailPreviews.keys().next().value);
    pending.catch(()=>{if(detailPreviews.get(key)?.pending===pending)detailPreviews.delete(key);});
    return pending;
  }
  function renderCard(record,item,project){
    const card=record.node,token=++record.token;
    card.dataset.status=item.status;card.dataset.boardIncluded=String(item.boardIncluded);
    card.setAttribute('aria-label',`Edit references and comment for ${item.label||'this area'}`);
    const header=element('div','edit-summary-card-heading'),preview=element('div','edit-summary-preview edit-summary-source-preview');
    preview.append(element('span','edit-summary-preview-placeholder',item.regionSource?'…':'T'));
    if(item.regionSource){
      const {asset}=item.regionSource;
      const image=previewImage(preview,{alt:`Selected area ${item.label}`,title:isSketchProject(project)?'Sketch detail preview · editable drawing retained':`Generated detail preview · original ${asset.width} × ${asset.height} px retained`});
      displayPreview(image,detailPreview(item,project),record,token);
    }else preview.title='Text label · no detected object region';
    // Keep the saved label literal in its own badge. Its position and visual
    // styling are presentation only; exports still use the project label.
    const badge=element('strong','edit-summary-label edit-summary-number-badge',item.label||'(empty label)');
    badge.classList.toggle('is-text-label',!/^\d+$/.test(item.label));
    const heading=element('div','edit-summary-card-title');
    heading.append(element('strong','edit-summary-area-title',item.objectRegion?.group?`Group · ${item.objectRegion.group.areaCount} areas`:item.regionSource?'Selected area':'Text label'));
    const status=item.status==='excluded'?'Excluded from board':item.status==='conflict'?'Conflicting label':item.status==='pending'?'Add an instruction or reference':'Included on board';
    heading.append(element('span','edit-summary-status',status));
    if(item.regionSource)heading.append(element('span','edit-summary-origin',isSketchProject(project)?'Linked to sketch':'Linked to image'));
    else heading.append(element('span','edit-summary-origin','Manual annotation'));
    header.append(badge,heading,preview);
    const children=[header];
    if(item.comment.trim()){
      const section=element('section','edit-summary-instruction');
      section.append(element('h3',null,'Area comment'),element('p','edit-summary-comment',item.comment));
      children.push(section);
    }
    if(item.references.length){
      const section=element('section','edit-summary-references');
      section.append(element('h3',null,plural(item.references.length,'reference photo')));
      const gallery=element('div','edit-summary-reference-gallery');
      for(const reference of item.references){
        const row=element('div','edit-summary-reference');row.dataset.referenceId=reference.id;
        const thumbnail=element('div','edit-summary-preview edit-summary-reference-preview');thumbnail.append(element('span','edit-summary-preview-placeholder','…'));
        const image=previewImage(thumbnail,{alt:`Reference ${reference.name}`,title:`Generated thumbnail · original ${reference.width} × ${reference.height} px retained`});
        displayPreview(image,safeSource(reference.source)?previewSource(reference):Promise.reject(new Error('The reference has no local source preview.')),record,token);
        const description=element('div','edit-summary-reference-description');
        description.append(element('span','edit-summary-reference-name',reference.name));
        if(reference.notes?.trim())description.append(element('p','edit-summary-reference-note',reference.notes));
        const annotations=annotationDescription(reference);
        if(annotations)description.append(element('span','edit-summary-reference-annotations',annotations));
        row.append(thumbnail,description);gallery.append(row);
      }
      section.append(gallery);
      children.push(section);
    }
    if(item.pending)children.push(element('p','edit-summary-pending','No comment or reference yet. Click to add one.'));
    for(const message of [...item.exclusionReasons,...item.conflictReasons,...item.warnings])children.push(element('p','edit-summary-warning',message));
    card.replaceChildren(...children);
    record.signature=cardSignature(item);record.source=item.regionSource?.asset.source;record.referenceSources=item.references.map(reference=>reference.source);record.sketchRevision=isSketchProject(project)?sketchRevision:0;
  }
  function update(project,selectedId){
    if(disposed)return;
    const currentSketch=isSketchProject(project)?project:null;
    if(sketchProject!==currentSketch){sketchProject=currentSketch;sketchRevision++;detailPreviews.clear();}
    const summary=editSummary(project),primaryId=project.original?.assetId||Object.keys(project.assets)[0]||null,primarySource=primaryId?project.assets[primaryId]?.source:null;
    if(projectIdentity!==primaryId||projectSource!==primarySource){
      for(const record of cards.values())record.token++;
      cards.clear();detailPreviews.clear();list.replaceChildren();content.scrollTop=0;projectIdentity=primaryId;projectSource=primarySource;
    }
    const keys=new Set(summary.items.map(item=>item.layerId));
    for(const [key,record] of cards)if(!keys.has(key)){record.token++;record.node.remove();cards.delete(key);}
    const order=[];
    for(const item of summary.items){
      let record=cards.get(item.layerId);
      if(!record){
        const node=element('article','edit-summary-card');node.dataset.layerId=item.layerId;node.tabIndex=0;node.setAttribute('role','button');
        record={node,token:0,signature:null,source:null,referenceSources:[]};cards.set(item.layerId,record);
        node.addEventListener('click',event=>openCard(event,node));
        node.addEventListener('keydown',event=>{if((event.key==='Enter'||event.key===' ')&&!event.ctrlKey&&!event.metaKey&&!event.altKey&&!event.isComposing){event.preventDefault();event.stopPropagation();openCard(event,node);}});
      }
      if(record.signature!==cardSignature(item)||!sameSources(record,item)||record.sketchRevision!==(currentSketch?sketchRevision:0))renderCard(record,item,project);
      record.node.classList.toggle('is-selected',item.layerId===selectedId);record.node.setAttribute('aria-pressed',String(item.layerId===selectedId));order.push(record.node);
    }
    if(!order.length){
      if(!list.querySelector('.edit-summary-empty'))list.replaceChildren(element('p','edit-summary-empty','Choose and number an area, then add a comment or reference. Your edit summary will appear here.'));
    }else{
      list.querySelector('.edit-summary-empty')?.remove();
      // Move only out-of-order cards. Existing focus, selection and scroll stay
      // in place during hover, selection, prompt and unrelated editor updates.
      order.forEach((node,index)=>{if(list.children[index]!==node)list.insertBefore(node,list.children[index]||null);});
    }
    const detail=[];
    if(summary.counts.excluded)detail.push(plural(summary.counts.excluded,'excluded area'));
    if(summary.counts.pending)detail.push(plural(summary.counts.pending,'area awaiting instructions','areas awaiting instructions'));
    if(summary.counts.conflicts)detail.push(plural(summary.counts.conflicts,'label conflict'));
    if(summary.counts.unassignedReferences)detail.push(plural(summary.counts.unassignedReferences,'unlinked photo'));
    const countText=`${plural(summary.counts.total,'area')} · ${summary.counts.included} on board${detail.length?'\n'+detail.join(' · '):''}`;
    if(count.textContent!==countText)count.textContent=countText;
    if(lastPrompt!==summary.globalPrompt){
      lastPrompt=summary.globalPrompt;prompt.hidden=!summary.globalPrompt.trim();
      prompt.replaceChildren(element('h3',null,'Scene prompt'),element('p','edit-summary-global-prompt',summary.globalPrompt));
    }
    panel.dataset.areaCount=String(summary.counts.total);
    panel.dataset.conflicts=String(summary.counts.conflicts);
  }
  const wheel=event=>event.stopPropagation();
  const keydown=event=>{
    const command=event.ctrlKey||event.metaKey,key=event.key.toLowerCase(),selection=window.getSelection();
    const copyingText=key==='c'&&selection&&!selection.isCollapsed&&selection.anchorNode&&panel.contains(selection.anchorNode);
    // A summary is readable text. Native copy must not trigger image copying;
    // ordinary keys here must not switch tools, move or delete scene layers.
    if(!command||key==='a'||copyingText)event.stopPropagation();
  };
  panel.addEventListener('wheel',wheel,{passive:true});panel.addEventListener('keydown',keydown);
  return {update,dispose(){disposed=true;sketchProject=null;for(const record of cards.values())record.token++;cards.clear();detailPreviews.clear();panel.removeEventListener('wheel',wheel);panel.removeEventListener('keydown',keydown);}};
}
