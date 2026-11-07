import {test,before,after,beforeEach,afterEach} from 'node:test';
import assert from 'node:assert/strict';
import {mkdir,writeFile} from 'node:fs/promises';
import {chromium} from 'playwright';
import {createServer} from '../server.mjs';
import {newProject,addReference,serializeProject} from '../public/core.mjs';
import {withSheetPreset} from '../public/sheet-preset.mjs';

const older='gpt-image-2.5-sunburst',sunburst='gpt-image-2.6-sunburst',flare='gpt-image-2.6-flare',qa='qa/gpt-image-2.6';
let browser,server,base,context,page,requests,records,errors,source;
const report=[];
before(async()=>{await mkdir(qa,{recursive:true});server=createServer({detection:{status:async()=>({available:false}),dispose(){}},sheets:{dispose(){}},images:{dispose(){}}});await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));base=`http://127.0.0.1:${server.address().port}`;browser=await chromium.launch({headless:true});});
after(async()=>{await writeFile(qa+'/ui-report.json',JSON.stringify({paidCalls:0,checks:report},null,2));await browser.close();await new Promise(resolve=>server.close(resolve));});
beforeEach(async info=>{
  requests=[];records=new Map();errors=[];context=await browser.newContext({viewport:{width:1440,height:1000}});page=await context.newPage();page.on('pageerror',error=>errors.push(error.message));page.on('dialog',dialog=>dialog.accept());
  await context.route('**/*',async route=>{const request=route.request(),url=new URL(request.url());if(url.origin!==base)return route.abort();if(!url.pathname.startsWith('/api/'))return route.continue();
    if(/^\/api\/(images|sheets)\/generate$/.test(url.pathname)){
      const body=request.postDataJSON(),kind=url.pathname.includes('sheets')?'sheet':'image';requests.push({kind,...body});
      const record={id:body.requestId,kind,mode:kind,status:'completed',model:body.model,sourceName:body.project.name,outputAvailable:true,sourceProjectAvailable:false,image:{source,width:24,height:24,name:'Mock result.png'},settings:{model:body.model,quality:body.quality,complexity:body.complexity,size:'1024x1536',prompt:'Mock provider prompt',inputs:[]}};records.set(record.id,record);return route.fulfill({json:record});
    }
    if(url.pathname==='/api/generation-queue/status')return route.fulfill({json:{items:[...records.values()].map(({image,...record})=>record)}});
    if(/\/jobs\//.test(url.pathname))return route.fulfill({json:records.get(url.pathname.split('/').at(-1))});
    return route.fulfill({json:{configured:true,authenticated:true,available:false,token:'local-test',models:[{id:older,available:true,label:'GPT Image 2.5 · Sunburst'},{id:sunburst,available:true,label:'GPT Image 2.6 · Sunburst — detailed work'},{id:flare,available:true,label:'GPT Image 2.6 · Flare — faster iteration'}],items:[]}});
  });
  const invalid=info.name.startsWith('invalid saved');
  if(invalid)await context.addInitScript(sunburst=>{localStorage.setItem('asun.desktop.image.last-job.v1.model',sunburst);localStorage.setItem('asun.desktop.image.last-job.v1.complexity','max');},sunburst);
  await page.goto(base);await ready();await page.waitForFunction(model=>document.querySelector('#model')?.value===model,invalid?sunburst:older);
  source=await page.evaluate(()=>{const canvas=document.createElement('canvas');canvas.width=canvas.height=24;canvas.getContext('2d').fillRect(0,0,24,24);return canvas.toDataURL();});
});
afterEach(async info=>{try{report.push({name:info.name,passed:!info.error,requests:requests.length});if(info.error)await page.screenshot({path:qa+'/ui-failure.png'});assert.deepEqual(errors,[]);}finally{await context.close();}});
async function ready(){await page.waitForFunction(()=>document.documentElement.dataset.ready==='true');if(await page.locator('#skipStartup').isVisible())await page.locator('#skipStartup').click();}
async function load(project){await page.locator('#projectInput').setInputFiles({name:'UI test.asun',mimeType:'application/json',buffer:Buffer.from(serializeProject(project))});await page.waitForFunction(name=>document.querySelector('#projectName')?.textContent===name,project.name);}
function project(){const p=newProject(1024,1536,'Image 2.6 settings');p.prompt='A quiet building at night';return p;}

test('main controls preserve 2.5, explicitly gate the unverified ratio and send 2.6 quality + complexity',async()=>{
  await load(project());assert.equal(await page.locator('#imageComplexity').isVisible(),false);assert.match(await page.locator('#imageComplexityHelp').innerText(),/unavailable/);
  await page.locator('#imageQuality').selectOption('max');await page.locator('#model').selectOption(sunburst);
  assert.equal(await page.locator('#imageComplexity').inputValue(),'high');assert.equal(await page.locator('#imageQuality').inputValue(),'max');assert.equal(await page.locator('#generate').isDisabled(),true);
  assert.equal(await page.locator('#imageOutputAspect').inputValue(),'9:16');assert.match(await page.locator('#imageQualityMessage').innerText(),/1024 × 1536|1024x1536/);
  await page.setViewportSize({width:1024,height:768});
  const unsupportedLayout=await page.evaluate(()=>{
    const composer=document.querySelector('.composer').getBoundingClientRect();
    return ['#imageComplexity','#imageComplexityHelp','#imageQualityMessage','#generate','#imageGenerationRefresh'].map(selector=>{const node=document.querySelector(selector),r=node.getBoundingClientRect();return {selector,inside:r.left>=composer.left&&r.right<=composer.right&&r.top>=composer.top&&r.bottom<=composer.bottom,visible:r.bottom<=innerHeight,text:node.textContent};});
  });
  assert(unsupportedLayout.every(item=>item.inside&&item.visible),JSON.stringify(unsupportedLayout));
  await page.locator('.composer').screenshot({path:qa+'/image26-unsupported-ratio.png'});await page.setViewportSize({width:1440,height:1000});
  await page.locator('#imageOutputAspect').selectOption('2:3');await page.locator('#imageComplexity').selectOption('medium');await page.waitForFunction(()=>!document.querySelector('#generate').disabled);
  assert.match(await page.locator('#imageComplexityHelp').innerText(),/planning.*separate from quality/i);
  const box=await page.locator('#imageComplexityHelp').boundingBox(),composer=await page.locator('.composer').boundingBox();assert(box.y>=composer.y&&box.y+box.height<=composer.y+composer.height,'Visible help stays in composer');
  await page.locator('.composer').screenshot({path:qa+'/image26-controls.png'});
  await page.locator('#generate').click();await page.waitForFunction(()=>!document.querySelector('#generate').disabled);assert.equal(requests.length,1);assert.equal(requests[0].model,sunburst);assert.equal(requests[0].quality,'max');assert.equal(requests[0].complexity,'medium');assert.equal(requests[0].project.imageOutput.aspect,'2:3');
  await page.locator('#imageGenerationResult').click();await page.locator('#desktopImageResultDialog').waitFor({state:'visible'});assert.match(await page.locator('[data-image-generation-details]').innerText(),/Complexity requested\s+medium/);await page.locator('#desktopImageResultDialog [data-image-result-close]').first().click();
  await page.locator('#model').selectOption(older);assert.equal(await page.locator('#imageComplexity').isVisible(),false);await page.locator('#model').selectOption(flare);assert.equal(await page.locator('#imageComplexity').inputValue(),'medium');
});

test('complexity belongs to its workflow tab and survives reopening the app',async()=>{
  await load(project());await page.locator('#model').selectOption(sunburst);await page.locator('#imageOutputAspect').selectOption('2:3');await page.locator('#imageComplexity').selectOption('low');const first=await page.locator('[data-workflow-tab][aria-selected=true]').getAttribute('data-workflow-tab');
  await page.locator('#newWorkflowTab').click();await page.waitForFunction(()=>document.querySelectorAll('[data-workflow-tab]').length===2);await page.locator('#model').selectOption(flare);await page.locator('#imageComplexity').selectOption('high');
  await page.locator(`[data-workflow-tab="${first}"]`).click();await page.waitForFunction(()=>document.querySelector('#imageComplexity').value==='low');assert.equal(await page.locator('#model').inputValue(),sunburst);
  await page.reload();await ready();await page.waitForFunction(()=>document.querySelector('#imageComplexity')?.value==='low');assert.equal(await page.locator('#model').inputValue(),sunburst);assert.equal(requests.length,0);
});

test('character sheet has the same separate complexity control and exact request value',async()=>{
  let p=addReference(project(),{name:'Subject.png',source,width:24,height:24});p=withSheetPreset(p,{active:true,sourceId:p.references[0].id,views:7});await load(p);await page.locator('#characterItemSheet').click();await page.locator('[data-sheet-model]').waitFor({state:'visible'});await page.waitForFunction(()=>!document.querySelector('[data-sheet-model]').disabled);
  await page.locator('[data-sheet-model]').selectOption(flare);assert.equal(await page.locator('#sheetComplexity').inputValue(),'high');await page.locator('[data-sheet-quality]').selectOption('xhigh');await page.locator('#sheetComplexity').selectOption('low');
  const generate=page.locator('[data-sheet-action="generate"]');await generate.click();await page.locator('[data-sheet-result]').waitFor({state:'visible'});assert.equal(requests.length,1);assert.equal(requests[0].kind,'sheet');assert.equal(requests[0].model,flare);assert.equal(requests[0].quality,'xhigh');assert.equal(requests[0].complexity,'low');
  await page.locator('[data-sheet-connection]').screenshot({path:qa+'/sheet26-controls.png'});
});

test('invalid saved complexity is visible and blocks generation until corrected',async()=>{
  await load(project());await page.locator('#imageOutputAspect').selectOption('2:3');
  assert.equal(await page.locator('#imageComplexity').inputValue(),'max');assert.equal(await page.locator('#generate').isDisabled(),true);assert.match(await page.locator('#imageQualityMessage').innerText(),/complexity/i);assert.equal(requests.length,0);await page.locator('#imageComplexity').selectOption('high');await page.waitForFunction(()=>!document.querySelector('#generate').disabled);
});
