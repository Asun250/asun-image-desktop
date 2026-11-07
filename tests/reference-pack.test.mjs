import {test} from 'node:test';
import assert from 'node:assert/strict';
import {safePackSegment} from '../public/reference-pack.mjs';
import {validateZipPath} from '../public/reference-download.mjs';

test('pack path segments safely retain readable Unicode while repairing dangerous literal names',()=>{
  for(const value of ['../outside','C:\\folder\\photo','CON','aux.jpg','COM¹.txt','LPT9','folder/child','<>:"|?*','trailing. ','..','.','','a\0b','é','東京 葉っぱ','🌿'.repeat(100),'a'.repeat(500)]){const segment=safePackSegment(value);assert.doesNotThrow(()=>validateZipPath('originals/references/'+segment+'/photo.png'));assert.ok(segment.length<=120);assert.equal(safePackSegment(value),segment);}
  assert.equal(safePackSegment('東京 葉っぱ'),'東京 葉っぱ');assert.equal(safePackSegment('e\u0301'),'é');assert.equal(safePackSegment('CON'),'_CON');assert.equal(safePackSegment('a/b'),'a_b');assert.equal(safePackSegment('..'),'photo');
});
