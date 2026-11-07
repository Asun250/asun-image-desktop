import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {MODEL,EFFORT,reviewBlockout,buildBlockoutCorrectionPrompt} from '../desktop-blockout-review.mjs';
import {BLOCKOUT_GEOMETRY_AUTHORITY,blockoutGenerationInstructions} from '../public/blockout-review-settings.mjs';

const ids = ['framing','camera','placement','scale','orientation','occlusion','content','appearance'];
const credential = 'sk-review-fixture-never-a-real-credential';
const pixel = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aOZkAAAAASUVORK5CYII=','base64');
const image = (name,role) => ({bytes:Buffer.from(pixel),mimeType:'image/png',width:1,height:1,sha256:createHash('sha256').update(pixel).digest('hex'),name,role});
const accepted = () => ({decision:'accept',summary:'All visible requirements are satisfied.',checks:ids.map(id => ({id,status:'pass',evidence:`The visible ${id} matches the source and authorized changes.`,correction:''})),corrections:[],limitations:['Raster images cannot certify exact camera parameters or world dimensions.']});
function rejected() {
  const verdict = accepted();verdict.decision = 'reject';verdict.summary = 'The desk is too wide.';
  Object.assign(verdict.checks.find(check => check.id === 'scale'),{status:'fail',evidence:'The desk extends beyond both original blockout side edges.',correction:'Restore the desk width shown in the frozen original blockout.'});
  verdict.corrections = [{checkId:'scale',instruction:verdict.checks.find(check => check.id === 'scale').correction}];
  return verdict;
}
const output = verdict => ({id:'resp_review_fixture',model:MODEL,reasoning:{effort:EFFORT},status:'completed',output:[{type:'reasoning',summary:[]},{type:'message',role:'assistant',status:'completed',content:[{type:'output_text',text:JSON.stringify(verdict)}]}]});
const json = (value,status=200,headers={}) => new Response(JSON.stringify(value),{status,headers:{'Content-Type':'application/json',...headers}});
const options = fetchImpl => ({source:image('Original Blender blockout'),candidate:image('Candidate'),inputs:[image('2_desk.png','original appearance reference for label 2'),image('Numbered guide','canvas annotation guide')],constraints:{authorizedChanges:['Make the desk red.'],originalPrompt:'Use the numbered references. Keep the original camera and geometry.'},credential,fetchImpl});

