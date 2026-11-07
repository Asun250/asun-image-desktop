import test from 'node:test';
import assert from 'node:assert/strict';
import {documentToView,viewToDocument,rotateView,fitRotatedView} from '../public/view-transform.mjs';
const close=(a,b)=>assert.ok(Math.abs(a-b)<1e-8,`${a} differs from ${b}`);
test('canvas-view pointer conversion roundtrips arbitrary rotations, pan and zoom',()=>{
  for(const angle of [-180,-90,-31,0,47,90,135])for(const zoom of [.1,1,2.8]){
    const view={x:128,y:-65,zoom,angle},point={x:213.5,y:784.2};
    const back=viewToDocument(view,documentToView(view,point));close(back.x,point.x);close(back.y,point.y);
  }
});
test('view rotation keeps the document point under its screen anchor stationary',()=>{
  const view={x:-20,y:75,zoom:1.4,angle:24},anchor={x:500,y:250};
  const original=viewToDocument(view,anchor),rotated=rotateView(view,-130,anchor);
  const after=documentToView(rotated,original);close(after.x,anchor.x);close(after.y,anchor.y);
  assert.equal(view.angle,24);assert.equal(rotated.angle,-130);
});
test('fit includes all rotated corners with padding and preserves upright fit',()=>{
  for(const angle of [0,25,90,145,180]){
    const view=fitRotatedView(1024,1536,980,720,angle);
    for(const point of [{x:0,y:0},{x:1024,y:0},{x:1024,y:1536},{x:0,y:1536}]){
      const p=documentToView(view,point);assert.ok(p.x>=39.99&&p.x<=940.01);assert.ok(p.y>=34.99&&p.y<=685.01);
    }
    const center=documentToView(view,{x:512,y:768});close(center.x,490);close(center.y,360);
  }
});
