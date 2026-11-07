import {offlineGeneration} from './fixtures/offline-generation.mjs';
// Presentation QA uses a deterministic synthetic scene in an isolated browser project.
import {chromium} from 'playwright';
import {mkdir,writeFile} from 'node:fs/promises';
import {syntheticScene} from './fixtures/portable-images.mjs';
import {createServer} from '../server.mjs';
const qa='qa/appearance';await mkdir(qa,{recursive:true});
const browser=await chromium.launch({headless:true});const server=createServer(offlineGeneration());await new Promise(r=>server.listen(0,'127.0.0.1',r));
const page=await browser.newPage({viewport:{width:1672,height:941}});const errors=[];page.on('pageerror',e=>errors.push(e.message));
await page.route('**/api/local-detection/status',route=>route.fulfill({json:{available:false,message:'Presentation fixture'}}));
try{
 await page.goto(`http://127.0.0.1:${server.address().port}`);await page.waitForFunction(()=>document.documentElement.dataset.ready==='true'&&document.documentElement.dataset.appearanceReady==='true');
 await page.screenshot({path:qa+'/pearl-empty-1672.png'});
 const bytes=[...(await syntheticScene()).bytes];
 const project=await page.evaluate(async bytes=>{
  const core=await import('/core.mjs'),{readOriginalImage}=await import('/image-source.mjs');
  const image=await readOriginalImage(new File([new Uint8Array(bytes)],'Synthetic shapes.png',{type:'image/png'}));
  let project=core.addRaster(core.newProject(image.width,image.height,'Synthetic shapes'),image).project;
  const locations=[[.29,.42],[.16,.4],[.62,.54]];
  const comments=['Replace the circle with the linked reference.','Keep the square in this position. Match the reference finish.','Keep the triangle shape and apply the reference material.'];
  for(let index=0;index<3;index++){
   const [x,y]=locations[index];const next=core.addText(project,{content:String(index+1),x:x*image.width,y:y*image.height,fontSize:42,color:'#ff0000',width:46,height:64});project=next.project;
   project=core.updateLabelComment(project,next.layerId,comments[index]);
   project=core.addReference(project,{...image,name:['Circle reference.png','Square reference.png','Triangle reference.png'][index]});
   project=core.linkReferences(project,next.layerId,[project.references.at(-1).id]);
  }
  project.prompt='Preserve the composition and apply the numbered edits.';
  return core.serializeProject(project);
 },bytes);
 await page.locator('#projectInput').setInputFiles({name:'Visual QA.asun',mimeType:'application/json',buffer:Buffer.from(project)});
 await page.waitForFunction(()=>document.querySelectorAll('.edit-summary-card').length===3&&!document.body.classList.contains('busy'));
 await page.locator('.toolrail [data-tool=move]').click();await page.locator('#fit').click();await page.locator('#toast').waitFor({state:'hidden'});
 for(const viewport of [{width:1672,height:941},{width:1280,height:800},{width:1080,height:720}]){
  await page.setViewportSize(viewport);await page.waitForTimeout(80);
  for(const theme of ['light','dark']){
   if(await page.locator('html').getAttribute('data-theme')!==theme)await page.locator('#themeToggle').click();
   await page.waitForTimeout(220);
   await page.screenshot({path:`${qa}/${theme}-scene-${viewport.width}.png`});
  }
 }
 await writeFile(qa+'/scene-preview-errors.json',JSON.stringify(errors,null,2));
 if(errors.length)throw new Error(errors.join('\n'));
 console.log('Saved synthetic-scene screenshots in light and dark at 1672,1280,1080.');
}finally{await browser.close();await new Promise(r=>server.close(r));}
