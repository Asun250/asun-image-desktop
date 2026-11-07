// Read clipboard image bytes without fetching URLs or executing pasted HTML.
export const SUPPORTED_IMAGE_TYPES = ['image/png','image/jpeg','image/webp'];
export const MAX_EMBEDDED_IMAGE_BYTES = 50 * 1024 * 1024;
export const MAX_CLIPBOARD_HTML_LENGTH = Math.ceil(MAX_EMBEDDED_IMAGE_BYTES * 4 / 3) + 1_000_000;
const extensions = { 'image/png':'png', 'image/jpeg':'jpg', 'image/webp':'webp' };
const supported = type => SUPPORTED_IMAGE_TYPES.includes(type);
const mime = type => typeof type === 'string' ? type.toLowerCase().split(';')[0].trim() : '';
const unsupportedMessage = 'The clipboard does not contain a PNG, JPEG, or WebP image. Use Copy image on a photo in your browser or ChatGPT, then paste here. A copied link is not an image.';
const emptyMessage = 'The clipboard is empty. Copy an image first.';

function fileMime(file) {
  const type = mime(file?.type);
  if (supported(type)) return type;
  // Some file clipboards omit MIME types; the image decoder verifies the bytes later.
  if (!type && typeof file?.name === 'string') {
    const extension = file.name.match(/\.(png|jpe?g|webp)$/i)?.[1].toLowerCase();
    if (extension) return extension === 'jpg' || extension === 'jpeg' ? 'image/jpeg' : `image/${extension}`;
  }
  return null;
}
function namedImage(blob, type, index) {
  const name = `Pasted image${index ? ' ' + (index + 1) : ''}.${extensions[type]}`;
  return new File([blob],name,{type,lastModified:Date.now()});
}
function binaryImages(dataTransfer) {
  // Files and file items represent the same clipboard payload. Prefer one complete
  // representation, preserving separate files even when their metadata is identical.
  const files = Array.from(dataTransfer.files || []).filter(file => fileMime(file));
  if (files.length) return files.map((file,index) => namedImage(file,fileMime(file),index));
  const images = [];
  for (const item of Array.from(dataTransfer.items || [])) {
    if (item.kind !== 'file' || typeof item.getAsFile !== 'function') continue;
    const file = item.getAsFile(), type = fileMime(file);
    if (file && type) images.push(namedImage(file,type,images.length));
  }
  return images;
}
function embeddedImage(source) {
  if (typeof source !== 'string') return null;
  const value = source.trim(), comma = value.indexOf(',');
  if (comma < 0 || comma > 40) return null;
  const header = value.slice(0,comma).toLowerCase();
  const type = /^data:(image\/(?:png|jpeg|webp));base64$/.exec(header)?.[1];
  if (!type) return null;
  const encoded = value.slice(comma + 1);
  // Check estimated decoded length before validating/decoding the base64 string.
  const padding = encoded.endsWith('==') ? 2 : encoded.endsWith('=') ? 1 : 0;
  const size = encoded.length * 3 / 4 - padding;
  if (size > MAX_EMBEDDED_IMAGE_BYTES) throw new Error('The embedded clipboard image exceeds 50 MB. Choose a smaller image.');
  if (!encoded.length || encoded.length % 4 || !/^[A-Za-z0-9+/]*={0,2}$/.test(encoded)) return null;
  let decoded;
  try { decoded = atob(encoded); } catch { return null; }
  const bytes = new Uint8Array(decoded.length);
  for (let index = 0; index < decoded.length; index++) bytes[index] = decoded.charCodeAt(index);
  return { blob:new Blob([bytes],{type}), type, key:`${type},${encoded}` };
}
function htmlImages(html) {
  if (!html) return [];
  if (html.length > MAX_CLIPBOARD_HTML_LENGTH) throw new Error('The clipboard HTML is too large. Copy the image itself, then paste here.');
  if (!globalThis.document?.createElement) return [];
  // Template contents are inert, including images/iframes/scripts. Nothing is attached
  // to the document, and only embedded data bytes are read from img attributes.
  const template = document.createElement('template');
  template.innerHTML = html;
  const images = [], seen = new Set();
  for (const image of template.content.querySelectorAll('img[src]')) {
    const decoded = embeddedImage(image.getAttribute('src'));
    if (!decoded || seen.has(decoded.key)) continue;
    seen.add(decoded.key);
    images.push(namedImage(decoded.blob,decoded.type,images.length));
  }
  return images;
}
export function clipboardImageFiles(dataTransfer) {
  if (!dataTransfer) throw new Error(emptyMessage);
  const files = binaryImages(dataTransfer);
  if (files.length) return files;
  const html = typeof dataTransfer.getData === 'function' ? dataTransfer.getData('text/html') : '';
  const embedded = htmlImages(html);
  if (embedded.length) return embedded;
  const hasContent = Boolean(html || dataTransfer.files?.length || dataTransfer.items?.length || (typeof dataTransfer.getData === 'function' && dataTransfer.getData('text/plain')));
  throw new Error(hasContent ? unsupportedMessage : emptyMessage);
}
export async function readClipboardImages(clipboard = globalThis.navigator?.clipboard) {
  if (typeof clipboard?.read !== 'function') throw new Error('This browser cannot read clipboard images. Copy the image, then press Ctrl+V in the Asun IMG area.');
  // Preserve permission/security errors so the UI can explain the browser's denial.
  const items = await clipboard.read();
  if (!items?.length) throw new Error(emptyMessage);
  const files = [];
  for (const item of items) {
    const types = Array.from(item.types || []);
    const best = SUPPORTED_IMAGE_TYPES.map(type => types.find(candidate => mime(candidate) === type)).find(Boolean);
    if (!best) continue;
    const blob = await item.getType(best), type = mime(blob.type) || mime(best);
    if (!supported(type)) continue;
    files.push(namedImage(blob,type,files.length));
  }
  if (!files.length) throw new Error(unsupportedMessage);
  return files;
}
