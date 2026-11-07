import {readFile} from 'node:fs/promises';
import sharp from 'sharp';

// Three intentionally simple colored shapes, generated without external files.
export async function syntheticScene() {
  const svg = '<svg xmlns="http://www.w3.org/2000/svg" width="640" height="480"><rect width="640" height="480" fill="#f2eadb"/><circle cx="150" cy="160" r="85" fill="#db3939" stroke="#202830" stroke-width="5"/><rect x="370" y="65" width="170" height="170" rx="12" fill="#267ccd" stroke="#202830" stroke-width="5"/><path d="M320 265L415 425H225Z" fill="#e2b42d" stroke="#202830" stroke-width="5"/></svg>';
  const bytes = await sharp(Buffer.from(svg)).png().toBuffer();
  return {bytes, width: 640, height: 480, source: `data:image/png;base64,${bytes.toString('base64')}`, fixture: 'Deterministic synthetic circle, square and triangle'};
}

export const gpuEnabled = process.env.ASUN_RUN_GPU_TESTS === '1';
export const gpuSkip = gpuEnabled ? false : 'Set ASUN_RUN_GPU_TESTS=1 to run real local GPU inference.';

export async function gpuFixture() {
  if (!process.env.ASUN_GPU_FIXTURE) return syntheticScene();
  let original;
  try { original = await readFile(process.env.ASUN_GPU_FIXTURE); }
  catch { throw new Error('ASUN_GPU_FIXTURE must name a readable PNG, JPEG or WebP image you choose for this manual test.'); }
  try {
    const {data: bytes, info} = await sharp(original).rotate().resize({width: 1024, height: 1024, fit: 'inside', withoutEnlargement: true}).png().toBuffer({resolveWithObject: true});
    if (info.width < 32 || info.height < 32) throw new Error('too small');
    return {bytes, width: info.width, height: info.height, source: `data:image/png;base64,${bytes.toString('base64')}`, fixture: 'Explicit ASUN_GPU_FIXTURE working image'};
  } catch { throw new Error('ASUN_GPU_FIXTURE must be a valid image at least 32 pixels per side. A bounded PNG working copy is used; the chosen file is not changed.'); }
}
