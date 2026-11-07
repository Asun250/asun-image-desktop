import {planGenerationInputPacking} from './public/generation-input-packing.mjs';

const need=(condition,message)=>{if(!condition)throw Object.assign(new Error(message),{statusCode:400});};
export const PACKED_INPUT_INSTRUCTIONS='Some uploaded images are LABELED REFERENCE BOARDS. Their tile captions Input N are logical source IDs, not uploaded-image indexes or object numbers. Use the image-order mapping to locate every original reference, annotation guide and selection mask within its named tile. Each tile preserves the full source aspect ratio without cropping. For a mask tile, only its imageRect is the full-canvas white/black mask: map that rectangle back to the working canvas and ignore the surrounding white board, captions and padding. Photos and masks in neighboring tiles never share coordinates. Use every mapped tile for its matching area. Do not reproduce board layouts, tile captions or guide marks in the final scene. Boards are reduced reference copies; originals remain in the editable project. The composition and explicit Blender blockout remain standalone structural authorities.';

/** Validate client boards against a server-rebuilt plan, never client roles. */
export function applyGenerationInputPacking(images,roles,boards,readImage,maxBytes){
  const plan=planGenerationInputPacking(images,roles),expected=plan.slots.map((slot,index)=>({slot,index})).filter(item=>item.slot.kind==='board');
  need(Array.isArray(boards)&&boards.length===expected.length,'Reference boards are missing or out of date. Refresh Asun IMG and generate again to include every reference.');
  if(!plan.packed)return {images,roles,plan,inputPacking:null};
  const allowed=new Map(expected.map(({slot,index})=>[index+1,slot])),decoded=new Map();
  for(const board of boards){
    need(board&&Number.isInteger(board.slot)&&allowed.has(board.slot)&&!decoded.has(board.slot),'Reference boards contain an unknown or duplicate image. Rebuild the request.');
    const image=readImage(board.image),slot=allowed.get(board.slot);
    need(image.mimeType==='image/png'&&image.width===slot.width&&image.height===slot.height,'A reference board does not match the required layout. Rebuild the request.');
    decoded.set(board.slot,image);
  }
  const locations=new Map();
  plan.slots.forEach((slot,index)=>{
    if(slot.kind==='single')locations.set(slot.sourceIndex,{image:index+1});
    else slot.tiles.forEach(tile=>locations.set(tile.sourceIndex,{image:index+1,tile:tile.label,imageRect:tile.imageRect}));
  });
  const remapRole=role=>{
    const {image,originalImage,...rest}=role;
    return {...rest,...(originalImage===undefined?{}:{originalLocation:locations.get(originalImage)})};
  };
  const output=[],mapped=[];
  plan.slots.forEach((slot,index)=>{
    if(slot.kind==='single'){
      output.push(images[slot.sourceIndex-1]);
      for(const role of roles.filter(role=>role.image===slot.sourceIndex))mapped.push({image:index+1,...remapRole(role)});
    }else{
      output.push(decoded.get(index+1));
      mapped.push({image:index+1,role:'labeled reference board',name:`Reference board ${index+1}`,tiles:slot.tiles.map(tile=>{
        const image=images[tile.sourceIndex-1];
        return {sourceInput:tile.sourceIndex,label:tile.label,imageRect:tile.imageRect,source:{sha256:image.sha256,width:image.width,height:image.height,mimeType:image.mimeType},roles:roles.filter(role=>role.image===tile.sourceIndex).map(remapRole)};
      })});
    }
  });
  need(output.length<=16,'The packed request exceeds the provider image limit.');
  need(output.reduce((sum,image)=>sum+image.byteLength,0)<=maxBytes,'The packed images exceed 64 MB. Reduce image sizes before generating; no references were dropped.');
  // The review API limits each physical image's role manifest to 32 KiB.
  for(let index=0;index<output.length;index++)need(Buffer.byteLength(JSON.stringify([{index:index+1,roles:mapped.filter(role=>role.image===index+1)}]),'utf8')<=32*1024,'A reference board has too much mapping information. Reduce this job’s references or notes; no references were dropped.');
  return {images:output,roles:mapped,plan,inputPacking:{version:1,logicalInputCount:images.length,physicalInputCount:output.length,boardCount:expected.length}};
}

// Hashes remain in result history, but are not useful model instructions.
export function packingPromptRoles(roles){return roles.map(role=>role.tiles?{...role,tiles:role.tiles.map(({source,...tile})=>tile)}:role);}
