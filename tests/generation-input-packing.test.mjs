import {test} from 'node:test';
import assert from 'node:assert/strict';
import {planGenerationInputPacking,renderGenerationInputBoards} from '../public/generation-input-packing.mjs';

const images = count => Array.from({length:count}, (_, index) => ({width:400 + index * 3, height:300 + index * 5, source:`original-${index}`}));
const sources = plan => plan.slots.flatMap(slot => slot.kind === 'single' ? [slot.sourceIndex] : slot.tiles.map(tile => tile.sourceIndex));
const freeze = value => {if (value && typeof value === 'object') {Object.freeze(value);for (const item of Object.values(value)) freeze(item);}return value;};

test('zero through sixteen inputs pass through in their original order without rendering',async()=>{
  for (let count = 0; count <= 16; count++) {
    const source = images(count), plan = planGenerationInputPacking(source);
    assert.equal(plan.packed,false);assert.equal(plan.logicalInputCount,count);assert.equal(plan.physicalInputCount,count);
    assert.deepEqual(plan.slots,source.map((_, index) => ({kind:'single',sourceIndex:index + 1})));
    assert.deepEqual(await renderGenerationInputBoards(source,plan),[]);
  }
});

test('seventeen inputs retain fifteen single originals and combine only the remaining pair',()=>{
  const plan = planGenerationInputPacking(images(17));
  assert.equal(plan.packed,true);assert.equal(plan.physicalInputCount,16);assert.equal(plan.logicalInputCount,17);
  assert.equal(plan.slots.filter(slot => slot.kind === 'board').length,1);
  assert.equal(plan.slots.filter(slot => slot.kind === 'single').length,15);
  assert.deepEqual(plan.slots[0].tiles.map(tile => tile.label),['Input 1','Input 2']);
  assert.deepEqual(sources(plan),Array.from({length:17},(_,index)=>index+1));
});

test('composition, sketch, canvas guide, blockout and sheet primary subject stay standalone',()=>{
  const source = images(35), protectedInputs = [1,3,7,20,35];
  const roles = ['current composition','drawn scene composition','canvas annotation guide','original Blender blockout — structure authority','primary subject original'].map((role,index)=>({image:protectedInputs[index],role}));
  const plan = planGenerationInputPacking(source,roles);
  assert.deepEqual(plan.slots.slice(0,5),protectedInputs.map(sourceIndex=>({kind:'single',sourceIndex})));
  const packed = plan.slots.filter(slot=>slot.kind==='board').flatMap(slot=>slot.tiles.map(tile=>tile.sourceIndex));
  assert.ok(protectedInputs.every(index=>!packed.includes(index)));
  assert.deepEqual(sources(plan).sort((a,b)=>a-b),Array.from({length:35},(_,index)=>index+1));
});

test('one hundred inputs balance across all available slots with every input exactly once',()=>{
  const source=images(100),plan=planGenerationInputPacking(source,[{image:1,role:'current composition'},{image:2,role:'canvas annotation guide'},{image:100,role:'original Blender blockout — structure authority'}]);
  assert.equal(plan.physicalInputCount,16);
  assert.deepEqual(sources(plan).sort((a,b)=>a-b),Array.from({length:100},(_,index)=>index+1));
  const sizes=plan.slots.filter(slot=>slot.kind==='board').map(slot=>slot.tiles.length);
  assert.ok(Math.max(...sizes)-Math.min(...sizes)<=1);
  for(const slot of plan.slots.filter(slot=>slot.kind==='board')) {
    assert.ok(slot.width<=4096&&slot.height<=4096);
    for(const tile of slot.tiles) {
      const original=source[tile.sourceIndex-1],rect=tile.imageRect;
      assert.ok(tile.width>=512&&tile.height>=512);
      assert.ok(rect.x>=tile.x&&rect.y>=tile.y+56&&rect.x+rect.width<=tile.x+tile.width&&rect.y+rect.height<=tile.y+tile.height);
      const scale=Math.min(1,(tile.width-32)/original.width,(tile.height-72)/original.height);
      assert.equal(rect.width,Math.max(1,Math.floor(original.width*scale)));
      assert.equal(rect.height,Math.max(1,Math.floor(original.height*scale)));
    }
  }
});

