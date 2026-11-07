/* Appearance preferences belong to this computer, never to the image project. */
(() => {
  'use strict';
  const preferenceKey = 'asun-image-appearance';
  const root = document.documentElement;
  const validTheme = value => value === 'dark' ? 'dark' : 'light';
  let theme = 'light';
  try { theme = validTheme(localStorage.getItem(preferenceKey)); } catch { /* Storage may be disabled. */ }

  function applyTheme(value, remember = false) {
    theme = validTheme(value);
    root.dataset.theme = theme;
    root.style.colorScheme = theme;
    if (remember) {
      try { localStorage.setItem(preferenceKey, theme); } catch { /* The live switch still works. */ }
    }
    const toggle = document.getElementById('themeToggle');
    if (!toggle) return;
    const next = theme === 'dark' ? 'light' : 'dark';
    toggle.setAttribute('aria-pressed', String(theme === 'dark'));
    toggle.setAttribute('aria-label', `Switch to ${next} mode`);
    toggle.title = `Switch to ${next} mode`;
    toggle.querySelector('.theme-label').textContent = theme === 'dark' ? 'Dark' : 'Light';
    toggle.querySelector('.theme-icon use').setAttribute('href', `#ui-${theme === 'dark' ? 'moon' : 'sun'}`);
  }

  // This classic script runs ahead of the styles, so reopening dark mode has no light flash.
  applyTheme(theme);

  function setup() {
    const themeToggle = document.getElementById('themeToggle');
    applyTheme(theme);
    themeToggle.addEventListener('click', () => applyTheme(theme === 'dark' ? 'light' : 'dark', true));
    window.addEventListener('storage', event => {
      if (event.key === preferenceKey) applyTheme(event.newValue);
    });

    const inspector = document.querySelector('.panels');
    const layersTab = document.getElementById('showLayers');
    const propertiesTab = document.getElementById('showProperties');
    const layersPane = document.getElementById('layersPane');
    const propertiesPane = document.getElementById('transformPanel');
    const tabs = [layersTab, propertiesTab];

    function chooseInspector(value, focus = false) {
      const selected = value === 'properties' && !propertiesPane.hidden ? 'properties' : 'layers';
      inspector.dataset.inspector = selected;
      if (selected === 'properties') propertiesPane.open = true;
      for (const tab of tabs) {
        const active = tab === (selected === 'properties' ? propertiesTab : layersTab);
        tab.setAttribute('aria-selected', String(active));
        tab.tabIndex = active ? 0 : -1;
      }
      layersPane.setAttribute('aria-hidden', String(selected !== 'layers'));
      propertiesPane.setAttribute('aria-hidden', String(selected !== 'properties' || propertiesPane.hidden));
      if (focus) (selected === 'properties' ? propertiesTab : layersTab).focus();
    }

    function syncSelection() {
      const lostFocus = propertiesPane.hidden && document.activeElement === propertiesTab;
      propertiesTab.disabled = propertiesPane.hidden;
      chooseInspector(inspector.dataset.inspector, lostFocus);
    }
    for (const tab of tabs) {
      tab.addEventListener('click', () => chooseInspector(tab === propertiesTab ? 'properties' : 'layers'));
      tab.addEventListener('keydown', event => {
        if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
        event.preventDefault();
        event.stopPropagation();
        const available = tabs.filter(button => !button.disabled);
        let index = available.indexOf(tab);
        if (event.key === 'Home') index = 0;
        else if (event.key === 'End') index = available.length - 1;
        else index = (index + (event.key === 'ArrowRight' ? 1 : -1) + available.length) % available.length;
        chooseInspector(available[index] === propertiesTab ? 'properties' : 'layers', true);
      });
    }
    new MutationObserver(syncSelection).observe(propertiesPane, { attributes: true, attributeFilter: ['hidden'] });
    syncSelection();

    const historyToggle = document.getElementById('toggleHistory');
    const historyList = document.getElementById('historyList');
    const historyPanel = historyToggle.closest('.history-panel');
    historyToggle.addEventListener('click', () => {
      historyList.hidden = !historyList.hidden;
      historyPanel.classList.toggle('is-collapsed', historyList.hidden);
      historyToggle.setAttribute('aria-expanded', String(!historyList.hidden));
      historyToggle.setAttribute('aria-label', historyList.hidden ? 'Expand history' : 'Collapse history');
      historyToggle.title = historyList.hidden ? 'Expand history' : 'Collapse history';
    });

    // The reference sheet can scroll on shorter screens. Choosing an annotation
    // tool brings the full working area above its sticky Save footer.
    document.getElementById('referenceEditorHost').addEventListener('click', event => {
      if (!event.target.closest('[data-ref-tool]')) return;
      const stage = document.getElementById('refCanvasStage');
      if (document.getElementById('referenceDialog').open && stage && !stage.hidden) {
        stage.scrollIntoView({ block: 'nearest', inline: 'nearest' });
      }
    });

    // Native button activation must not pan or nudge the editor's selected layer.
    for (const button of [themeToggle, historyToggle, ...tabs]) {
      for (const type of ['keydown', 'keyup']) button.addEventListener(type, event => {
        if (event.code === 'Space' || event.key === 'Enter') event.stopPropagation();
      });
    }
    root.dataset.appearanceReady = 'true';
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', setup, { once: true });
  else setup();
})();
