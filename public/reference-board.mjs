// Portable numbered boards contain the scene, linked photos and label instructions.
import { dimensions,validateProject,referenceLinks,referenceProject,labelComment,MAX_DIMENSION,MAX_PIXELS } from './core.mjs';
import { renderProjectPreview } from './render.mjs';

const WIDTH = 2000, MARGIN = 48, GAP = 24, TILE_PADDING = 24, IMAGE_HEIGHT = 400;
const NOTE_LINE_HEIGHT = 32, NOTE_GAP = 20, MAX_BOARD_HEIGHT = Math.min(MAX_DIMENSION,Math.floor(MAX_PIXELS/WIDTH));
export const REFERENCES_PER_BOARD = 12;
function canvas(width = 1,height = 1) { const item = document.createElement('canvas');item.width=width;item.height=height;return item; }
function fit(width,height,box) {
  const scale=Math.min(box.width/width,box.height/height),drawWidth=width*scale,drawHeight=height*scale;
  return {x:box.x+(box.width-drawWidth)/2,y:box.y+(box.height-drawHeight)/2,width:drawWidth,height:drawHeight};
}
const short = (text,length) => text.length>length?text.slice(0,length-1)+'…':text;
function wrap(context,text,width,maxLines) {
  const characters=Array.from(text.replace(/\s+/g,' ').trim()),lines=[];let line='',truncated=false;
  for (const character of characters) {
    if (line && context.measureText(line+character).width>width) {
      const breakAt=line.lastIndexOf(' ');
      if (breakAt>0) {lines.push(line.slice(0,breakAt));line=line.slice(breakAt+1)+character;}
      else {lines.push(line);line=character;}
      if (lines.length===maxLines) {truncated=true;break;}
    } else line+=character;
  }
  if (line && lines.length<maxLines) lines.push(line.trim());
  if (truncated) {
    let last=lines.at(-1).trimEnd();
    while(last && context.measureText(last+'…').width>width)last=last.slice(0,-1);
    lines[lines.length-1]=last+'…';
  }
  return lines.length?lines:[''];
}
// Notes are instructions: retain hard line breaks and every character, with no
// ellipsis or line cap. Long individual words wrap at character boundaries.
function wrapNotes(context,text,width) {
  if(!text?.trim())return [];
  const lines=[];
  for(const paragraph of text.replace(/\r\n?/g,'\n').split('\n')) {
    let line='';
    for(const character of Array.from(paragraph)) {
      if(line&&context.measureText(line+character).width>width) {
        const breakAt=line.lastIndexOf(' ');
        if(breakAt>0) {
          lines.push(line.slice(0,breakAt+1));line=line.slice(breakAt+1);
          if(line&&context.measureText(line+character).width>width) {lines.push(line);line='';}
          line+=character;
        }
        else {lines.push(line);line=character;}
      } else line+=character;
    }
    lines.push(line);
  }
  return lines;
}
export function linkedReferences(project) {
  const references=new Map(project.references.map(reference=>[reference.id,reference])),groups=new Map();
  for (const layer of project.layers) {
    if(!visibleLabel(project,layer))continue;
    for(const referenceId of referenceLinks(layer)) {
      const reference=references.get(referenceId);if(!reference)continue;
      if(!groups.has(reference.id))groups.set(reference.id,{reference,labels:[]});
      const group=groups.get(reference.id),label=layer.text.content.trim();
      if(!group.labels.includes(label))group.labels.push(label);
    }
  }
  return [...groups.values()];
}
// A numbered instruction can stand alone, without adding a reference photo.
export function linkedLabelComments(project) {
  const groups=new Map();
  for(const layer of project.layers) {
    if(!visibleLabel(project,layer))continue;
    const comment=labelComment(layer);if(!comment.trim())continue;
    const label=layer.text.content.trim(),signature=JSON.stringify([label,comment]);
    if(!groups.has(signature))groups.set(signature,{label,labels:[label],comment,layerIds:[]});
    groups.get(signature).layerIds.push(layer.id);
  }
  return [...groups.values()];
}
function visibleLabel(project,layer) { return layer.kind==='text'&&layer.visible&&layer.opacity>0&&layer.x<project.width&&layer.y<project.height&&layer.x+layer.width>0&&layer.y+layer.height>0; }
export function referenceBoardPages(project) {
  validateProject(project);
  const groups=linkedReferences(project),comments=linkedLabelComments(project);
  if(!groups.length&&!comments.length)throw new Error('Link a visible text label to a reference photo or add an instruction first.');
  const labels=new Map();
  for(const layer of project.layers) {
    if(!visibleLabel(project,layer))continue;
    const label=layer.text.content.trim(),photos=JSON.stringify(referenceLinks(layer).sort()),rawComment=labelComment(layer),comment=rawComment.trim()?rawComment:'',existing=labels.get(label);
    if(existing&&existing.photos!==photos)throw new Error(`Label “${short(label,80)}” is linked to different photos. Use a different number or the same reference photo.`);
    if(existing&&existing.comment!==comment)throw new Error(`Label “${short(label,80)}” has different instructions. Use a different number or the same instruction.`);
    labels.set(label,{photos,comment});
  }
  const entries=[...groups.map(group=>({group,kind:'photo'})),...comments.map(group=>({group,kind:'comment'}))];
  const pages=[];
  for(let index=0;index<entries.length;) {
    let accepted=null,count=Math.min(REFERENCES_PER_BOARD,entries.length-index);
    for(;count>0;count--) {
      const candidate=pageLayout(project,entries.slice(index,index+count),groups.length,comments.length);
      if(candidate.height<=MAX_BOARD_HEIGHT) {accepted=candidate;break;}
    }
    if(accepted) {pages.push(accepted);index+=count;continue;}
    // Newline-heavy instructions can exceed a page even at full width.
    // Repeat their numbered tile on continuation pages so none are omitted.
    const entry=entries[index],full=pageLayout(project,[entry],groups.length,comments.length),noteLines=full.tiles[0].noteLines;
    const empty=pageLayout(project,[{...entry,noteLines:[]}],groups.length,comments.length);
    const capacity=Math.floor((MAX_BOARD_HEIGHT-empty.height-NOTE_GAP-NOTE_LINE_HEIGHT)/NOTE_LINE_HEIGHT);
    if(capacity<1)throw new Error('The reference instructions cannot fit on a readable board page.');
    const notePartCount=Math.ceil(noteLines.length/capacity);
    for(let part=0;part<notePartCount;part++)pages.push(pageLayout(project,[{...entry,noteLines:noteLines.slice(part*capacity,(part+1)*capacity),notePart:part+1,notePartCount}],groups.length,comments.length));
    index++;
  }
  for(const [page,layout] of pages.entries()) {
    dimensions(layout.width,layout.height);
    Object.assign(layout,{page,pageNumber:page+1,pageCount:pages.length,hasNotes:groups.some(group=>group.reference.notes?.trim()),hasComments:comments.length>0});
  }
  return pages;
}
export function referenceBoardLayout(project,page=0) {
  const pages=referenceBoardPages(project);
  if(!Number.isInteger(page)||page<0||page>=pages.length)throw new Error('Choose an available reference board page.');
  return pages[page];
}
function pageLayout(project,entries,totalReferences,totalComments=0) {
  const available=WIDTH-MARGIN*2,mainScale=Math.min(available/project.width,2600/project.height);
  const mainFrame={x:MARGIN,y:212,width:available,height:Math.max(180,Math.ceil(project.height*mainScale))};
  const main=fit(project.width,project.height,mainFrame),columns=Math.min(3,entries.length),tileWidth=(available-GAP*(columns-1))/columns;
  const context=canvas().getContext('2d'),tiles=[];let y=mainFrame.y+mainFrame.height+76;
  for(let index=0;index<entries.length;index+=columns) {
    const row=entries.slice(index,index+columns).map(entry=>{
      const {group}=entry,kind=entry.kind||'photo';
      context.font='600 24px Arial';
      const labelLines=wrap(context,(kind==='comment'?'Label: ':'Labels: ')+group.labels.map(label=>short(label,160)).join(' • '),tileWidth-TILE_PADDING*2,10);
      context.font='20px Arial';
      const nameLines=wrap(context,kind==='comment'?'Instruction for this numbered area':short(group.reference.name||'Reference photo',240),tileWidth-TILE_PADDING*2,2);
      context.font='24px Arial';
      const noteLines=entry.noteLines??wrapNotes(context,kind==='comment'?group.comment:(group.reference.notes||''),tileWidth-TILE_PADDING*2);
      return {kind,group,labelLines,nameLines,noteLines,notePart:entry.notePart||1,notePartCount:entry.notePartCount||1,headerHeight:24+labelLines.length*30+12+nameLines.length*25+20};
    });
    const headerHeight=Math.max(...row.map(tile=>tile.headerHeight));
    const tileHeight=Math.max(...row.map(tile=>headerHeight+(tile.kind==='comment'?0:IMAGE_HEIGHT)+TILE_PADDING*2+(tile.noteLines.length?NOTE_GAP+(tile.noteLines.length+1)*NOTE_LINE_HEIGHT:0)));
    for(const [column,item] of row.entries()) {
      const x=MARGIN+column*(tileWidth+GAP),contentY=y+headerHeight+TILE_PADDING;
      const imageFrame=item.kind==='comment'?null:{x:x+TILE_PADDING,y:contentY,width:tileWidth-TILE_PADDING*2,height:IMAGE_HEIGHT};
      const notesFrame=item.noteLines.length?{x:x+TILE_PADDING,y:contentY+(imageFrame?IMAGE_HEIGHT:0)+NOTE_GAP,width:tileWidth-TILE_PADDING*2,height:(item.noteLines.length+1)*NOTE_LINE_HEIGHT}:null;
      tiles.push({...item,x,y,width:tileWidth,height:tileHeight,imageFrame,image:imageFrame?fit(item.group.reference.width,item.group.reference.height,imageFrame):null,notesFrame});
    }
    y+=tileHeight+GAP;
  }
  const height=Math.ceil(y-GAP+MARGIN);
  return {width:WIDTH,height,main,mainFrame,tiles,totalReferences,totalComments};
}
export async function renderReferenceBoard(project,target=canvas(),page=0) { return renderBoard(project,target,referenceBoardLayout(project,page)); }
// Export styling is fixed across appearance modes. These frames decorate the
// established layout; source images and instruction text keep their full bounds.
const BOARD_STYLE = {
  ink:'#4e4137',muted:'#897869',paper:'#fffefd',cream:'#fffaf4',
  peach:'#fff0e1',line:'#edc7a2',coral:'#b8523f',coralSoft:'#ffe9e1',
  green:'#eef5ed',greenLine:'#cbdcc8',greenInk:'#577c62',comment:'#fff4e5'
};
function roundedBox(context,x,y,width,height,radius,fill,stroke=null) {
  const r=Math.min(radius,width/2,height/2);
  context.beginPath();context.moveTo(x+r,y);context.lineTo(x+width-r,y);
  context.quadraticCurveTo(x+width,y,x+width,y+r);context.lineTo(x+width,y+height-r);
  context.quadraticCurveTo(x+width,y+height,x+width-r,y+height);context.lineTo(x+r,y+height);
  context.quadraticCurveTo(x,y+height,x,y+height-r);context.lineTo(x,y+r);
  context.quadraticCurveTo(x,y,x+r,y);context.closePath();
  if(fill){context.fillStyle=fill;context.fill();}
  if(stroke){context.strokeStyle=stroke;context.lineWidth=1.5;context.stroke();}
}
function boardIcon(context,kind,x,y,size=30) {
  context.save();context.translate(x,y);context.scale(size/32,size/32);
  context.lineCap='round';context.lineJoin='round';
  roundedBox(context,1,3,30,25,6,BOARD_STYLE.peach,'#c56c31');
  if(kind==='comment') {
    context.beginPath();context.moveTo(8,27);context.lineTo(8,31);context.lineTo(14,27);
    context.fillStyle=BOARD_STYLE.peach;context.fill();context.strokeStyle='#c56c31';context.lineWidth=1.5;context.stroke();
    context.beginPath();context.moveTo(8,11);context.lineTo(24,11);context.moveTo(8,17);context.lineTo(21,17);
    context.strokeStyle=BOARD_STYLE.muted;context.lineWidth=2;context.stroke();
  } else {
    context.beginPath();context.arc(23,10,3,0,Math.PI*2);context.fillStyle='#e18b6a';context.fill();
    context.beginPath();context.moveTo(6,23);context.lineTo(12,15);context.lineTo(17,20);context.lineTo(21,16);context.lineTo(27,23);context.closePath();
    context.fillStyle='#97b58f';context.fill();
  }
  context.restore();
}
async function renderBoard(project,target,layout,scene=null) {
  target.width=layout.width;target.height=layout.height;
  const context=target.getContext('2d');context.fillStyle='#ffffff';context.fillRect(0,0,target.width,target.height);context.textBaseline='top';
  roundedBox(context,MARGIN-16,24,WIDTH-MARGIN*2+32,138,18,BOARD_STYLE.cream);
  boardIcon(context,'photo',MARGIN,38,40);
  context.fillStyle=BOARD_STYLE.ink;context.font='700 32px Arial';context.fillText(layout.hasComments?'MAIN scene + references and instructions':'MAIN scene + appearance references',MARGIN+54,42);
  roundedBox(context,WIDTH-MARGIN-200,38,200,46,16,BOARD_STYLE.green,BOARD_STYLE.greenLine);
  context.save();context.textAlign='center';context.textBaseline='middle';context.fillStyle=BOARD_STYLE.greenInk;context.font='600 24px Arial';context.fillText(`Page ${layout.pageNumber} / ${layout.pageCount}`,WIDTH-MARGIN-100,61);context.restore();
  context.fillStyle=BOARD_STYLE.ink;
  context.font='24px Arial';
  context.fillText(`Keep MAIN composition, camera, object positions, and proportions. ${layout.pageCount===1?'Use this board page.':`Use all ${layout.pageCount} board pages.`}`,MARGIN,98);
  context.fillText(layout.hasComments?'Apply each numbered instruction and its linked photos. Remove number labels and guide marks in the final image.':(layout.hasNotes?'Match labels to all their photos, annotations, and written notes. Remove number labels and guide marks in the final image.':'Match labels to all their photos and reference annotations. Remove number labels and guide marks in the final image.'),MARGIN,132);
  boardIcon(context,'photo',MARGIN,168,30);
  context.fillStyle=BOARD_STYLE.ink;context.font='600 26px Arial';context.fillText('MAIN — preserve this scene frame and layout',MARGIN+40,170);
  roundedBox(context,layout.mainFrame.x-6,layout.mainFrame.y-6,layout.mainFrame.width+12,layout.mainFrame.height+12,14,BOARD_STYLE.cream,'#e1d8ca');
  if(!scene){scene=canvas();await renderProjectPreview(project,scene,{maxSide:2600,background:'#ffffff'});}
  context.drawImage(scene,layout.main.x,layout.main.y,layout.main.width,layout.main.height);
  context.strokeStyle='#d5cbbd';context.lineWidth=1;context.strokeRect(layout.main.x,layout.main.y,layout.main.width,layout.main.height);
  boardIcon(context,layout.totalReferences?'photo':'comment',MARGIN,layout.mainFrame.y+layout.mainFrame.height+25,30);
  context.fillStyle=BOARD_STYLE.ink;context.font='600 26px Arial';context.fillText(layout.hasComments?(layout.totalReferences?'REFERENCE PHOTOS + NUMBERED INSTRUCTIONS':'NUMBERED INSTRUCTIONS — apply to the matching labels'):'REFERENCE PHOTOS — use for the matching labels’ appearance',MARGIN+40,layout.mainFrame.y+layout.mainFrame.height+28);
  for(const tile of layout.tiles) {
    roundedBox(context,tile.x,tile.y,tile.width,tile.height,12,tile.kind==='comment'?BOARD_STYLE.comment:BOARD_STYLE.paper,'#e4d9cb');
    context.font='600 24px Arial';
    const labelWidth=Math.min(tile.width-36,Math.ceil(Math.max(...tile.labelLines.map(line=>context.measureText(line).width)))+12);
    roundedBox(context,tile.x+18,tile.y+18,labelWidth,tile.labelLines.length*30+12,10,BOARD_STYLE.coralSoft);
    context.fillStyle=BOARD_STYLE.coral;
    tile.labelLines.forEach((line,index)=>context.fillText(line,tile.x+TILE_PADDING,tile.y+24+index*30));
    context.fillStyle=BOARD_STYLE.muted;context.font='20px Arial';
    tile.nameLines.forEach((line,index)=>context.fillText(line,tile.x+TILE_PADDING,tile.y+24+tile.labelLines.length*30+12+index*25));
    context.strokeStyle='#eadfd2';context.lineWidth=1;context.beginPath();context.moveTo(tile.x+TILE_PADDING,tile.y+tile.headerHeight+8);context.lineTo(tile.x+tile.width-TILE_PADDING,tile.y+tile.headerHeight+8);context.stroke();
    boardIcon(context,tile.kind,tile.x+tile.width-TILE_PADDING-20,tile.y+tile.headerHeight-16,20);
    if(tile.imageFrame) {
      roundedBox(context,tile.imageFrame.x-4,tile.imageFrame.y-4,tile.imageFrame.width+8,tile.imageFrame.height+8,10,BOARD_STYLE.cream,'#e6ded1');
      context.fillStyle='#ffffff';context.fillRect(tile.imageFrame.x,tile.imageFrame.y,tile.imageFrame.width,tile.imageFrame.height);
      const image=canvas();await renderProjectPreview(referenceProject(tile.group.reference),image,{maxSide:Math.max(1,Math.ceil(Math.max(tile.image.width,tile.image.height)))});
      context.drawImage(image,tile.image.x,tile.image.y,tile.image.width,tile.image.height);
    }
    if(tile.notesFrame) {
      roundedBox(context,tile.notesFrame.x-10,tile.notesFrame.y-10,tile.notesFrame.width+20,tile.notesFrame.height+20,10,tile.kind==='comment'?BOARD_STYLE.cream:BOARD_STYLE.green,tile.kind==='comment'?BOARD_STYLE.line:BOARD_STYLE.greenLine);
      context.fillStyle=BOARD_STYLE.ink;context.font='600 24px Arial';
      const heading=tile.kind==='comment'?'Instruction':'Notes';
      context.fillText(tile.notePartCount>1?`${heading} — part ${tile.notePart} / ${tile.notePartCount}:`:`${heading}:`,tile.notesFrame.x,tile.notesFrame.y);
      boardIcon(context,'comment',tile.notesFrame.x+tile.notesFrame.width-24,tile.notesFrame.y,22);
      context.font='24px Arial';
      tile.noteLines.forEach((line,index)=>context.fillText(line,tile.notesFrame.x,tile.notesFrame.y+(index+1)*NOTE_LINE_HEIGHT));
    }
  }
  context.fillStyle=BOARD_STYLE.muted;context.font='18px Arial';context.fillText('Generated board · Full-resolution originals are in Complete reference pack.',MARGIN,layout.height-32);
  return target;
}
function png(target) {
  return new Promise((resolve,reject)=>target.toBlob(blob=>blob?resolve(blob):reject(new Error('Reference board export failed. Try smaller source images.')),'image/png'));
}
export async function exportReferenceBoard(project,page=0) { return png(await renderReferenceBoard(project,undefined,page)); }
export async function exportReferenceBoards(project) {
  const pages=referenceBoardPages(project),scene=canvas(),blobs=[];
  await renderProjectPreview(project,scene,{maxSide:2600,background:'#ffffff'});
  for(const layout of pages)blobs.push(await png(await renderBoard(project,canvas(),layout,scene)));
  return blobs;
}
