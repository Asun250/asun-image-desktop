// Explicit Windows desktop integration test; opens a disposable Edge app window.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdir,mkdtemp,writeFile,access} from 'node:fs/promises';
import {execFile,spawn} from 'node:child_process';
import {promisify} from 'node:util';
import {fileURLToPath} from 'node:url';
import path from 'node:path';
import {chromium} from 'playwright';
import {BUILD} from '../server.mjs';

import {missingAssetReason} from './fixtures/optional-assets.mjs';
const artworkSkip=missingAssetReason(['public/asun-img-husky.ico']);
const enabled=process.platform==='win32'&&process.env.ASUN_RUN_NATIVE_TESTS==='1';
test('fresh native Edge app windows retain Asun branding through reload',{
  skip:artworkSkip||(enabled?false:'On Windows, set ASUN_RUN_NATIVE_TESTS=1 to open a disposable native Edge window.'),timeout:120000,
},async()=>{
  const run=promisify(execFile),release=fileURLToPath(new URL('../',import.meta.url)),qa=path.join(release,'qa/taskbar');
  const candidates=[process.env.ASUN_EDGE_PATH,
    process.env['ProgramFiles(x86)']&&path.join(process.env['ProgramFiles(x86)'],'Microsoft/Edge/Application/msedge.exe'),
    process.env.ProgramFiles&&path.join(process.env.ProgramFiles,'Microsoft/Edge/Application/msedge.exe'),
    process.env.LOCALAPPDATA&&path.join(process.env.LOCALAPPDATA,'Microsoft/Edge/Application/msedge.exe')].filter(Boolean);
  let edge;
  for(const candidate of candidates){try{await access(candidate);edge=candidate;break;}catch{}}
  assert.ok(edge,'Install Microsoft Edge or set ASUN_EDGE_PATH to its executable.');
  assert.ok(process.env.SystemRoot,'This test requires Windows and the SystemRoot environment setting.');
  const shell=path.join(process.env.SystemRoot,'System32/WindowsPowerShell/v1.0/powershell.exe');
  await mkdir(qa,{recursive:true});
  const ownedProfile=await mkdtemp(path.join(qa,'isolated-edge-profile-'));
  const helper=path.join(release,'windows/Keep-WindowBrand.ps1');
  const readWindows=async()=>{
    const {stdout}=await run(shell,['-NoProfile','-ExecutionPolicy','Bypass','-File',helper,'-InspectOnly'],{windowsHide:true});
    const json=stdout.replace(/^\uFEFF/,'').trim();if(!json)return [];
    const info=JSON.parse(json);return Array.isArray(info)?info:info?[info]:[];
  };
  const originalHandles=new Set((await readWindows()).map(window=>window.Handle));
  const {stdout:launchedUrl}=await run(shell,['-NoProfile','-ExecutionPolicy','Bypass','-File',path.join(release,'Launch Asun IMG.ps1'),'-NoBrowser'],{windowsHide:true});
  const base=launchedUrl.trim(),url=new URL(base);
  assert.equal(url.hostname,'127.0.0.1');assert.ok(Number(url.port)>=48010&&Number(url.port)<=48019);
  assert.equal((await(await fetch(base+'/health')).json()).build,BUILD);
  let context,keeper,keeperError;
  try{
    keeper=spawn(shell,['-NoProfile','-ExecutionPolicy','Bypass','-File',helper],{windowsHide:true,stdio:'ignore'});
    keeper.on('error',error=>{keeperError=error;});
    context=await chromium.launchPersistentContext(ownedProfile,{executablePath:edge,headless:false,ignoreDefaultArgs:['--no-startup-window'],args:['--app='+base,'--disable-background-mode','--no-first-run','--no-default-browser-check'],viewport:null});
    let page=context.pages().find(page=>page.url().startsWith(base));
    if(!page){page=await context.waitForEvent('page');await page.waitForURL(base+'/**');}
    await page.waitForFunction(()=>document.documentElement.dataset.ready==='true',null,{timeout:20000});await page.waitForTimeout(1800);
    if(keeperError)throw keeperError;
    const newWindows=(await readWindows()).filter(window=>!originalHandles.has(window.Handle));
    assert.equal(newWindows.length,1,'Only the disposable test app window is new');
    const window=newWindows[0];assert.equal(window.AppId,'Asun.IMG');assert.equal(window.DisplayName,'Asun IMG');
    assert.equal(window.SmallIconValid,true);assert.equal(window.LargeIconValid,true);
    assert.ok(window.IconResource.endsWith('public\\asun-img-husky.ico,0'));
    await page.reload();await page.waitForFunction(()=>document.documentElement.dataset.ready==='true',null,{timeout:20000});await page.waitForTimeout(1800);
    const reloaded=(await readWindows()).find(value=>value.Handle===window.Handle);
    assert.equal(reloaded.AppId,'Asun.IMG');assert.equal(reloaded.IconResource,window.IconResource);assert.equal(reloaded.SmallIconValid,true);assert.equal(reloaded.LargeIconValid,true);
    assert.equal(reloaded.SmallIcon,window.SmallIcon);assert.equal(reloaded.LargeIcon,window.LargeIcon);
    await writeFile(path.join(qa,'launch-report.json'),JSON.stringify({passed:true,base,isolatedProfile:ownedProfile,newWindow:window,reloadedWindow:reloaded},null,2));
  }finally{await context?.close();keeper?.kill();}
});
