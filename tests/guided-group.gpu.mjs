// Explicit live GPU smoke test; excluded from npm test. Uses only a generated
// synthetic fixture and the already running local editor. No user project data.
import {test} from 'node:test';
import {gpuSkip} from './fixtures/portable-images.mjs';
import assert from 'node:assert/strict';
import {mkdir,writeFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import path from 'node:path';
import {chromium} from 'playwright';
import {mapGuidedResult} from '../public/guided-detection.mjs';
import {unionRegionMasks,regionInteriorPoint} from '../public/guided-group.mjs';
import {regionContainsPoint,regionMaskInfo} from '../public/object-regions.mjs';

test('four separately highlighted synthetic objects use real local SAM and remain a disconnected group',{skip:gpuSkip,timeout:600000},async()=>{
  const base=process.env.ASUN_TEST_BASE_URL||'http://127.0.0.1:48010',qa=path.resolve('qa/guided-group');
  await mkdir(qa,{recursive:true});
  const status=await fetch(base+'/api/local-detection/status',{signal:AbortSignal.timeout(5000)}).then(response=>response.json());
  assert.equal(status.available,true,'Existing local detector must be available');
  assert.equal(status.busy,false,'Do not compete with an existing detection request');
  const browser=await chromium.launch({headless:true});
  let data;
  try {
    const page=await browser.newPage({viewport:{width:1100,height:900}});
    await page.goto(base+'/health');
    data=await page.evaluate(async()=>{
      const core=await import('/core.mjs'),guided=await import('/guided-detection.mjs'),groups=await import('/guided-group.mjs');
      const canvas=document.createElement('canvas');canvas.width=1000;canvas.height=760;
      const ctx=canvas.getContext('2d');ctx.fillStyle='#eef3f5';ctx.fillRect(0,0,canvas.width,canvas.height);
      const centers=[[180,170],[800,170],[180,590],[800,590]],colors=['#cb3335','#2381c9','#e4a628','#398b52'];
      centers.forEach(([cx,cy],index)=>{
        const color=colors[index];ctx.fillStyle=color;ctx.strokeStyle='#26343c';ctx.lineWidth=3;
        ctx.beginPath();ctx.ellipse(cx,cy,58,38,-.12,0,Math.PI*2);ctx.fill();ctx.stroke();
        ctx.beginPath();ctx.moveTo(cx-48,cy+4);ctx.lineTo(cx-95,cy-23);ctx.lineTo(cx-75,cy+31);ctx.closePath();ctx.fill();ctx.stroke();
        ctx.beginPath();ctx.arc(cx+42,cy-38,28,0,Math.PI*2);ctx.fill();ctx.stroke();
        ctx.fillStyle='#e9a33c';ctx.beginPath();ctx.moveTo(cx+65,cy-44);ctx.lineTo(cx+93,cy-34);ctx.lineTo(cx+65,cy-27);ctx.closePath();ctx.fill();ctx.stroke();
        ctx.fillStyle='#ffffff';ctx.beginPath();ctx.arc(cx+50,cy-45,7,0,Math.PI*2);ctx.fill();
        ctx.fillStyle='#172932';ctx.beginPath();ctx.arc(cx+52,cy-45,3.5,0,Math.PI*2);ctx.fill();
        ctx.fillStyle='#ffffff40';ctx.beginPath();ctx.ellipse(cx-5,cy,35,20,-.2,0,Math.PI*2);ctx.fill();
        ctx.strokeStyle='#665440';ctx.lineWidth=5;
        for(const dx of [-10,18]){ctx.beginPath();ctx.moveTo(cx+dx,cy+33);ctx.lineTo(cx+dx,cy+59);ctx.lineTo(cx+dx+11,cy+59);ctx.stroke();}
      });
      const source=canvas.toDataURL('image/png'),raster=core.addRaster(core.newProject(),{name:'Four synthetic birds.png',source,width:canvas.width,height:canvas.height});
      let project=raster.project;const markIds=[];
      for(const [cx,cy] of centers){
        const added=core.addDrawing(project,{mode:'highlight',color:'#ffff00',size:10,points:[[cx-95,cy+61],[cx+94,cy-67]]});
        project=added.project;markIds.push(added.layerId);
      }
      const before=core.serializeProject(project),targets=groups.guidedMarkTargets(project,markIds.at(-1)),working=[];
      for(const target of targets)working.push(await guided.guidedWorkingCopy(project,target.mark.id));
      return {source,centers,working,projectUnchanged:before===core.serializeProject(project),sourceAfter:project.assets[project.original.assetId].source};
    });
    const bytes=Buffer.from(data.source.split(',')[1],'base64'),sourceHash=createHash('sha256').update(bytes).digest('hex');
    await writeFile(path.join(qa,'four-synthetic-birds.png'),bytes);
    assert.equal(data.projectUnchanged,true);
    assert.equal(data.sourceAfter,data.source);
    assert.equal(data.working.length,4);
    const chosen=[],results=[];
    for(let index=0;index<data.working.length;index++){
      const current=await fetch(base+'/api/local-detection/status',{signal:AbortSignal.timeout(5000)}).then(response=>response.json());
      assert.equal(current.available,true);assert.equal(current.busy,false,'Stop rather than compete with another request');
      const working=data.working[index],response=await fetch(base+'/api/local-detection',{method:'POST',headers:{Origin:base,'Content-Type':'application/json','X-Asun-Detection-Token':current.token},body:JSON.stringify(working.request),signal:AbortSignal.timeout(120000)});
      const raw=await response.json();assert.equal(response.status,200,raw.error||'Local SAM request failed');
      const mapped=mapGuidedResult(raw,working);assert.ok(mapped.regions.length>0);
      const best=mapped.regions[0],center=data.centers[index];
      assert.equal(regionContainsPoint(best.mask,...center),true,`Top SAM candidate must contain synthetic bird ${index+1}`);
      for(let other=0;other<data.centers.length;other++)if(other!==index)assert.equal(regionContainsPoint(best.mask,...data.centers[other]),false,'An individual box must not absorb another bird');
      chosen.push(best.mask);
      results.push({mark:index+1,model:raw.model,device:raw.device,elapsedMs:raw.elapsedMs,candidates:raw.regions.length,chosenCandidate:1,crop:working.crop,promptBox:working.request.prompt.box,bbox:best.bbox,area:best.area,runs:best.mask.counts.length,targetCenter: center,targetContained:true,otherTargetCentersExcluded:true});
      console.log(JSON.stringify(results.at(-1)));
    }
    const union=unionRegionMasks(chosen),gaps=[[500,170],[500,380],[500,590],[180,380],[800,380]];
    for(const center of data.centers)assert.equal(regionContainsPoint(union,...center),true);
    for(const point of gaps)assert.equal(regionContainsPoint(union,...point),false,'Background between objects remains excluded');
    const labelPoint=regionInteriorPoint(union);assert.equal(regionContainsPoint(union,labelPoint.x,labelPoint.y),true);
    const overlay=await page.evaluate(async({source,union,centers})=>{
      const {drawRegionOverlay}=await import('/object-regions.mjs');
      const image=new Image();image.src=source;await image.decode();
      const canvas=document.createElement('canvas');canvas.width=image.naturalWidth;canvas.height=image.naturalHeight;
      const ctx=canvas.getContext('2d');ctx.drawImage(image,0,0);
      drawRegionOverlay(ctx,union,{x:0,y:0,width:canvas.width,height:canvas.height},{color:'#ff1666',fillOpacity:.19,lineWidth:2});
      centers.forEach(([x,y],index)=>{ctx.fillStyle='#172932';ctx.font='bold 22px Arial';ctx.fillText(`Object ${index+1}`,x-45,y+98);});
      return canvas.toDataURL('image/png');
    },{source:data.source,union,centers:data.centers});
    await writeFile(path.join(qa,'four-synthetic-birds-real-sam-overlay.png'),Buffer.from(overlay.split(',')[1],'base64'));
    const afterHash=createHash('sha256').update(Buffer.from(data.sourceAfter.split(',')[1],'base64')).digest('hex');
    assert.equal(sourceHash,afterHash);
    const report={status:'passed',endpoint:base,fixture:'Deterministic synthetic bird silhouettes; this is a plumbing and mask-isolation smoke test, not a quality evaluation of photographic bird detection.',requests:4,sourceSha256Before:sourceHash,sourceSha256After:afterHash,sourceAndProjectUnchanged:true,results,union:{...regionMaskInfo(union),runs:union.counts.length,allFourTargetCentersIncluded:true,backgroundGapSamples:gaps,backgroundGapsExcluded:true,labelPointInsideMask:labelPoint},artifacts:['four-synthetic-birds.png','four-synthetic-birds-real-sam-overlay.png']};
    await writeFile(path.join(qa,'real-gpu-20261020.json'),JSON.stringify(report,null,2));
  } catch(error) {
    await writeFile(path.join(qa,'real-gpu-failure-20261020.json'),JSON.stringify({status:'failed',error:error.message,fixture:'Synthetic bird silhouettes; no user project was accessed.'},null,2));
    throw error;
  } finally {await browser.close();}
});
