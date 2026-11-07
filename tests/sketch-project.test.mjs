import {test} from 'node:test';
import assert from 'node:assert/strict';
import {newProject,addRaster,addDrawing,addText,saveVariant,restoreVariant,parseProject,serializeProject,validateProject} from '../public/core.mjs';
import {isSketchProject,sketchSurfaceLayer,sketchContentLayers} from '../public/sketch-project.mjs';
const source='data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg==';
function sketch(){const {project,layerId}=addRaster(newProject(),{name:'Paper',source,width:800,height:600});project.sketch={version:1,background:'#ffffff',surfaceLayerId:layerId};return project;}
test('native project and variant round trips keep an independent editable sketch surface and strokes',()=>{
  let p=sketch();p=addDrawing(p,{points:[[30,50],[90,100]],size:8,color:'#222222'}).project;
  const stroke=structuredClone(p.layers.at(-1)),surface=sketchSurfaceLayer(p);
  p=saveVariant(p,'First drawing');p=addDrawing(p,{points:[[220,100],[300,90]],size:9,color:'#444444'}).project;
  const saved=parseProject(serializeProject(p)),restored=restoreVariant(saved,saved.variants[0].id);
  assert.ok(isSketchProject(saved));assert.deepEqual(sketchSurfaceLayer(restored),surface);
  assert.equal(restored.layers.length,2);assert.deepEqual(restored.layers[1],stroke);
  assert.equal(saved.layers.length,3);assert.equal(saved.assets[surface.assetId].source,source);
});
test('malformed sketch metadata is rejected before generation or drawing-page use',()=>{
  const p=sketch();for(const sketch of [null,{...p.sketch,version:2},{...p.sketch,background:'red'},{...p.sketch,surfaceLayerId:'missing'}])assert.throws(()=>validateProject({...p,sketch}),/sketch/i);
  assert.equal(isSketchProject(newProject()),false);
});
test('scene content separates artwork from selection highlights and numbered reference instructions',()=>{
  let p=sketch();p=addDrawing(p,{points:[[5,5],[25,25]],color:'#112233',size:5}).project;
  const pencil=p.layers.at(-1);p=addDrawing(p,{mode:'highlight',points:[[4,4],[24,24]],color:'#ffff00',size:20}).project;
  p=addText(p,{content:'Mountains',x:20,y:30,width:120,height:40}).project;const text=p.layers.at(-1);
  p=addText(p,{content:'1',x:30,y:40,width:40,height:40}).project;
  p=addText(p,{content:'Use stone',x:50,y:60,width:150,height:40}).project;p.layers.at(-1).referenceComment='Apply the reference here';
  assert.deepEqual(sketchContentLayers(p).map(l=>l.id),[p.sketch.surfaceLayerId,pencil.id,text.id]);
});
