// Native layer geometry. Positive angles turn clockwise on the canvas. x/y
// describe the unrotated top-left; rotation is always around the layer center.
const finite=value=>typeof value==='number'&&Number.isFinite(value);
export function normalizeRotation(degrees=0) {
  if(!finite(degrees))throw new Error('Choose a finite rotation angle.');
  const value=((degrees%360)+540)%360-180;
  return Object.is(value,-0)?0:value;
}
function basis(layer) {
  const angle=normalizeRotation(layer.rotation??0)*Math.PI/180;
  let cos=Math.cos(angle),sin=Math.sin(angle);
  if(Math.abs(cos)<1e-12)cos=0;if(Math.abs(sin)<1e-12)sin=0;
  return {cos,sin};
}
function point(value) {return Array.isArray(value)?{x:value[0],y:value[1]}:value;}
export function layerPointToDocument(layer,value) {
  const p=point(value),{cos,sin}=basis(layer),x=p.x-layer.width/2,y=p.y-layer.height/2;
  return {x:layer.x+layer.width/2+x*cos-y*sin,y:layer.y+layer.height/2+x*sin+y*cos};
}
export function documentPointToLayer(layer,value) {
  const p=point(value),{cos,sin}=basis(layer),x=p.x-layer.x-layer.width/2,y=p.y-layer.y-layer.height/2;
  return {x:layer.width/2+x*cos+y*sin,y:layer.height/2-x*sin+y*cos};
}
export function layerCorners(layer) {
  return [{x:0,y:0},{x:layer.width,y:0},{x:layer.width,y:layer.height},{x:0,y:layer.height}].map(p=>layerPointToDocument(layer,p));
}
export function layerBounds(layer) {
  const corners=layerCorners(layer),xs=corners.map(p=>p.x),ys=corners.map(p=>p.y),x=Math.min(...xs),y=Math.min(...ys);
  return {x,y,width:Math.max(...xs)-x,height:Math.max(...ys)-y};
}
// Exact rectangle intersection avoids including references when only the
// empty corner of a rotated layer's bounding box overlaps the document.
export function layerIntersectsCanvas(layer,size,height) {
  const width=typeof size==='number'?size:size?.width,h=typeof size==='number'?height:size?.height;
  if(!layer||![layer.x,layer.y,layer.width,layer.height,width,h].every(finite)||layer.width<=0||layer.height<=0||width<=0||h<=0)return false;
  const a=layerCorners(layer),b=[{x:0,y:0},{x:width,y:0},{x:width,y:h},{x:0,y:h}],{cos,sin}=basis(layer);
  for(const axis of [{x:1,y:0},{x:0,y:1},{x:cos,y:sin},{x:-sin,y:cos}]) {
    const one=a.map(p=>p.x*axis.x+p.y*axis.y),two=b.map(p=>p.x*axis.x+p.y*axis.y);
    if(Math.max(...one)<=Math.min(...two)||Math.max(...two)<=Math.min(...one))return false;
  }
  return true;
}