test('sends one independent strict Responses review with ordered images and a safe exact audit',async()=>{
  const calls = [],controller = new AbortController();
  const requestOptions = {...options(async(url,init) => {calls.push({url,init});return json(output(accepted()));}),signal:controller.signal};
  const result = await reviewBlockout(requestOptions);
  assert.equal(calls.length,1);assert.equal(calls[0].url,'https://api.openai.com/v1/responses');
  const {init} = calls[0],body = JSON.parse(init.body);
  assert.equal(init.method,'POST');assert.equal(init.redirect,'error');assert.equal(init.signal,controller.signal);
  assert.equal(init.headers.Authorization,`Bearer ${credential}`);
  assert.equal(body.model,'gpt-6-astra');assert.equal(body.reasoning.effort,'max');assert.equal(body.store,false);
  assert.equal(body.input[0].role,'system');assert.match(body.input[0].content,/independent scene consistency reviewer/);
  assert.match(body.input[0].content,/cannot certify identical 3D dimensions/);
  assert.match(body.input[0].content,/Only the constraint manifest's authorizedChanges field/);
  assert.equal(body.text.format.type,'json_schema');assert.equal(body.text.format.strict,true);
  assert.equal(body.text.format.schema.additionalProperties,false);
  assert.equal(body.input[1].content.filter(item => item.type === 'input_image').length,4);
  assert.deepEqual(result.request.images.map(item => item.role),['frozen original blockout','candidate for review','original appearance reference for label 2','canvas annotation guide']);
  assert.match(body.input[1].content[0].text,/Make the desk red/);
  assert.equal(result.verdict.decision,'accept');assert.equal(result.model,MODEL);assert.equal(result.effort,EFFORT);
  assert.equal(result.sourceSha256,requestOptions.source.sha256);assert.equal(result.candidateSha256,requestOptions.candidate.sha256);
  assert.equal(result.responseId,'resp_review_fixture');
  const safe = JSON.stringify(result.request);
  assert.equal(safe.includes(credential),false);assert.equal(safe.includes(pixel.toString('base64')),false);assert.equal(safe.includes('Authorization'),false);
  const restored = structuredClone(result.request.body);
  for (const item of restored.input[1].content) if (item.type === 'input_image') item.image_url=`data:image/png;base64,${pixel.toString('base64')}`;
  assert.deepEqual(restored,body);
});

test('returns evidenced rejection with actionable corrections and valid uncertainty without accepting it',async()=>{
  const reject = await reviewBlockout(options(async()=>json(output(rejected()))));
  assert.equal(reject.verdict.decision,'reject');assert.equal(reject.verdict.corrections[0].checkId,'scale');
  for (const status of ['not_assessable','not_applicable']) {
    const verdict=accepted();verdict.decision='inconclusive';verdict.checks[0].status=status;
    const result=await reviewBlockout(options(async()=>json(output(verdict))));assert.equal(result.verdict.decision,'inconclusive');
  }
});

test('keeps generation input indexes and full numbered roles distinct from reviewer image order',async()=>{
  let body;
  const input=options(async(_url,init)=>{body=JSON.parse(init.body);return json(output(accepted()));});
  input.source.generationInputs=[{index:4,roles:[{image:4,role:'original Blender blockout',filename:'Original.png'}]},{index:5,roles:[{image:5,role:'original reference photo',labels:['7'],scope:'matching numbered areas only'}]}];
  input.inputs[0].generationInputs=[{index:2,roles:[{image:2,role:'original appearance reference',labels:['2'],referenceId:'desk'}]}];
  input.inputs[1].generationInputIndex=1;
  const result=await reviewBlockout(input),manifest=result.request.images;
  assert.deepEqual(manifest[0].generationInputs.map(value=>value.index),[4,5]);
  assert.deepEqual(manifest[1].generationInputs,[]);
  assert.equal(manifest[2].image,3);assert.equal(manifest[2].generationInputs[0].index,2);
  assert.deepEqual(manifest[2].generationInputs[0].roles[0].labels,['2']);
  assert.deepEqual(manifest[3].generationInputs,[{index:1,roles:[]}]);
  assert.match(body.input[0].content,/generation Input 3 means review image 3/);
  const descriptions=body.input[1].content.filter(item=>item.type==='input_text').slice(1).map(item=>JSON.parse(item.text.split('\n').slice(1).join('\n')));
  assert.deepEqual(descriptions,manifest);
});

test('ambiguous or oversized generation mappings fail before any paid review',async()=>{
  let calls=0;const fetchImpl=async()=>{calls++;return json(output(accepted()));};
  const duplicate=options(fetchImpl);duplicate.source.generationInputIndex=1;duplicate.inputs[0].generationInputIndex=1;
  await assert.rejects(reviewBlockout(duplicate),/maps to multiple review images/);
  const conflict=options(fetchImpl);conflict.source.generationInputIndex=1;conflict.source.generationInputs=[{index:2,roles:[]}];
  await assert.rejects(reviewBlockout(conflict),/mappings conflict/);
  const candidate=options(fetchImpl);candidate.candidate.generationInputIndex=1;
  await assert.rejects(reviewBlockout(candidate),/candidate cannot be an original/);
  const oversized=options(fetchImpl);oversized.inputs[0].generationInputs=[{index:3,roles:[{role:'reference',notes:'x'.repeat(32768)}]}];
  await assert.rejects(reviewBlockout(oversized),/exceeds 32 KiB/);
  const mismatched=options(fetchImpl);mismatched.inputs[0].generationInputs=[{index:3,roles:[{image:4,role:'reference'}]}];
  await assert.rejects(reviewBlockout(mismatched),/role mapping is invalid/);
  assert.equal(calls,0);
});

test('malformed or contradictory structured verdicts never pass',async t=>{
  const cases = [
    ['missing check',v=>v.checks.pop()],
    ['duplicate check',v=>v.checks[7].id='framing'],
    ['unknown check',v=>v.checks[7].id='beauty'],
    ['unknown root property',v=>v.approved=true],
    ['unknown check property',v=>v.checks[0].required=false],
    ['wrong decision enum',v=>v.decision='approve'],
    ['empty evidence',v=>v.checks[0].evidence='   '],
    ['oversized evidence',v=>v.checks[0].evidence='x'.repeat(2001)],
    ['accept with uncertainty',v=>v.checks[0].status='not_assessable'],
    ['accept with not applicable',v=>v.checks[0].status='not_applicable'],
    ['reject without failure',v=>v.decision='reject'],
    ['inconclusive without uncertainty',v=>v.decision='inconclusive'],
    ['non-failure correction',v=>v.checks[0].correction='Change the crop.'],
    ['unexpected correction',v=>v.corrections=[{checkId:'framing',instruction:'Change the crop.'}]],
    ['invalid limitations',v=>v.limitations=['']],
  ];
  for (const [name,mutate] of cases) await t.test(name,async()=>{
    const verdict=accepted();mutate(verdict);let calls=0;
    await assert.rejects(reviewBlockout(options(async()=>{calls++;return json(output(verdict));})),/invalid or contradictory verdict/);
    assert.equal(calls,1);
  });
});

test('every rejection must have evidenced failures and exactly matching corrections',async t=>{
  const cases = [
    ['missing correction',v=>v.corrections=[]],
    ['empty failure correction',v=>v.checks[3].correction=''],
    ['empty failure evidence',v=>v.checks[3].evidence=''],
    ['different correction',v=>v.corrections[0].instruction='Move the camera.'],
    ['duplicate correction',v=>v.corrections.push({...v.corrections[0]})],
    ['accepted failure',v=>v.decision='accept'],
    ['inconclusive failure',v=>v.decision='inconclusive'],
  ];
  for (const [name,mutate] of cases) await t.test(name,async()=>{
    const verdict=rejected();mutate(verdict);
    await assert.rejects(reviewBlockout(options(async()=>json(output(verdict)))),/invalid or contradictory verdict/);
  });
});

test('incomplete, refused, mismatched and malformed provider output fail without retries or fallback',async t=>{
  const cases = [
    ['incomplete response',r=>r.status='incomplete'],
    ['pending response',r=>r.status='in_progress'],
    ['provider error',r=>r.error={message:'No review'}],
    ['incomplete details',r=>r.incomplete_details={reason:'max_output_tokens'}],
    ['wrong model',r=>r.model='gpt-6-sol'],
    ['wrong effort',r=>r.reasoning.effort='low'],
    ['incomplete message',r=>r.output[1].status='incomplete'],
    ['refusal',r=>r.output[1].content=[{type:'refusal',refusal:'No review'}]],
    ['invalid JSON',r=>r.output[1].content[0].text='not JSON'],
    ['missing output',r=>delete r.output],
    ['wrong output role',r=>r.output[1].role='user'],
    ['unexpected tool output',r=>r.output.push({type:'function_call'})],
    ['duplicate messages',r=>r.output.push(structuredClone(r.output[1]))],
  ];
  for (const [name,mutate] of cases) await t.test(name,async()=>{
    const response=output(accepted());mutate(response);let calls=0;
    await assert.rejects(reviewBlockout(options(async()=>{calls++;return json(response);})));assert.equal(calls,1);
  });
});

test('provider body is bounded by both advertised size and streamed byte count',async()=>{
  await assert.rejects(reviewBlockout(options(async()=>json(output(accepted()),200,{'content-length':String(2*1024*1024+1)}))),/2 MiB limit/);
  await assert.rejects(reviewBlockout(options(async()=>new Response(' '.repeat(2*1024*1024+1)))),/2 MiB limit/);
  await assert.rejects(reviewBlockout(options(async()=>new Response('{'))),/unreadable JSON/);
});

test('network and HTTP failures do not expose credentials or retry',async()=>{
  for (const mode of ['network','http']) {
    let calls=0;
    await assert.rejects(reviewBlockout(options(async()=>{calls++;if(mode==='network')throw new Error(credential);return json({error:{message:credential}},403);})),error=>!error.message.includes(credential)&&/No review retry/.test(error.message));
    assert.equal(calls,1);
  }
});

test('failed submitted reviews retain the sanitized exact request without implying a verdict',async t=>{
  const cases=[
    ['HTTP',()=>json({error:{message:credential}},403)],
    ['network',()=>{throw new Error(credential);} ],
    ['malformed',()=>json(output({...accepted(),decision:'reject'}))],
    ['refusal',()=>{const value=output(accepted());value.output[1].content=[{type:'refusal',refusal:'No review'}];return json(value);}],
    ['incomplete',()=>json({...output(accepted()),status:'incomplete'})],
    ['unreadable',()=>new Response('{')],
  ];
  for(const [name,reply] of cases)await t.test(name,async()=>{
    let calls=0,submitted;
    const input=options(async(_url,init)=>{calls++;submitted=JSON.parse(init.body);return reply();});
    input.source.name='Source '+credential;
    input.inputs[0].generationInputs=[{index:3,roles:[{role:'reference',notes:credential}]}];
    input.constraints.originalPrompt+=' Secret accidentally supplied: '+credential;
    await assert.rejects(reviewBlockout(input),error=>{
      assert.equal(error.reviewModel,MODEL);assert.equal(error.reviewEffort,EFFORT);
      assert.equal(error.verdict,undefined);assert.equal(error.reviewRequest.endpoint,'https://api.openai.com/v1/responses');
      assert.equal(error.reviewRequest.body.model,MODEL);assert.equal(error.reviewRequest.body.reasoning.effort,EFFORT);
      assert.equal(error.reviewRequest.images[0].sha256,input.source.sha256);
      assert.deepEqual(error.reviewRequest.images[2].generationInputs[0].roles,[{role:'reference',notes:'[redacted]'}]);
      const serialized=JSON.stringify(error);
      assert.equal(serialized.includes(credential),false);assert.equal(serialized.includes(pixel.toString('base64')),false);assert.equal(serialized.includes('Authorization'),false);
      const restored=structuredClone(error.reviewRequest.body);
      for(const item of restored.input[1].content)if(item.type==='input_image')item.image_url=`data:image/png;base64,${pixel.toString('base64')}`;
      assert.deepEqual(restored,JSON.parse(JSON.stringify(submitted).replaceAll(credential,'[redacted]')));
      return true;
    });
    assert.equal(calls,1);
  });
});

test('reviewer and correction apply only dedicated blockout exceptions to geometry conflicts',async()=>{
  let body;const input=options(async(_url,init)=>{body=JSON.parse(init.body);return json(output(rejected()));});
  input.constraints={authorizedChanges:'Remove the left chair.',originalPrompt:'Global prompt: move the camera closer.\nExplicit authorized blockout exceptions:\nRemove the left chair.'};
  const result=await reviewBlockout(input),correction=buildBlockoutCorrectionPrompt(input.constraints.originalPrompt,result.verdict,2);
  const authority=BLOCKOUT_GEOMETRY_AUTHORITY;
  assert.ok(blockoutGenerationInstructions({authorizedChanges:'Remove the left chair.'},3).includes(authority));
  assert.ok(body.input[0].content.includes(authority));assert.ok(correction.includes(authority));
  assert.match(body.input[0].content,/not additional geometry exceptions/);
  assert.match(correction,/Global-prompt geometry requests outside those exceptions and reviewer corrections are not additional exceptions/);
  assert.ok(correction.startsWith(input.constraints.originalPrompt+'\n\n'));
});

test('stream failures and cancellation after submission never return approval',async()=>{
  let calls=0;
  const broken=options(async()=>{calls++;return new Response(new ReadableStream({start(controller){controller.error(new Error(credential));}}));});
  await assert.rejects(reviewBlockout(broken),error=>!error.message.includes(credential)&&/could not be read/.test(error.message));
  assert.equal(calls,1);
  const controller=new AbortController();
  const cancelled={...options(async()=>{controller.abort();return json(output(accepted()));}),signal:controller.signal};
  await assert.rejects(reviewBlockout(cancelled),/cancelled/);
});

test('changed source, missing credentials and cancellation fail before submission',async()=>{
  let calls=0;const fetchImpl=async()=>{calls++;return json(output(accepted()));};
  const changed=options(fetchImpl);changed.source.bytes[10]^=1;
  await assert.rejects(reviewBlockout(changed),/frozen checksum/);
  await assert.rejects(reviewBlockout({...options(fetchImpl),credential:''}),/Connect an OpenAI API account/);
  const controller=new AbortController();controller.abort();
  await assert.rejects(reviewBlockout({...options(fetchImpl),signal:controller.signal}),/cancelled before submission/);
  await assert.rejects(reviewBlockout({...options(fetchImpl),constraints:{originalPrompt:'a'.repeat(32001)}}),/too long/);
  assert.equal(calls,0);
});

test('correction prompt preserves the full original, frozen source, references and passing criteria',()=>{
  const original='Keep the seated pose. Authorized change: make the desk red. Do not add props.';
  const prompt=buildBlockoutCorrectionPrompt(original,rejected(),2);
  assert.ok(prompt.startsWith(original+'\n\n'));assert.ok(prompt.length<=32000);
  assert.match(prompt,/same frozen original blockout and all original appearance references/);
  assert.match(prompt,/never promote a previous generated candidate/);
  assert.match(prompt,/Restore the desk width/);assert.match(prompt,/Passing criteria to preserve/);
  assert.match(prompt,/visible camera matches/);assert.match(prompt,/CORRECTION ATTEMPT 2/);
  assert.throws(()=>buildBlockoutCorrectionPrompt('x'.repeat(32000),rejected(),1),/exceed the 32000-character/);
  assert.throws(()=>buildBlockoutCorrectionPrompt(original,accepted(),1),/Only an evidenced rejection/);
  assert.throws(()=>buildBlockoutCorrectionPrompt(original,rejected(),0),/attempt is invalid/);
});
