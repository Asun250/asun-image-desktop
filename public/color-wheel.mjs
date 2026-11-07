const clamp = (value, low, high) => Math.min(high, Math.max(low, value));

export function normalizeHex(value) {
  const match = String(value).trim().match(/^#?([\da-f]{6})$/i);
  return match ? `#${match[1].toUpperCase()}` : null;
}

// Hue is measured in degrees; saturation and value are between zero and one.
export function hexToHsv(hex) {
  const normalized = normalizeHex(hex);
  if (!normalized) throw new TypeError('Expected a six-digit HEX color.');
  const channels = [1, 3, 5].map(index => parseInt(normalized.slice(index, index + 2), 16) / 255);
  const [red, green, blue] = channels;
  const value = Math.max(...channels);
  const minimum = Math.min(...channels);
  const delta = value - minimum;
  let hue = 0;
  if (delta) {
    if (value === red) hue = 60 * (((green - blue) / delta) % 6);
    else if (value === green) hue = 60 * ((blue - red) / delta + 2);
    else hue = 60 * ((red - green) / delta + 4);
  }
  return {h: (hue + 360) % 360, s: value ? delta / value : 0, v: value};
}

function hsvToRgb(h, s, v) {
  const hue = ((h % 360) + 360) % 360 / 60;
  const saturation = clamp(s, 0, 1);
  const value = clamp(v, 0, 1);
  const chroma = value * saturation;
  const secondary = chroma * (1 - Math.abs(hue % 2 - 1));
  const base = value - chroma;
  const segments = [
    [chroma, secondary, 0], [secondary, chroma, 0], [0, chroma, secondary],
    [0, secondary, chroma], [secondary, 0, chroma], [chroma, 0, secondary],
  ];
  return segments[Math.floor(hue)].map(channel => Math.round((channel + base) * 255));
}

export function hsvToHex(h, s, v) {
  return `#${hsvToRgb(h, s, v).map(channel => channel.toString(16).padStart(2, '0')).join('').toUpperCase()}`;
}

export function wheelPointToHsv(x, y, center = 120, radius = 114) {
  const dx = x - center;
  const dy = y - center;
  return {h: (Math.atan2(dy, dx) * 180 / Math.PI + 360) % 360, s: clamp(Math.hypot(dx, dy) / radius, 0, 1)};
}

export function createColorWheel(dialog, {onApply, onPreview, onCancel, idPrefix = ''} = {}) {
  if (!dialog || typeof dialog.showModal !== 'function') throw new TypeError('A native dialog element is required.');
  if(typeof idPrefix!=='string'||!/^[A-Za-z0-9_-]*$/.test(idPrefix))throw new TypeError('Use a valid color-wheel ID prefix.');
  dialog.classList.add('color-wheel-dialog');
  dialog.innerHTML = `
    <div class="color-picker-body">
      <div class="dialog-heading"><h2 id="colorPickerTitle">Choose number color</h2><button type="button" id="closeColorPicker" aria-label="Cancel color selection">×</button></div>
      <p id="colorWheelHelp" class="color-picker-help">Choose a color on the wheel, then adjust brightness. Arrow keys change hue; Shift + arrows change saturation.</p>
      <div class="color-picker-wheel"><canvas id="colorWheelCanvas" width="240" height="240" tabindex="0" role="img" aria-label="Color wheel" aria-describedby="colorWheelHelp"></canvas></div>
      <div class="color-picker-sliders">
        <label for="colorHue">Hue <input id="colorHue" type="range" min="0" max="359" step="1"><output id="colorHueValue" for="colorHue"></output></label>
        <label for="colorSaturation">Saturation <input id="colorSaturation" type="range" min="0" max="100" step="1"><output id="colorSaturationValue" for="colorSaturation"></output></label>
        <label for="colorBrightness">Brightness <input id="colorBrightness" type="range" min="0" max="100" step="1"><output id="colorBrightnessValue" for="colorBrightness"></output></label>
      </div>
      <div class="color-picker-color"><div id="colorPreview" aria-label="Selected color"></div><label for="colorHex">HEX <input id="colorHex" type="text" maxlength="7" spellcheck="false" autocomplete="off" aria-describedby="colorHexError" placeholder="#FF8800"></label></div>
      <p id="colorHexError" class="color-picker-error" role="alert" hidden>Enter six HEX digits, for example #FF8800.</p>
      <div class="color-picker-swatches" aria-label="Common colors"></div>
      <div class="dialog-actions"><button type="button" id="cancelColor" class="quiet">Cancel</button><button type="button" id="applyColor" class="primary">Apply color</button></div>
    </div>`;

  if(idPrefix){
    const ids=new Set([...dialog.querySelectorAll('[id]')].map(element=>element.id));
    for(const element of dialog.querySelectorAll('[id]'))element.id=idPrefix+element.id;
    for(const element of dialog.querySelectorAll('[for],[aria-describedby],[aria-labelledby]')){
      for(const attribute of ['for','aria-describedby','aria-labelledby'])if(element.hasAttribute(attribute))element.setAttribute(attribute,element.getAttribute(attribute).split(/\s+/).map(id=>ids.has(id)?idPrefix+id:id).join(' '));
    }
  }
  const find = id => dialog.querySelector(`#${CSS.escape(idPrefix+id)}`);
  const canvas = find('colorWheelCanvas');
  const context = canvas.getContext('2d');
  const hue = find('colorHue');
  const saturation = find('colorSaturation');
  const brightness = find('colorBrightness');
  const hexInput = find('colorHex');
  const hexError = find('colorHexError');
  const preview = find('colorPreview');
  const applyButton = find('applyColor');
  const swatches = dialog.querySelector('.color-picker-swatches');
  let state = hexToHsv('#F28A31');
  let initialHex = '#F28A31';
  let active = false;
  let pointerId = null;
  let lastWheelValue = null;
  let wheelImage;

  const commonColors = [
    ['Orange', '#F28A31'], ['Red', '#F44336'], ['Yellow', '#FFEB3B'],
    ['Green', '#43A047'], ['Cyan', '#00BCD4'], ['Blue', '#2196F3'],
    ['Purple', '#9C27B0'], ['Pink', '#E91E63'], ['White', '#FFFFFF'], ['Black', '#000000'],
  ];
  for (const [name, color] of commonColors) {
    const button = document.createElement('button');
    button.type = 'button';
    button.dataset.color = color;
    button.style.backgroundColor = color;
    button.title = name;
    button.setAttribute('aria-label', `${name}, ${color}`);
    button.addEventListener('click', () => setHex(color));
    swatches.append(button);
  }

  function drawWheel() {
    // Reuse the full wheel until brightness changes; marker movement stays cheap.
    if (lastWheelValue !== state.v) {
      wheelImage = context.createImageData(240, 240);
      const pixels = wheelImage.data;
      for (let y = 0; y < 240; y++) {
        for (let x = 0; x < 240; x++) {
          const distance = Math.hypot(x + .5 - 120, y + .5 - 120);
          if (distance > 114.5) continue;
          const point = wheelPointToHsv(x + .5, y + .5);
          const color = hsvToRgb(point.h, point.s, state.v);
          const offset = (y * 240 + x) * 4;
          pixels[offset] = color[0]; pixels[offset + 1] = color[1]; pixels[offset + 2] = color[2];
          pixels[offset + 3] = Math.round(clamp(114.5 - distance, 0, 1) * 255);
        }
      }
      lastWheelValue = state.v;
    }
    context.putImageData(wheelImage, 0, 0);
    const radians = state.h * Math.PI / 180;
    const x = 120 + Math.cos(radians) * state.s * 114;
    const y = 120 + Math.sin(radians) * state.s * 114;
    context.beginPath(); context.arc(x, y, 6, 0, Math.PI * 2);
    context.strokeStyle = '#000'; context.lineWidth = 4; context.stroke();
    context.strokeStyle = '#FFF'; context.lineWidth = 2; context.stroke();
  }

  function validateHex() {
    const valid = normalizeHex(hexInput.value);
    hexError.hidden = Boolean(valid);
    hexInput.setAttribute('aria-invalid', String(!valid));
    applyButton.disabled = !valid;
    return valid;
  }

  function render(notify = true, updateHex = true) {
    const hex = hsvToHex(state.h, state.s, state.v);
    hue.value = String(Math.round(state.h) % 360);
    saturation.value = String(Math.round(state.s * 100));
    brightness.value = String(Math.round(state.v * 100));
    find('colorHueValue').textContent = `${Math.round(state.h) % 360}°`;
    find('colorSaturationValue').textContent = `${Math.round(state.s * 100)}%`;
    find('colorBrightnessValue').textContent = `${Math.round(state.v * 100)}%`;
    brightness.style.setProperty('--brightness-color', hsvToHex(state.h, state.s, 1));
    saturation.style.setProperty('--saturation-color', hsvToHex(state.h, 1, state.v));
    saturation.style.setProperty('--saturation-base', hsvToHex(state.h, 0, state.v));
    preview.style.backgroundColor = hex;
    preview.setAttribute('aria-label', `Selected color ${hex}`);
    canvas.setAttribute('aria-label', `Color wheel: hue ${Math.round(state.h)} degrees, saturation ${Math.round(state.s * 100)} percent`);
    for (const button of swatches.children) button.setAttribute('aria-pressed', String(button.dataset.color === hex));
    if (updateHex) { hexInput.value = hex; validateHex(); }
    drawWheel();
    if (notify && active) onPreview?.(hex);
    return hex;
  }

  function setHex(hex) {
    state = hexToHsv(hex);
    render();
  }

  function cancel() {
    if (!active) return;
    active = false;
    pointerId = null;
    if (dialog.open) dialog.close('cancel');
    onCancel?.(initialHex);
  }

  function apply() {
    const hex = validateHex();
    if (!hex) { hexInput.focus(); return; }
    active = false;
    pointerId = null;
    if (dialog.open) dialog.close('apply');
    onApply?.(hex);
  }

  function pick(event) {
    const bounds = canvas.getBoundingClientRect();
    if (!bounds.width || !bounds.height) return;
    const point = wheelPointToHsv((event.clientX - bounds.left) * canvas.width / bounds.width, (event.clientY - bounds.top) * canvas.height / bounds.height);
    // Keep hue while selecting the exact center so raising saturation feels stable.
    if (point.s > .001) state.h = point.h;
    state.s = point.s;
    render();
  }

  canvas.addEventListener('pointerdown', event => {
    if (event.button !== 0 || pointerId !== null) return;
    event.preventDefault();
    pointerId = event.pointerId;
    canvas.setPointerCapture(pointerId);
    canvas.focus();
    pick(event);
  });
  canvas.addEventListener('pointermove', event => {
    if (event.pointerId === pointerId) pick(event);
  });
  const endPointer = event => {
    if (event.pointerId !== pointerId) return;
    const endedPointer = pointerId;
    pointerId = null;
    if (canvas.hasPointerCapture(endedPointer)) canvas.releasePointerCapture(endedPointer);
  };
  canvas.addEventListener('pointerup', endPointer);
  canvas.addEventListener('pointercancel', endPointer);
  canvas.addEventListener('lostpointercapture', () => { pointerId = null; });
  canvas.addEventListener('keydown', event => {
    if (!['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(event.key)) return;
    event.preventDefault();
    const direction = ['ArrowRight', 'ArrowUp'].includes(event.key) ? 1 : -1;
    if (event.shiftKey) state.s = clamp(state.s + direction / 100, 0, 1);
    else state.h = (state.h + direction + 360) % 360;
    render();
  });
  hue.addEventListener('input', () => { state.h = Number(hue.value); render(); });
  saturation.addEventListener('input', () => { state.s = Number(saturation.value) / 100; render(); });
  brightness.addEventListener('input', () => { state.v = Number(brightness.value) / 100; render(); });
  hexInput.addEventListener('input', () => {
    const hex = validateHex();
    if (hex) { state = hexToHsv(hex); render(true, false); }
  });
  hexInput.addEventListener('blur', () => {
    const hex = validateHex();
    if (hex) hexInput.value = hex;
  });
  applyButton.addEventListener('click', apply);
  find('cancelColor').addEventListener('click', cancel);
  find('closeColorPicker').addEventListener('click', cancel);
  dialog.addEventListener('cancel', event => { event.preventDefault(); event.stopPropagation(); cancel(); });
  dialog.addEventListener('close', () => { if (active) cancel(); });
  dialog.addEventListener('keydown', event => {
    event.stopPropagation();
    // Native buttons must keep their own Enter action, including Cancel and swatches.
    if (event.key === 'Enter' && event.target.tagName !== 'BUTTON') { event.preventDefault(); apply(); }
    if (event.key === 'Escape') { event.preventDefault(); cancel(); }
  });
  for (const name of ['keyup', 'pointerdown', 'pointermove', 'pointerup', 'click']) {
    dialog.addEventListener(name, event => event.stopPropagation());
  }

  return {
    open(color, {title = 'Choose number color'} = {}) {
      if (active) cancel();
      initialHex = normalizeHex(color) || '#F28A31';
      state = hexToHsv(initialHex);
      find('colorPickerTitle').textContent = title;
      active = true;
      render(false);
      dialog.showModal();
      canvas.focus();
    },
    close: cancel,
  };
}
