import {test,before,after} from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {readFile} from 'node:fs/promises';
import {chromium} from 'playwright';

let server,browser,page;
const errors=[];
before(async()=>{
  const module=await readFile(new URL('../public/generation-input-packing.mjs',import.meta.url));
  server=createServer((request,response)=>{
    response.setHeader('Cache-Control','no-store');
    if(request.url==='/generation-input-packing.mjs'){response.setHeader('Content-Type','text/javascript');response.end(module);}
    else {response.setHeader('Content-Type','text/html');response.end('<!doctype html><title>Reference board test</title>');}
  });
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  browser=await chromium.launch({headless:true});page=await browser.newPage();
  page.on('pageerror',error=>errors.push(error.message));
  const base=`http://127.0.0.1:${server.address().port}`;
  await page.route('**/*',route=>new URL(route.request().url()).origin===base&&route.request().method()==='GET'?route.continue():route.abort());
  await page.goto(base);await page.evaluate(async()=>{
    window.packing=await import('/generation-input-packing.mjs');
    window.fixture=(index,width=80,height=40)=>{
      const c=document.createElement('canvas');c.width=width;c.height=height;
      const context=c.getContext('2d');context.fillStyle=`rgb(${index*10},${200-index*4},${50+index*6})`;context.fillRect(0,0,width,height);
      return {source:c.toDataURL('image/png'),width,height};
    };
  });
});
after(async()=>{try{assert.deepEqual(errors,[]);}finally{await browser?.close();if(server)await new Promise(resolve=>server.close(resolve));}});

test('overflow boards contain each correct photo, visible logical labels and no crop; originals stay unchanged',async()=>{
  const result=await page.evaluate(async()=>{
    const inputs=Array.from({length:20},(_,index)=>window.fixture(index+1,index%2?40:80,index%2?80:40));
    const before=JSON.stringify(inputs),plan=window.packing.planGenerationInputPacking(inputs,[{image:1,role:'current composition'}]);
    const outputs=await window.packing.renderGenerationInputBoards(inputs,plan),tiles=[];
    for(const output of outputs){
      const image=new Image();image.src=output.image.source;await image.decode();
      const c=document.createElement('canvas');c.width=image.naturalWidth;c.height=image.naturalHeight;
      const context=c.getContext('2d');context.drawImage(image,0,0);
      for(const tile of plan.slots[output.slot-1].tiles){
        const r=tile.imageRect,center=Array.from(context.getImageData(r.x+Math.floor(r.width/2),r.y+Math.floor(r.height/2),1,1).data);
        let dark=0;const text=context.getImageData(tile.x+8,tile.y+4,Math.min(500,tile.width-16),48).data;
        for(let index=0;index<text.length;index+=4)if(text[index]<70&&text[index+1]<70&&text[index+2]<70)dark++;
        tiles.push({sourceIndex:tile.sourceIndex,center,dark,letterbox:Array.from(context.getImageData(tile.x+8,tile.y+100,1,1).data)});
      }
    }
    return {plan,outputs:outputs.map(({slot,image})=>({slot,width:image.width,height:image.height})),tiles,unchanged:JSON.stringify(inputs)===before};
  });
  assert.equal(result.unchanged,true);assert.equal(result.plan.logicalInputCount,20);assert.equal(result.plan.physicalInputCount,16);
  assert.equal(result.outputs.length,4);assert.equal(result.outputs[0].slot,2);
  for(const tile of result.tiles){const n=tile.sourceIndex;assert.deepEqual(tile.center,[n*10,200-n*4,50+n*6,255]);assert.ok(tile.dark>100,`Input ${n} has a readable printed label`);assert.deepEqual(tile.letterbox,[255,255,255,255]);}
  const all=result.plan.slots.flatMap(slot=>slot.kind==='single'?[slot.sourceIndex]:slot.tiles.map(tile=>tile.sourceIndex));
  assert.deepEqual(all.sort((a,b)=>a-b),Array.from({length:20},(_,index)=>index+1));
});

test('board creation stops on missing image bytes, unreadable data or mismatched dimensions instead of omitting a tile',async()=>{
  const failures=await page.evaluate(async()=>{
    const result=[];
    for(const mutation of ['missing','corrupt','dimensions']){
      const inputs=Array.from({length:17},(_,index)=>window.fixture(index+1));
      if(mutation==='missing')delete inputs[0].source;
      if(mutation==='corrupt')inputs[0].source='data:image/png;base64,bm90LWEtcG5n';
      if(mutation==='dimensions')inputs[0].width=99;
      const plan=window.packing.planGenerationInputPacking(inputs);
      try{await window.packing.renderGenerationInputBoards(inputs,plan);result.push(null);}catch(error){result.push(error.message);}
    }
    return result;
  });
  assert.equal(failures.length,3);assert.ok(failures.every(message=>message&&/No references were omitted/.test(message)));
  assert.match(failures[2],/recorded dimensions/);
});
