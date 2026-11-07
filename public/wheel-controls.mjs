export const WHEEL_PIXEL_THRESHOLD = 100;
export const WHEEL_GESTURE_GAP_MS = 180;

export function cycleTool(tool, direction, orderedTools) {
  if (!Array.isArray(orderedTools) || !orderedTools.length || !Number.isFinite(direction) || direction === 0) return tool;
  const index = orderedTools.indexOf(tool);
  if (index < 0) return tool;
  return orderedTools[(index + Math.sign(direction) + orderedTools.length) % orderedTools.length];
}

// Small pixel events form one gesture. Large events still move only one tool,
// and consuming a gesture discards its remainder rather than queuing skips.
export function createWheelStepper() {
  let accumulated = 0;
  let direction = 0;
  let lastTime = null;

  function reset() {
    accumulated = 0;
    direction = 0;
    lastTime = null;
  }

  function step(event, time = performance.now()) {
    const deltaY = event?.deltaY;
    const deltaX = event?.deltaX ?? 0;
    const mode = event?.deltaMode ?? 0;
    if (!Number.isFinite(deltaY) || !Number.isFinite(deltaX) || deltaY === 0 || !Number.isFinite(time) || Math.abs(deltaX) > Math.abs(deltaY) || ![0, 1, 2].includes(mode)) {
      reset();
      return 0;
    }

    const nextDirection = Math.sign(deltaY);
    if (nextDirection !== direction || (lastTime !== null && (time < lastTime || time - lastTime > WHEEL_GESTURE_GAP_MS))) accumulated = 0;
    direction = nextDirection;
    lastTime = time;

    if (mode !== 0) {
      accumulated = 0;
      return direction;
    }
    accumulated += Math.abs(deltaY);
    if (accumulated < WHEEL_PIXEL_THRESHOLD) return 0;
    accumulated = 0;
    return direction;
  }

  return {step, reset};
}
