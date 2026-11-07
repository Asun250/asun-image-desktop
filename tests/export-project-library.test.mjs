import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {mkdtemp, mkdir, readFile, readdir, writeFile, rm} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {assertNoCredentials, exportProjectLibrary} from '../scripts/export-project-library.mjs';

const id = '11111111-2222-3333-4444-555555555555';
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
async function setup(t, options = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'asun-library-test-'));
  t.after(() => rm(root, {recursive: true, force: true}));
  const source = path.join(root, 'source'), out = path.join(root, 'export'), catalog = path.join(root, 'catalog');
  await mkdir(path.join(source, 'image-jobs'), {recursive: true});
  await mkdir(path.join(source, 'sheet-jobs'));
  await mkdir(path.join(source, 'generation-queue'));
  await writeFile(path.join(source, 'generation-queue', 'sequence.json'), '{"sequence":42}');
  const record = {id, status: 'completed', sourceName: 'Synthetic project', model: 'test-model', mode: 'image', ownerPid: 999, fingerprint: 'private-runtime-fingerprint', queueSequence: 42, queuedPayloadHash: 'private-runtime-hash', message: 'Runtime diagnostic should not be copied', createdAt: '2026-01-01T00:00:00Z', finishedAt: '2026-01-01T00:01:00Z', settings: {model: 'test-model', quality: 'high', size: '1024x1536', prompt: 'A synthetic fixture instruction.\nKeep its composition.', options: {model: 'test-model', quality: 'high'}, inputs: [{index: 0, role: 'current composition', name: 'fixture.png'}]}, returned: {size: '1024x1536'}, image: {width: 1024, height: 1536, extension: 'png'}, ...options.record};
  await writeFile(path.join(source, 'image-jobs', `${id}.json`), JSON.stringify(record));
  await writeFile(path.join(source, 'image-jobs', `${id}.claim`), 'runtime-only');
  await writeFile(path.join(source, 'image-jobs', `${id}.submitted`), 'runtime-only');
  const input = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 0, 17, 255]);
  const output = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 0, 99, 255]);
  const project = Buffer.from(JSON.stringify({format: 'synthetic-native-project', version: 1, prompt: 'Local editable fixture', assets: {}, layers: [], references: []}) + '\n');
  await writeFile(path.join(source, 'image-jobs', `${id}.input-0.png`), input);
  await writeFile(path.join(source, 'image-jobs', `${id}.png`), output);
  if (!options.noProject) await writeFile(path.join(source, 'image-jobs', `${id}.project.asun`), project);
  return {root, source, out, catalog, record, input, output, project};
}

test('library exports exact original bytes, prompts and hashes while removing operational fields', async t => {
  const env = await setup(t);
  const {manifest, catalog} = await exportProjectLibrary(env);
  assert.deepEqual(manifest.counts, {jobs: 1, sourceProjects: 1, inputImages: 1, outputImages: 1, prompts: 1});
  assert.equal(manifest.totalFiles, 5);
  assert.equal(catalog.missingPromptRecords, 0);
  const base = path.join(env.out, 'image-jobs', id);
  assert.deepEqual(await readFile(path.join(base, `${id}.input-0.png`)), env.input);
  assert.deepEqual(await readFile(path.join(base, `${id}.png`)), env.output);
  assert.deepEqual(await readFile(path.join(base, `${id}.project.asun`)), env.project);
  assert.equal(await readFile(path.join(base, 'prompt.txt'), 'utf8'), env.record.settings.prompt);
  assert.equal(await readFile(path.join(env.catalog, catalog.jobs[0].promptPath), 'utf8'), env.record.settings.prompt);
  const exported = JSON.parse(await readFile(path.join(base, 'record.json'), 'utf8'));
  assert.deepEqual(exported.settings, env.record.settings);
  assert.deepEqual(exported.returned, env.record.returned);
  for (const key of ['ownerPid', 'fingerprint', 'queueSequence', 'queuedPayloadHash', 'message']) assert.equal(Object.hasOwn(exported, key), false);
  assert.equal(manifest.files.some(file => /claim|submitted|generation-queue/.test(file.path)), false);
  for (const file of manifest.files) {
    const bytes = await readFile(path.join(env.out, file.path));
    assert.equal(bytes.length, file.bytes);
    assert.equal(hash(bytes), file.sha256);
  }
  assert.equal(hash(await readFile(path.join(env.out, 'manifest.json'))), catalog.manifestSha256);
  assert.equal(await readFile(path.join(env.source, 'image-jobs', `${id}.claim`), 'utf8'), 'runtime-only');
  assert.equal(JSON.parse(await readFile(path.join(env.source, 'image-jobs', `${id}.json`), 'utf8')).ownerPid, 999);
});

test('legacy jobs missing a prompt or source snapshot are labeled without inventing either', async t => {
  const env = await setup(t, {record: {settings: undefined}, noProject: true});
  const {manifest, catalog} = await exportProjectLibrary(env);
  assert.equal(manifest.counts.prompts, 0);
  assert.equal(manifest.counts.sourceProjects, 0);
  assert.equal(catalog.missingPromptRecords, 1);
  assert.equal(catalog.jobs[0].promptRecorded, false);
  assert.equal(Object.hasOwn(catalog.jobs[0], 'promptPath'), false);
  assert.equal((await readdir(path.join(env.out, 'image-jobs', id))).includes('prompt.txt'), false);
});

test('credentials reject export without revealing their matching values', async t => {
  const credential = 'sk-proj-' + 'aZ7qP2mN8xR4vL6cB9sT1dF5hJ3kW0yU';
  const env = await setup(t, {record: {settings: {prompt: `Synthetic fixture with ${credential}`}}});
  await assert.rejects(exportProjectLibrary(env), error => {
    assert.match(error.message, /Possible credential/);
    assert.equal(error.message.includes(credential), false);
    return true;
  });
  await assert.rejects(readFile(path.join(env.out, 'manifest.json')), {code: 'ENOENT'});
  assert.throws(() => assertNoCredentials({prompt: '-----BEGIN PRIVATE KEY-----'}), /Possible credential/);
  assert.throws(() => assertNoCredentials({note: 'Bearer ' + 'aZ7qP2mN8xR4vL6cB9sT1dF5hJ3kW0yU'}), /Possible credential/);
  assert.doesNotThrow(() => assertNoCredentials({prompt: 'sk-' + 'fake'.repeat(20)}));
  assert.doesNotThrow(() => assertNoCredentials({source: 'data:image/png;base64,' + Buffer.alloc(200, 12).toString('base64')}));
});

test('unfinished job statuses stop export before any complete snapshot is written', async t => {
  const env = await setup(t, {record: {status: 'generating'}});
  await assert.rejects(exportProjectLibrary(env), /unfinished/);
  await assert.rejects(readFile(path.join(env.out, 'manifest.json')), {code: 'ENOENT'});
});

test('output directories must be empty and may not overlap the source', async t => {
  const env = await setup(t);
  await mkdir(env.out);
  await writeFile(path.join(env.out, 'keep.txt'), 'existing export');
  await assert.rejects(exportProjectLibrary(env), /new or empty/);
  assert.equal(await readFile(path.join(env.out, 'keep.txt'), 'utf8'), 'existing export');
  await assert.rejects(exportProjectLibrary({...env, out: path.join(env.source, 'nested')}), /separate, non-overlapping/);
});
