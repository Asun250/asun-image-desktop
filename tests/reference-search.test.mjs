import {test} from 'node:test';
import assert from 'node:assert/strict';
import {referenceSearchUrl} from '../public/reference-search.mjs';

test('blank searches open the fixed Google Images home',()=>{
  for(const query of ['', ' \t\n ', undefined,null,42,{}])assert.equal(referenceSearchUrl(query),'https://www.google.com/imghp');
});
test('image searches trim text and encode punctuation and Unicode as one query',()=>{
  const query='  café 東京 office & glass? #1 / interior  ',url=new URL(referenceSearchUrl(query));
  assert.equal(url.origin,'https://www.google.com');assert.equal(url.pathname,'/search');assert.equal(url.searchParams.get('tbm'),'isch');assert.equal(url.searchParams.get('q'),query.trim());assert.equal(url.hash,'');assert.deepEqual([...url.searchParams.keys()],['tbm','q']);
});
test('URL-looking and executable-looking input cannot change the navigation target',()=>{
  for(const query of ['https://example.com/photo?q=x&tbm=other#frag','javascript:alert(1)','//evil.example/image','data:image/png;base64,AAAA','&q=other&redirect=https://evil.example']){
    const url=new URL(referenceSearchUrl(query));assert.equal(url.origin,'https://www.google.com');assert.equal(url.pathname,'/search');assert.equal(url.searchParams.get('tbm'),'isch');assert.equal(url.searchParams.get('q'),query);assert.equal(url.hash,'');assert.deepEqual([...url.searchParams.keys()],['tbm','q']);
  }
});
test('query length matches HTML maxlength without splitting Unicode pairs or throwing on malformed input',()=>{
  assert.equal(new URL(referenceSearchUrl('a'.repeat(250))).searchParams.get('q'),'a'.repeat(200));
  assert.equal(new URL(referenceSearchUrl('a'.repeat(199)+'🏡')).searchParams.get('q'),'a'.repeat(199));
  assert.equal(new URL(referenceSearchUrl('🏡'.repeat(120))).searchParams.get('q'),'🏡'.repeat(100));
  assert.equal(new URL(referenceSearchUrl('broken\ud800text')).searchParams.get('q'),'broken�text');
});
