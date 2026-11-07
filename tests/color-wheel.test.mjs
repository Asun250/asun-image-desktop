import test from 'node:test';
import assert from 'node:assert/strict';
import {hexToHsv, hsvToHex, normalizeHex, wheelPointToHsv} from '../public/color-wheel.mjs';

test('HEX colors validate and normalize without accepting partial input', () => {
  assert.equal(normalizeHex(' abcdef '), '#ABCDEF');
  for (const invalid of ['#FFF', '#FF0088x', 'xyzxyz', '', '#12345']) assert.equal(normalizeHex(invalid), null);
  assert.throws(() => hexToHsv('red'), TypeError);
});

test('wheel covers hue, saturation, white and black', () => {
  assert.equal(hsvToHex(0, 1, 1), '#FF0000');
  assert.equal(hsvToHex(60, 1, 1), '#FFFF00');
  assert.equal(hsvToHex(120, 1, 1), '#00FF00');
  assert.equal(hsvToHex(180, 1, 1), '#00FFFF');
  assert.equal(hsvToHex(240, 1, 1), '#0000FF');
  assert.equal(hsvToHex(300, 1, 1), '#FF00FF');
  assert.equal(hsvToHex(359, 0, 1), '#FFFFFF');
  assert.equal(hsvToHex(90, 1, 0), '#000000');
  assert.equal(hsvToHex(-120, 1, 1), '#0000FF');
});

test('RGB / HSV conversion preserves all sampled colors including gray', () => {
  for (let red = 0; red <= 255; red += 17) {
    for (let green = 0; green <= 255; green += 17) {
      for (let blue = 0; blue <= 255; blue += 17) {
        const hex = `#${[red, green, blue].map(value => value.toString(16).padStart(2, '0')).join('').toUpperCase()}`;
        const {h, s, v} = hexToHsv(hex);
        assert.equal(hsvToHex(h, s, v), hex);
      }
    }
  }
});

test('wheel pointer coordinates clamp outside the wheel and locate center', () => {
  assert.deepEqual(wheelPointToHsv(234, 120), {h: 0, s: 1});
  assert.deepEqual(wheelPointToHsv(120, 234), {h: 90, s: 1});
  assert.deepEqual(wheelPointToHsv(6, 120), {h: 180, s: 1});
  assert.deepEqual(wheelPointToHsv(120, 6), {h: 270, s: 1});
  assert.equal(wheelPointToHsv(177, 120).s, .5);
  assert.equal(wheelPointToHsv(120, 120).s, 0);
  assert.equal(wheelPointToHsv(900, 120).s, 1);
});
