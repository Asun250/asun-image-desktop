import {normalizeRotation} from './layer-transform.mjs';

function turn(point,degrees){
  const radians=normalizeRotation(degrees)*Math.PI/180,c=Math.cos(radians),s=Math.sin(radians);
  return {x:point.x*c-point.y*s,y:point.x*s+point.y*c};
}
export function documentToView(view,point){
  const p=turn(point,view.angle||0);
  return {x:view.x+p.x*view.zoom,y:view.y+p.y*view.zoom};
}
export function viewToDocument(view,point){
  return turn({x:(point.x-view.x)/view.zoom,y:(point.y-view.y)/view.zoom},-(view.angle||0));
}
export function rotateView(view,angle,anchor){
  const documentPoint=viewToDocument(view,anchor),next={...view,angle:normalizeRotation(angle)};
  const rotated=turn(documentPoint,next.angle);
  next.x=anchor.x-rotated.x*next.zoom;next.y=anchor.y-rotated.y*next.zoom;
  return next;
}
export function fitRotatedView(width,height,stageWidth,stageHeight,angle=0){
  const normalized=normalizeRotation(angle),r=normalized*Math.PI/180;
  const boundingWidth=Math.abs(width*Math.cos(r))+Math.abs(height*Math.sin(r));
  const boundingHeight=Math.abs(width*Math.sin(r))+Math.abs(height*Math.cos(r));
  const zoom=Math.max(.02,Math.min((stageWidth-80)/boundingWidth,(stageHeight-70)/boundingHeight,2));
  const center=turn({x:width/2,y:height/2},normalized);
  return {x:stageWidth/2-center.x*zoom,y:stageHeight/2-center.y*zoom,zoom,angle:normalized};
}
