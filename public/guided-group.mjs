// Each highlighted object is detected separately. Only the confirmed masks are
// combined, so unselected background between objects never becomes an edit area.
import {guidedMarkTarget} from './guided-detection.mjs';
import {validateRegionMask,MAX_REGION_RUNS} from './object-regions.mjs';

export const MAX_GUIDED_GROUP_AREAS=100;
const MAX_GROUP_INPUT_RUNS=4_000_000;
const requireThat=(condition,message)=>{if(!condition)throw new Error(message);};

export function guidedMarkTargets(project,selectedId) {
  const selected=guidedMarkTarget(project,selectedId);
  if(!selected)return [];
  if(selected.mark.drawing.mode!=='highlight')return [selected];
  const targets=[];
  for(const mark of project.layers) {
    if(mark.kind!=='drawing'||mark.drawing?.mode!=='highlight')continue;
    const target=mark.id===selectedId?selected:guidedMarkTarget(project,mark.id);
    if(target?.raster.id!==selected.raster.id)continue;
    targets.push(target);
    requireThat(targets.length<=MAX_GUIDED_GROUP_AREAS,`Use at most ${MAX_GUIDED_GROUP_AREAS} highlights in one detection group. Hide other highlights to leave them out.`);
  }
  return targets;
}

export function unionRegionMasks(masks) {
  requireThat(Array.isArray(masks)&&masks.length>0&&masks.length<=MAX_GUIDED_GROUP_AREAS,'Choose between 1 and 100 selections to combine.');
  let width,height,totalRuns=0,pixels;
  for(const mask of masks) {
    validateRegionMask(mask);
    if(!pixels){({width,height}=mask);pixels=new Uint8Array(width*height);}
    requireThat(mask.width===width&&mask.height===height,'Grouped selections must use the same image dimensions.');
    totalRuns+=mask.counts.length;
    requireThat(totalRuns<=MAX_GROUP_INPUT_RUNS,'These selections contain too much detail. Detect fewer highlighted areas together.');
    let offset=0;
    for(let index=0;index<mask.counts.length;index++) {
      const end=offset+mask.counts[index];
      if(index%2)pixels.fill(1,offset,end);
      offset=end;
    }
  }
  const counts=[];let previous=0,count=0;
  for(const pixel of pixels) {
    if(pixel===previous)count++;
    else {
      counts.push(count);count=1;previous=pixel;
      requireThat(counts.length<MAX_REGION_RUNS,'The combined selection contains too much detail. Detect fewer highlighted areas together.');
    }
  }
  counts.push(count);
  return validateRegionMask({width,height,counts});
}

function forEachSelectedSpan(mask,visit) {
  let offset=0;
  for(let index=0;index<mask.counts.length;index++) {
    const end=offset+mask.counts[index];
    if(index%2)for(let start=offset;start<end;) {
      const y=Math.floor(start/mask.width),x=start%mask.width,length=Math.min(end-start,mask.width-x);
      visit(x,y,length);start+=length;
    }
    offset=end;
  }
}

export function regionInteriorPoint(mask) {
  validateRegionMask(mask);
  let area=0,sumX=0,sumY=0;
  forEachSelectedSpan(mask,(x,y,length)=>{
    area+=length;sumX+=(x+length/2)*length;sumY+=(y+.5)*length;
  });
  const centerX=sumX/area,centerY=sumY/area;
  let point=null,distance=Infinity;
  forEachSelectedSpan(mask,(x,y,length)=>{
    const candidateX=Math.max(x,Math.min(x+length-1,Math.round(centerX-.5)))+.5;
    const candidateY=y+.5,score=(candidateX-centerX)**2+(candidateY-centerY)**2;
    if(score<distance){distance=score;point={x:candidateX,y:candidateY};}
  });
  return point;
}
