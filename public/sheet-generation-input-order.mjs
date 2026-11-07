const need=(condition,message)=>{if(!condition)throw new Error(message);};
export function sheetGenerationInputOrder(plan,annotationPreviews=[],{readOriginal=image=>image,readGuide=image=>image,identity=image=>image.source}={}){
  const expectedIds=new Set(plan.annotated.map(({photo})=>photo.id)),previews=new Map();
  need(Array.isArray(annotationPreviews)&&annotationPreviews.length===expectedIds.size,'The sheet annotation guides are missing or do not match the selected photos. Rebuild the request.');
  for(const preview of annotationPreviews){
    need(preview&&typeof preview.id==='string'&&expectedIds.has(preview.id)&&!previews.has(preview.id),'An annotation guide has an unknown or duplicate photo ID.');
    previews.set(preview.id,preview.image);
  }
  const images=[],roles=[],originalIndices=new Map();
  for(const {role,photo} of plan.photos){
    const original=readOriginal(photo);let index=originalIndices.get(identity(original));
    if(index===undefined){images.push(original);index=images.length;originalIndices.set(identity(original),index);}
    roles.push({image:index,photoId:photo.id,role:role==='main'?'primary subject original':role==='subject'?'additional subject original':'detail reference original',filename:photo.name});
    if(previews.has(photo.id)){
      images.push(readGuide(previews.get(photo.id),photo));
      roles.push({image:images.length,photoId:photo.id,role:'annotation guide',originalImage:index,use:'Locate the circled or named subject/details. Do not copy marks into the result.'});
    }
  }
  return {images,roles};
}
