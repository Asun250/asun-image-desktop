// A read-only view of the returned image. It never changes the editor project.
let currentInspector = null;

function loadStyles() {
  const href = new URL('./generated-image-inspector.css', import.meta.url).href;
  if ([...document.querySelectorAll('link[rel="stylesheet"]')].some(link => link.href === href)) return;
  const link = document.createElement('link');
  link.rel = 'stylesheet'; link.href = href;
  link.dataset.outputInspectorStyles = '';
  document.head.append(link);
}

export function openGeneratedImageInspector(image, {onSave, returnFocus, title = 'Inspect image'} = {}) {
  currentInspector?.close();
  loadStyles();
  const previousFocus = returnFocus || document.activeElement;
  const parentDialog = previousFocus?.closest?.('dialog[open]') || [...document.querySelectorAll('dialog[open]')].at(-1);
  const parentScroll = parentDialog ? {top: parentDialog.scrollTop, left: parentDialog.scrollLeft} : null;
  const dialog = document.createElement('dialog');
  dialog.dataset.outputInspector = '';
  dialog.dataset.ready = 'false';
  dialog.className = 'output-inspector';
  dialog.setAttribute('aria-labelledby', 'outputInspectorTitle');
  dialog.innerHTML = `<header class="output-inspector-heading">
    <button type="button" data-inspector-back aria-label="Back to result">← Back to result</button>
    <div class="output-inspector-title"><h2 id="outputInspectorTitle"></h2><p data-inspector-dimensions>Loading original image…</p></div>
    <button type="button" data-inspector-save hidden>Save image</button>
  </header>
  <div class="output-inspector-toolbar" role="toolbar" aria-label="Image zoom controls">
    <div class="output-inspector-zoom-controls">
      <button type="button" data-inspector-fit title="Fit image (0)" disabled>Fit</button>
      <button type="button" data-inspector-actual title="Actual pixels (1)" disabled>100%</button>
      <button type="button" data-inspector-zoom-out aria-label="Zoom out" title="Zoom out (−)" disabled>−</button>
      <output data-inspector-zoom aria-label="Zoom level">—</output>
      <button type="button" data-inspector-zoom-in aria-label="Zoom in" title="Zoom in (+)" disabled>+</button>
    </div>
    <p class="output-inspector-short-hint">Scroll to zoom · Drag to inspect</p>
  </div>
  <div class="output-inspector-stage" data-inspector-stage tabindex="0" role="region" aria-label="Generated image inspection. Scroll to zoom, drag to pan. Keyboard: plus and minus to zoom, 0 to fit, 1 for actual pixels, arrow keys to pan.">
    <img data-inspector-image alt="Generated image at original resolution" draggable="false" hidden>
    <p class="output-inspector-status" data-inspector-status role="status" aria-live="polite">Loading original image…</p>
  </div>
  <footer class="output-inspector-footer"><span>Inspect before saving. Your project stays unchanged.</span><span>Pinch to zoom · + / − zoom · 0 Fit · 1 Actual pixels · Esc Back</span></footer>`;
  dialog.querySelector('h2').textContent = title;
  const $ = key => dialog.querySelector(`[data-inspector-${key}]`);
  const stage = $('stage'), photo = $('image'), status = $('status');
  const listeners = new AbortController();
  const signal = listeners.signal;
  let closed = false, ready = false, saving = false, fitMode = true;
  let scale = 1, x = 0, y = 0, naturalWidth = 0, naturalHeight = 0;
  const pointers = new Map();
  let gesture = null;
  let resizeObserver;

  const stageSize = () => ({width: stage.clientWidth, height: stage.clientHeight});
  const fitScale = () => {
    const {width, height} = stageSize();
    return Math.min(1, Math.max(1, width - 32) / naturalWidth, Math.max(1, height - 32) / naturalHeight);
  };
  const minScale = () => Math.min(0.01, fitScale() / 4);
  const center = () => { const {width, height} = stageSize(); return {x: width / 2, y: height / 2}; };
  function point(event) {
    const bounds = stage.getBoundingClientRect();
    return {x: event.clientX - bounds.left - stage.clientLeft, y: event.clientY - bounds.top - stage.clientTop};
  }
  function clampPan() {
    const {width, height} = stageSize();
    const drawnWidth = naturalWidth * scale, drawnHeight = naturalHeight * scale;
    x = drawnWidth <= width ? (width - drawnWidth) / 2 : Math.min(0, Math.max(width - drawnWidth, x));
    y = drawnHeight <= height ? (height - drawnHeight) / 2 : Math.min(0, Math.max(height - drawnHeight, y));
  }
  function render() {
    if (!ready || closed) return;
    clampPan();
    photo.style.transform = `translate(${x}px, ${y}px) scale(${scale})`;
    dialog.dataset.scale = String(scale);
    $('zoom').value = `${scale < 0.01 ? (scale * 100).toFixed(1) : Math.round(scale * 100)}%`;
    $('zoom').textContent = $('zoom').value;
    $('zoom-out').disabled = scale <= minScale() * 1.001;
    $('zoom-in').disabled = scale >= 8;
    $('fit').setAttribute('aria-pressed', String(fitMode));
    $('actual').setAttribute('aria-pressed', String(Math.abs(scale - 1) < 0.0001));
    stage.dataset.pannable = String(naturalWidth * scale > stage.clientWidth || naturalHeight * scale > stage.clientHeight);
  }
  function zoom(next, anchor = center()) {
    if (!ready || closed) return;
    const nextScale = Math.max(minScale(), Math.min(8, next));
    x = anchor.x - (anchor.x - x) * nextScale / scale;
    y = anchor.y - (anchor.y - y) * nextScale / scale;
    scale = nextScale; fitMode = false; render();
  }
  function fit() {
    if (!ready || closed) return;
    scale = fitScale(); fitMode = true;
    const middle = center();
    x = middle.x - naturalWidth * scale / 2; y = middle.y - naturalHeight * scale / 2;
    render();
  }
  function endGesture() {
    if (pointers.size === 0) { gesture = null; stage.dataset.dragging = 'false'; return; }
    const points = [...pointers.values()];
    if (points.length > 1) {
      const midpoint = {x: (points[0].x + points[1].x) / 2, y: (points[0].y + points[1].y) / 2};
      gesture = {kind: 'pinch', distance: Math.max(1, Math.hypot(points[1].x - points[0].x, points[1].y - points[0].y)), scale, imageX: (midpoint.x - x) / scale, imageY: (midpoint.y - y) / scale};
    } else gesture = {kind: 'pan', start: points[0], x, y};
    stage.dataset.dragging = 'true';
  }
  function close() {
    if (closed) return;
    closed = true;
    listeners.abort(); resizeObserver?.disconnect(); pointers.clear();
    photo.onload = null; photo.onerror = null;
    if (dialog.open) dialog.close();
    dialog.remove();
    if (parentDialog?.isConnected && parentScroll) {
      parentDialog.scrollTop = parentScroll.top; parentDialog.scrollLeft = parentScroll.left;
    }
    if (previousFocus?.isConnected && typeof previousFocus.focus === 'function') previousFocus.focus({preventScroll: true});
    if (currentInspector === controller) currentInspector = null;
  }
  const controller = {close};
  currentInspector = controller;
  $('back').addEventListener('click', close, {signal});
  $('fit').addEventListener('click', fit, {signal});
  $('actual').addEventListener('click', () => zoom(1), {signal});
  $('zoom-in').addEventListener('click', () => zoom(scale * 1.25), {signal});
  $('zoom-out').addEventListener('click', () => zoom(scale / 1.25), {signal});
  dialog.addEventListener('cancel', event => {event.preventDefault(); event.stopPropagation(); close();}, {signal});
  dialog.addEventListener('close', close, {signal});
  dialog.addEventListener('keydown', event => {
    // Keep shortcuts inside the inspection view instead of the underlying editor.
    event.stopPropagation();
    if (event.key === 'Escape') {event.preventDefault(); close(); return;}
    if (event.ctrlKey || event.metaKey || event.altKey || !ready) return;
    const key = event.key;
    if (['+', '=', '-', '_', '0', '1', 'ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(key)) event.preventDefault();
    if (key === '+' || key === '=') zoom(scale * 1.25);
    else if (key === '-' || key === '_') zoom(scale / 1.25);
    else if (key === '0') fit();
    else if (key === '1') zoom(1);
    else if (key.startsWith('Arrow')) {
      const amount = event.shiftKey ? 150 : 50;
      x += key === 'ArrowLeft' ? amount : key === 'ArrowRight' ? -amount : 0;
      y += key === 'ArrowUp' ? amount : key === 'ArrowDown' ? -amount : 0;
      render();
    }
  }, {signal});
  stage.addEventListener('wheel', event => {
    event.preventDefault(); event.stopPropagation();
    const unit = event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? stage.clientHeight : 1;
    zoom(scale * Math.exp(-Math.max(-300, Math.min(300, event.deltaY * unit)) * 0.002), point(event));
  }, {passive: false, signal});
  stage.addEventListener('pointerdown', event => {
    if (!ready || (event.pointerType === 'mouse' && event.button !== 0)) return;
    event.preventDefault(); stage.focus({preventScroll: true});
    pointers.set(event.pointerId, point(event));
    stage.setPointerCapture(event.pointerId); endGesture();
  }, {signal});
  stage.addEventListener('pointermove', event => {
    if (!pointers.has(event.pointerId) || !ready) return;
    pointers.set(event.pointerId, point(event));
    const points = [...pointers.values()];
    if (gesture?.kind === 'pinch' && points.length > 1) {
      const midpoint = {x: (points[0].x + points[1].x) / 2, y: (points[0].y + points[1].y) / 2};
      const distance = Math.hypot(points[1].x - points[0].x, points[1].y - points[0].y);
      scale = Math.max(minScale(), Math.min(8, gesture.scale * distance / gesture.distance));
      x = midpoint.x - gesture.imageX * scale; y = midpoint.y - gesture.imageY * scale; fitMode = false;
    } else if (gesture?.kind === 'pan') {
      x = gesture.x + points[0].x - gesture.start.x; y = gesture.y + points[0].y - gesture.start.y;
    }
    render();
  }, {signal});
  const release = event => {
    if (!pointers.delete(event.pointerId)) return;
    if (stage.hasPointerCapture(event.pointerId)) stage.releasePointerCapture(event.pointerId);
    endGesture();
  };
  for (const type of ['pointerup', 'pointercancel', 'lostpointercapture']) stage.addEventListener(type, release, {signal});
  stage.addEventListener('dragstart', event => event.preventDefault(), {signal});

  if (typeof onSave === 'function') {
    $('save').hidden = false; $('save').disabled = true;
    $('save').addEventListener('click', async () => {
      if (saving || !ready || closed) return;
      saving = true; $('save').disabled = true; $('save').textContent = 'Saving…';
      try {
        await onSave(image);
        if (!closed) {status.textContent = 'Image download requested.'; status.dataset.error = 'false'; status.hidden = false;}
      } catch (error) {
        if (!closed) {status.textContent = error?.message || 'Unable to save this image. Go back to the result and try again.'; status.dataset.error = 'true'; status.hidden = false;}
      } finally {
        saving = false;
        if (!closed) {$('save').disabled = !ready; $('save').textContent = 'Save image';}
      }
    }, {signal});
  }
  document.body.append(dialog); dialog.showModal(); $('back').focus({preventScroll: true});
  resizeObserver = new ResizeObserver(() => {if (ready) {if (fitMode) fit(); else render();}});
  resizeObserver.observe(stage);
  async function load() {
    try {
      if (!image || typeof image.source !== 'string' || !image.source.trim()) throw new Error('The original image is unavailable. Return to the result and try opening it again.');
      // The full returned source is essential: thumbnails cannot reveal image detail.
      photo.src = image.source;
      await photo.decode();
      if (closed) return;
      naturalWidth = photo.naturalWidth; naturalHeight = photo.naturalHeight;
      if (!naturalWidth || !naturalHeight) throw new Error('The original image could not be read.');
      photo.style.width = `${naturalWidth}px`; photo.style.height = `${naturalHeight}px`;
      photo.hidden = false; status.hidden = true; ready = true;
      dialog.dataset.ready = 'true';
      $('dimensions').textContent = `${naturalWidth.toLocaleString()} × ${naturalHeight.toLocaleString()} px · Original resolution`;
      for (const name of ['fit', 'actual', 'zoom-in', 'zoom-out']) $(name).disabled = false;
      if (typeof onSave === 'function') $('save').disabled = false;
      fit();
    } catch (error) {
      if (closed) return;
      dialog.dataset.ready = 'error'; $('dimensions').textContent = 'Image unavailable';
      status.dataset.error = 'true'; status.hidden = false;
      status.textContent = error?.name === 'EncodingError' ? 'The original image could not be loaded. Go back to the result and try again.' : error?.message || 'The original image could not be loaded.';
    }
  }
  load();
  return controller;
}
