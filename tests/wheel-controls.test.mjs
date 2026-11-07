import {test} from 'node:test';
import assert from 'node:assert/strict';
import {cycleTool, createWheelStepper, WHEEL_PIXEL_THRESHOLD, WHEEL_GESTURE_GAP_MS} from '../public/wheel-controls.mjs';

const pixels = (deltaY, deltaX = 0) => ({deltaY, deltaX, deltaMode: 0});

test('tool cycling follows supplied order, wraps both ways, and uses direction sign', () => {
  const tools = ['select', 'text', 'pencil', 'highlight'];
  assert.equal(cycleTool('text', 120, tools), 'pencil');
  assert.equal(cycleTool('text', -120, tools), 'select');
  assert.equal(cycleTool('highlight', 1, tools), 'select');
  assert.equal(cycleTool('select', -1, tools), 'highlight');
  assert.deepEqual(tools, ['select', 'text', 'pencil', 'highlight']);
  assert.equal(cycleTool('text', 1, ['text']), 'text');
});

test('invalid tool cycling leaves the current tool unchanged', () => {
  for (const direction of [0, NaN, Infinity, -Infinity, undefined, '1']) assert.equal(cycleTool('text', direction, ['text', 'pencil']), 'text');
  for (const tools of [[], undefined, 'text,pencil']) assert.equal(cycleTool('text', 1, tools), 'text');
  assert.equal(cycleTool('missing', 1, ['text', 'pencil']), 'missing');
});

test('each physical notch moves once without debouncing distinct notches', () => {
  const wheel = createWheelStepper();
  assert.deepEqual([wheel.step(pixels(120), 0), wheel.step(pixels(120), 1), wheel.step(pixels(-120), 2)], [1, 1, -1]);
  assert.equal(wheel.step(pixels(600), 3), 1);
  assert.equal(wheel.step(pixels(1), 4), 0);
  assert.equal(wheel.step(pixels(-600), 5), -1);
});

test('split notch and small trackpad events accumulate to one bounded step', () => {
  assert.equal(WHEEL_PIXEL_THRESHOLD, 100);
  const wheel = createWheelStepper();
  const steps = Array.from({length: 12}, (_, index) => wheel.step(pixels(10), index * 10));
  assert.deepEqual(steps, [0, 0, 0, 0, 0, 0, 0, 0, 0, 1, 0, 0]);
  assert.equal(wheel.step(pixels(80), 120), 1);
  assert.equal(wheel.step(pixels(99), 130), 0);
  assert.equal(wheel.step(pixels(1), 140), 1);
});

test('crossing threshold discards overshoot instead of queuing later tool changes', () => {
  const wheel = createWheelStepper();
  assert.equal(wheel.step(pixels(90), 0), 0);
  assert.equal(wheel.step(pixels(80), 1), 1);
  assert.equal(wheel.step(pixels(30), 2), 0);
  assert.equal(wheel.step(pixels(70), 3), 1);
});

test('gesture gaps, direction flips, and explicit reset clear partial intent', () => {
  assert.equal(WHEEL_GESTURE_GAP_MS, 180);
  const wheel = createWheelStepper();
  assert.equal(wheel.step(pixels(60), 0), 0);
  assert.equal(wheel.step(pixels(40), 180), 1);
  assert.equal(wheel.step(pixels(60), 200), 0);
  assert.equal(wheel.step(pixels(40), 381), 0);
  assert.equal(wheel.step(pixels(-60), 390), 0);
  assert.equal(wheel.step(pixels(-40), 400), -1);
  assert.equal(wheel.step(pixels(99), 410), 0);
  wheel.reset();
  assert.equal(wheel.step(pixels(1), 420), 0);
  assert.equal(wheel.step(pixels(99), 430), 1);
});

test('line and page modes produce one step and clear earlier pixel accumulation', () => {
  const wheel = createWheelStepper();
  for (const mode of [1, 2]) {
    wheel.step(pixels(90), mode * 10);
    assert.equal(wheel.step({deltaY: 0.25, deltaMode: mode}, mode * 10 + 1), 1);
    assert.equal(wheel.step(pixels(10), mode * 10 + 2), 0);
    assert.equal(wheel.step({deltaY: -500, deltaMode: mode}, mode * 10 + 3), -1);
  }
});

test('horizontal, empty, malformed, and unsupported events do not retain partial intent', () => {
  const invalid = [pixels(0), pixels(NaN), pixels(Infinity), pixels(1, Infinity), pixels(20, 21), {deltaY: 100, deltaMode: 3}, {deltaY: '100'}, null];
  for (const event of invalid) {
    const wheel = createWheelStepper();
    wheel.step(pixels(90), 0);
    assert.equal(wheel.step(event, 1), 0);
    assert.equal(wheel.step(pixels(10), 2), 0);
  }
  assert.equal(createWheelStepper().step(pixels(100, 100), 0), 1);
});

test('backwards or invalid timestamps cannot carry an earlier partial gesture', () => {
  const wheel = createWheelStepper();
  wheel.step(pixels(90), 100);
  assert.equal(wheel.step(pixels(10), 99), 0);
  assert.equal(wheel.step(pixels(90), 100), 1);
  wheel.step(pixels(90), 101);
  assert.equal(wheel.step(pixels(10), NaN), 0);
  assert.equal(wheel.step(pixels(10), 102), 0);
});
