import {spawn} from 'node:child_process';
import {randomBytes} from 'node:crypto';
import {access, readFile} from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

const appRoot = fileURLToPath(new URL('.', import.meta.url));
const defaultRoot = path.join(appRoot, 'local-ai', 'sam2');
const activeWorkers = new Set();
process.once('exit', () => { for (const child of activeWorkers) child.kill(); });
export const MAX_DETECTION_BODY = 15 * 1024 * 1024;
export function validateDetectionInput(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid detection request.');
  const {source,width,height} = value;
  if (!Number.isInteger(width) || !Number.isInteger(height) || width < 1 || height < 1 || width > 1600 || height > 1600) throw new Error('Detection image must be at most 1600 pixels per side.');
  if (typeof source !== 'string' || source.length > MAX_DETECTION_BODY || !/^data:image\/(png|jpeg|webp);base64,[A-Za-z0-9+/]+={0,2}$/.test(source)) throw new Error('Detection accepts an embedded PNG, JPEG or WebP image only.');
  const encoded = source.slice(source.indexOf(',') + 1);
  if (encoded.length % 4 || Buffer.from(encoded,'base64').length > 10 * 1024 * 1024) throw new Error('Detection working image is too large or invalid.');
  const result = {source,width,height};
  if (Object.hasOwn(value,'prompt')) {
    const prompt = value.prompt;
    if (!prompt || typeof prompt !== 'object' || Array.isArray(prompt) || Object.keys(prompt).length !== 1 || !Object.hasOwn(prompt,'box')) throw new Error('Guided detection requires one bounding box.');
    const box = prompt.box;
    if (!Array.isArray(box) || box.length !== 4 || !box.every(coordinate => typeof coordinate === 'number' && Number.isFinite(coordinate)) || box[0] < 0 || box[1] < 0 || box[2] > width || box[3] > height || box[2] <= box[0] || box[3] <= box[1]) throw new Error('The detection box must lie inside the working image and have a positive size.');
    result.prompt = {box:[...box]};
  }
  return result;
}

export function createLocalDetection({runtimeRoot = process.env.ASUN_SAM_ROOT?.trim() ? path.resolve(appRoot, process.env.ASUN_SAM_ROOT.trim()) : defaultRoot, timeoutMs = 180000, idleMs = 180000, spawnWorker = spawn} = {}) {
  const token = randomBytes(32).toString('hex');
  const python = path.join(runtimeRoot, 'env', 'Scripts', 'python.exe');
  let child = null, pending = null, idleTimer = null, output = '', diagnostics = '', sequence = 0, disposed = false;
  const fail = (error) => {
    if (pending) { clearTimeout(pending.timer); const reject = pending.reject; pending = null; reject(error); }
  };
  const stop = () => {
    clearTimeout(idleTimer);
    const running = child; child = null; output = '';
    if (running) { activeWorkers.delete(running); running.kill(); }
  };
  const status = async () => {
    try {
      const manifest = JSON.parse(await readFile(path.join(runtimeRoot,'runtime.json'),'utf8'));
      if (manifest.status !== 'installed') throw new Error('Local SAM 2 installation is incomplete.');
      await Promise.all([access(python), access(path.join(runtimeRoot,'checkpoints','sam2.1_hiera_base_plus.pt')), access(path.join(runtimeRoot,'source','sam2','build_sam.py'))]);
      return {available:true, model:'Meta SAM 2.1 Base Plus', localOnly:true, busy:!!pending, token};
    } catch {
      return {available:false, model:'Meta SAM 2.1 Base Plus', localOnly:true, busy:false, message:'Local SAM 2 is unavailable. Its app-owned runtime or model is missing.', token};
    }
  };
  const start = () => {
    if (child) return;
    output = ''; diagnostics = '';
    const running = spawnWorker(python, ['-u', path.join(appRoot,'local-sam-worker.py'), runtimeRoot], {
      cwd:runtimeRoot, windowsHide:true, stdio:['pipe','pipe','pipe'],
      env:{...process.env, PYTHONUTF8:'1', PYTHONNOUSERSITE:'1', HF_HUB_OFFLINE:'1', TRANSFORMERS_OFFLINE:'1'}
    });
    child = running; activeWorkers.add(running);
    running.stderr.on('data', data => { diagnostics = (diagnostics + data.toString()).slice(-3000); });
    running.stdout.on('data', data => {
      if (child !== running) return;
      output += data.toString();
      if (output.length > 50 * 1024 * 1024) { fail(new Error('Local detection returned too much data.')); stop(); return; }
      let newline;
      while ((newline = output.indexOf('\n')) >= 0) {
        const line = output.slice(0,newline); output = output.slice(newline + 1);
        let message;
        try { message = JSON.parse(line); } catch { fail(new Error('Local detection returned an invalid response.')); stop(); return; }
        if (!pending || message.id !== pending.id) continue;
        clearTimeout(pending.timer);
        const {resolve,reject} = pending; pending = null;
        if (message.error) reject(new Error(message.error)); else resolve(message.result);
        idleTimer = setTimeout(stop,idleMs); idleTimer.unref();
      }
    });
    running.on('error', error => { if (child === running) { fail(new Error(`Local detection could not start: ${error.message}`)); stop(); } });
    running.on('exit', code => {
      activeWorkers.delete(running);
      if (child !== running) return;
      child = null; output = '';
      fail(new Error(`Local detection stopped${code ? ` (${code})` : ''}. ${diagnostics.slice(-500) || 'Try again.'}`));
    });
    running.stdin.on('error', error => { if (child === running) { fail(new Error(`Local detection connection failed: ${error.message}`)); stop(); } });
  };
  const detect = async (input) => {
    const value = validateDetectionInput(input);
    if (disposed) throw new Error('Local detection is closed.');
    if (pending) { const error = new Error('Local detection is already running. Wait for it to finish.'); error.statusCode = 409; throw error; }
    if (!(await status()).available) { const error = new Error('Local SAM 2 is unavailable. Its app-owned runtime or model is missing.'); error.statusCode = 503; throw error; }
    if (disposed) throw new Error('Local detection is closed.');
    // An awaited availability check can overlap another call.
    if (pending) { const error = new Error('Local detection is already running. Wait for it to finish.'); error.statusCode = 409; throw error; }
    clearTimeout(idleTimer);
    return new Promise((resolve,reject) => {
      const id = ++sequence;
      const timer = setTimeout(() => { fail(new Error('Local detection took too long. Try a smaller image or close other GPU applications.')); stop(); }, timeoutMs);
      timer.unref();
      pending = {id,resolve,reject,timer};
      try { start(); child.stdin.write(JSON.stringify({id,...value}) + '\n'); }
      catch (error) { fail(error); stop(); }
    });
  };
  return {token,status,detect,dispose() { disposed = true; fail(new Error('Local detection is closed.')); stop(); }};
}

export async function readDetectionBody(request) {
  const length = Number(request.headers['content-length']);
  if (Number.isFinite(length) && length > MAX_DETECTION_BODY) { const error = new Error('Detection request is too large.'); error.statusCode = 413; throw error; }
  const parts = []; let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > MAX_DETECTION_BODY) { const error = new Error('Detection request is too large.'); error.statusCode = 413; throw error; }
    parts.push(chunk);
  }
  try { return validateDetectionInput(JSON.parse(Buffer.concat(parts).toString('utf8'))); }
  catch (error) { error.statusCode = 400; throw error; }
}
