/* The startup presentation never changes project data or the supplied GIF. */
(() => {
  'use strict';
  const root = document.documentElement;
  let screen, image, skip, app, editorReady = false, finished = false, requested = '';
  let cycleTimer, loadTimer, safetyTimer;

  function finish() {
    if (finished || !screen || !editorReady) return;
    finished = true;
    clearTimeout(cycleTimer); clearTimeout(loadTimer); clearTimeout(safetyTimer);
    editorObserver.disconnect();
    screen.hidden = true;
    app.inert = false;
    app.removeAttribute('aria-hidden');
    root.dataset.startup = 'complete';
    root.dataset.startupReason = requested || 'startup-timeout';
    if (editorReady) root.dataset.ready = 'true';
    image.removeAttribute('src');
    const stage = document.getElementById('stage');
    if (editorReady && stage) stage.focus({ preventScroll: true });
  }

  function requestFinish(reason) {
    if (finished || requested) return;
    requested = reason;
    clearTimeout(cycleTimer); clearTimeout(loadTimer);
    if (skip) { skip.disabled = true; skip.textContent = 'Opening…'; }
    finish();
  }

  function trackEditorReady() {
    if (root.dataset.ready !== 'true' || finished) return;
    editorReady = true;
    root.dataset.ready = 'false';
    if (requested) finish();
  }
  // Preserve the editor's ready signal, exposing it once the presentation ends.
  const editorObserver = new MutationObserver(trackEditorReady);
  editorObserver.observe(root, { attributes: true, attributeFilter: ['data-ready'] });
  trackEditorReady();

  function blockStartupInput(event) {
    if (finished || root.dataset.startup !== 'playing') return;
    if (event.type === 'keydown' && event.key === 'Escape') {
      event.preventDefault(); event.stopImmediatePropagation(); requestFinish('skipped'); return;
    }
    if ((event.type === 'keydown' || event.type === 'keyup') && (event.key === 'Tab' || (event.target === skip && ['Enter', ' '].includes(event.key)))) {
      event.stopImmediatePropagation(); return;
    }
    event.preventDefault(); event.stopImmediatePropagation();
  }
  // The hidden editor must not import, annotate or change tools during startup.
  for (const type of ['keydown', 'keyup', 'paste', 'drop', 'dragover', 'wheel']) document.addEventListener(type, blockStartupInput, { capture: true, passive: false });

  function setup() {
    screen = document.getElementById('startupScreen');
    image = document.getElementById('startupAnimation');
    skip = document.getElementById('skipStartup');
    app = document.getElementById('app');
    if (!screen || !image || !skip || !app) {
      finished = true; editorObserver.disconnect(); root.dataset.startup = 'complete';
      if (app) { app.inert = false; app.removeAttribute('aria-hidden'); }
      if (editorReady) root.dataset.ready = 'true';
      return;
    }
    app.inert = true;
    skip.addEventListener('click', () => requestFinish('skipped'));
    image.addEventListener('load', () => {
      if (finished || requested) return;
      clearTimeout(loadTimer);
      // One full native cycle; retain the file's infinite-loop bytes unchanged.
      cycleTimer = setTimeout(() => requestFinish('played'), 6400);
    }, { once: true });
    image.addEventListener('error', () => requestFinish('asset-error'), { once: true });
    loadTimer = setTimeout(() => requestFinish('load-timeout'), 8000);
    safetyTimer = setTimeout(() => requestFinish('startup-timeout'), 16000);
    image.src = 'startup.gif';
    skip.focus({ preventScroll: true });
    trackEditorReady();
    if (requested) finish();
  }
  if (document.getElementById('startupScreen')) setup();
  else if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', setup, { once: true });
  else setup();
})();
