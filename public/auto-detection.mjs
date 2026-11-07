import {decodeImage,drawRasterRegionOverlay,textGlyphContainsPoint} from './render.mjs';
import {DEFAULT_OBJECT_COLOR,validateDetectionResult,regionContainsPoint,regionMaskInfo,rasterPointVisible,objectRegionContains,rasterRegionBounds} from './object-regions.mjs';
import {sketchSurface,sketchContentSignature,sketchWorkingCopy} from './sketch-detection.mjs';
import {documentPointToLayer} from './layer-transform.mjs';

// All requests use this app's loopback server. Only this resized working copy
// enters the local model; uploaded sources remain immutable project assets.
export function detectionTarget(project) {
  if(project.sketch)return sketchSurface(project);
  return project.layers.find(layer=>layer.kind==='raster'&&layer.visible&&layer.opacity>0&&layer.assetId===project.original?.assetId)
    ||project.layers.find(layer=>layer.kind==='raster'&&layer.visible&&layer.opacity>0)||null;
}
export async function detectionWorkingCopy(asset) {
  const image=await decodeImage(asset.source),scale=Math.min(1,1600/Math.max(asset.width,asset.height));
  const canvas=document.createElement('canvas');canvas.width=Math.max(1,Math.round(asset.width*scale));canvas.height=Math.max(1,Math.round(asset.height*scale));
  const context=canvas.getContext('2d');context.fillStyle='#fff';context.fillRect(0,0,canvas.width,canvas.height);context.drawImage(image,0,0,canvas.width,canvas.height);
  return {source:canvas.toDataURL('image/png'),width:canvas.width,height:canvas.height};
}
export function createLocalDetection({getProject,canHover,overlay,onChange,onError}) {
  let state='idle',message='Auto detect runs on this computer.',active=null,abort=null,epoch=0,hovered=null,lastPoint=null,alternative=0,lastSignature='';
  const cache=new Map();
  const change=()=>onChange({state,message,regions:active?.result.regions.length||0,hovered});
  function hide(){hovered=null;lastPoint=null;alternative=0;lastSignature='';overlay.hidden=true;}
  function target(){const project=getProject(),raster=detectionTarget(project),asset=raster?project.assets[raster.assetId]:null;return raster?{project,raster,asset,source:project.sketch?sketchContentSignature(project):asset.source}:null;}
  function sync(){
    const current=target();
    if(active&&(!current||active.assetId!==current.raster.assetId||active.source!==current.source)){active=null;hide();if(state!=='running'){state='idle';message='Auto detect runs on this computer.';}}
    if(!active&&current){const saved=cache.get(current.raster.assetId);if(saved?.source===current.source){active=saved;if(state!=='running'){state='ready';message=`${saved.result.regions.length} regions · local SAM 2.1 · hover, then click to number`;}}}
    if(!canHover())hide();change();
  }
  function reset(){epoch++;abort?.abort();abort=null;cache.clear();active=null;state='idle';message='Auto detect runs on this computer.';hide();change();}
  async function run(force=false){
    if(state==='running')return;
    const current=target();if(!current){onError(getProject().sketch?'The sketch drawing page is unavailable. Reopen the sketch before using Auto detect.':'Import a visible main image before using Auto detect.');return;}
    const saved=cache.get(current.raster.assetId);
    if(!force&&saved?.source===current.source){active=saved;state='ready';message=`${saved.result.regions.length} regions · local SAM 2.1 · hover, then click to number`;change();return;}
    const runEpoch=++epoch;abort=new AbortController();const signal=abort.signal;
    state='running';message='Finding objects on this computer…';hide();change();
    try{
      const statusResponse=await fetch('/api/local-detection/status',{signal});
      if(!statusResponse.ok)throw new Error('The local detection engine is unavailable. Reopen Asun IMG and try again.');
      const status=await statusResponse.json();if(!status.available)throw new Error(status.message||'Local SAM 2 is not ready. You can continue using Text, Pencil and Highlight.');
      const working=current.project.sketch?await sketchWorkingCopy(current.project):await detectionWorkingCopy(current.asset);
      if(signal.aborted)return;
      const response=await fetch('/api/local-detection',{method:'POST',headers:{'Content-Type':'application/json','X-Asun-Detection-Token':status.token},body:JSON.stringify(working),signal});
      const raw=await response.json();if(!response.ok)throw new Error(raw.error||raw.message||'Local object detection failed.');
      const result=validateDetectionResult(raw);
      if(result.width!==working.width||result.height!==working.height)throw new Error('The local model returned an incompatible image size.');
      const now=target();if(runEpoch!==epoch||!now||now.raster.assetId!==current.raster.assetId||now.source!==current.source)return;
      active={assetId:current.raster.assetId,source:current.source,result};cache.delete(active.assetId);cache.set(active.assetId,active);while(cache.size>3)cache.delete(cache.keys().next().value);
      state='ready';message=result.regions.length?`${result.regions.length} regions · local SAM 2.1 · hover, then click to number`:current.project.sketch?'No clear sketch subjects found. Highlight a subject, then use the marked area manually.':'No clear regions found. Use Text, Pencil or Highlight to mark the image.';
    }catch(error){if(runEpoch===epoch&&error.name!=='AbortError'){state='error';message='Auto detect unavailable · try again or mark the image manually';onError(error.message);}}
    finally{if(runEpoch===epoch){abort=null;if(state==='running'){state='idle';message='Image changed. Run Auto detect for the current image.';}change();}}
  }
  function choices(point){
    const current=target();if(!active||!current||active.assetId!==current.raster.assetId||active.source!==current.source)return [];
    const {raster}=current;if(!rasterPointVisible(current.project,raster,point))return [];
    const local=documentPointToLayer(raster,point),x=local.x*active.result.width/raster.width,y=local.y*active.result.height/raster.height;
    return active.result.regions.filter(region=>x>=region.bbox[0]&&y>=region.bbox[1]&&x<region.bbox[0]+region.bbox[2]&&y<region.bbox[1]+region.bbox[3]&&regionContainsPoint(region.mask,x,y)).sort((a,b)=>a.area-b.area||a.id.localeCompare(b.id));
  }
  function pick(point){
    const current=target(),project=getProject();if(!current||!canHover()||point.x<0||point.y<0||point.x>=project.width||point.y>=project.height)return null;
    const options=choices(point),signature=options.map(region=>region.id).join('|');
    if(signature!==lastSignature){alternative=0;lastSignature=signature;}
    if(alternative===0){
      // Numbers remain directly clickable even if their text was moved away
      // from the corresponding object.
      const label=[...project.layers].reverse().find(layer=>layer.kind==='text'&&layer.objectRegion&&layer.visible&&layer.opacity>0&&rasterRegionBounds(project,layer)?.visible&&textGlyphContainsPoint(project,layer,point));
      if(label)return {label,mask:label.objectRegion.mask,raster:rasterRegionBounds(project,label)};
      const existing=project.layers.filter(layer=>layer.kind==='text'&&layer.objectRegion&&layer.visible&&layer.opacity>0&&objectRegionContains(project,layer,[point.x,point.y])).sort((a,b)=>regionMaskInfo(a.objectRegion.mask).area-regionMaskInfo(b.objectRegion.mask).area);
      if(existing.length)return {label:existing[0],mask:existing[0].objectRegion.mask,raster:rasterRegionBounds(project,existing[0])};
    }
    const region=options.length?options[((alternative%options.length)+options.length)%options.length]:null;
    return region?{region,mask:region.mask,raster:current.raster,asset:current.asset}:null;
  }
  function hover(point){
    if(!canHover()){hide();return;}
    lastPoint=point;hovered=pick(point);if(!hovered){overlay.hidden=true;change();return;}
    const project=getProject(),scale=Math.min(1,1600/Math.max(project.width,project.height));
    const width=Math.max(1,Math.round(project.width*scale)),height=Math.max(1,Math.round(project.height*scale));
    if(overlay.width!==width)overlay.width=width;if(overlay.height!==height)overlay.height=height;
    overlay.style.width=project.width+'px';overlay.style.height=project.height+'px';
    const context=overlay.getContext('2d');context.setTransform(1,0,0,1,0,0);context.clearRect(0,0,overlay.width,overlay.height);context.scale(width/project.width,height/project.height);
    const raster=hovered.label?project.layers.find(layer=>layer.id===hovered.label.objectRegion.rasterLayerId):hovered.raster;
    drawRasterRegionOverlay(context,project,raster,hovered.mask,{color:hovered.label?.text.color||DEFAULT_OBJECT_COLOR,fillOpacity:.16,outlineOpacity:.95,lineWidth:2});
    overlay.hidden=false;change();
  }
  function cycle(direction,point=lastPoint){if(!point||!canHover())return;const options=choices(point);if(options.length<2)return;lastSignature=options.map(region=>region.id).join('|');alternative+=Math.sign(direction);hover(point);}
  function clearHover(){hide();change();}
  return {run,sync,reset,hover,pick,cycle,clearHover,get running(){return state==='running';},get ready(){return Boolean(active);}};
}