test('small source photos use compact boards and remain at native pixel dimensions',()=>{
  const source=Array.from({length:17},()=>({width:64,height:48}));
  const plan=planGenerationInputPacking(source),board=plan.slots[0];
  assert.equal(board.kind,'board');assert.deepEqual([board.width,board.height],[1024,512]);
  for(const tile of board.tiles)assert.deepEqual([tile.imageRect.width,tile.imageRect.height],[64,48]);
});

test('board cells follow useful source detail up to their size budget without enlarging smaller neighbors',()=>{
  const source=Array.from({length:17},()=>({width:64,height:48}));
  source[0]={width:1200,height:800};
  let board=planGenerationInputPacking(source).slots[0];
  assert.deepEqual([board.width,board.height],[2464,1232]);
  assert.deepEqual([board.tiles[0].imageRect.width,board.tiles[0].imageRect.height],[1200,800]);
  assert.deepEqual([board.tiles[1].imageRect.width,board.tiles[1].imageRect.height],[64,48]);
  source[0]={width:6000,height:4000};board=planGenerationInputPacking(source).slots[0];
  assert.deepEqual([board.width,board.height],[4096,2048]);
  assert.deepEqual([board.tiles[0].imageRect.width,board.tiles[0].imageRect.height],[2016,1344]);
});

test('readability capacity is explicit rather than dropping photos or shrinking below minimum cell size',()=>{
  const roles=[{image:1,role:'current composition'},{image:2,role:'canvas annotation guide'}];
  const largest=planGenerationInputPacking(images(898),roles);
  assert.equal(largest.physicalInputCount,16);assert.equal(sources(largest).length,898);
  assert.ok(largest.slots.slice(2).every(slot=>slot.width===4096&&slot.height===4096&&slot.tiles.length===64));
  assert.throws(()=>planGenerationInputPacking(images(899),roles),/cannot fit into readable image boards.*no references were removed/);
  assert.throws(()=>planGenerationInputPacking(images(17),Array.from({length:16},(_,index)=>({image:index+1,role:'current composition'}))),/standalone sources/);
});

test('plans are deterministic and leave source objects and role mappings untouched',()=>{
  const source=freeze(images(40)),roles=freeze([{image:1,role:'current composition'},{image:19,role:'original reference photo',labels:['2','8']}]);
  const before=JSON.stringify({source,roles}),first=planGenerationInputPacking(source,roles),second=planGenerationInputPacking(source,roles);
  assert.deepEqual(first,second);assert.equal(JSON.stringify({source,roles}),before);
});

test('invalid dimensions and roles fail before a renderer or provider receives input',()=>{
  for(const width of [0,-1,NaN,Infinity,1.5,'20'])assert.throws(()=>planGenerationInputPacking([{width,height:20}]),/actual image dimensions/);
  for(const image of [0,2,1.5,'1'])assert.throws(()=>planGenerationInputPacking(images(1),[{image,role:'current composition'}]),/roles do not match/);
});

test('renderer rejects missing, repeated and malformed planned inputs before touching the DOM',async()=>{
  const source=images(17);
  const missing=planGenerationInputPacking(source);missing.slots.pop();missing.physicalInputCount--;
  await assert.rejects(renderGenerationInputBoards(source,missing),/leaves out an input/);
  const repeated=planGenerationInputPacking(source);repeated.slots[0].tiles[1].sourceIndex=1;
  await assert.rejects(renderGenerationInputBoards(source,repeated),/missing or repeated input/);
  const invalid=planGenerationInputPacking(source);invalid.slots[0].tiles[0].imageRect.y=0;
  await assert.rejects(renderGenerationInputBoards(source,invalid),/tile is invalid/);
});
