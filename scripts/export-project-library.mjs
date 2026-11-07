import {createHash} from 'node:crypto';
import {lstat, mkdir, readFile, readdir, realpath, stat, writeFile} from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

const groups = ['image-jobs', 'sheet-jobs'];
const terminalStatuses = new Set(['completed', 'cancelled', 'failed']);
const jobName = /^([0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12})\.json$/i;
const recordFields = ['id', 'status', 'sourceName', 'views', 'model', 'mode', 'createdAt', 'queuedAt', 'startedAt', 'finishedAt', 'settings', 'returned', 'image', 'sourceProject', 'outputCheck'];
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const slash = value => value.split(path.sep).join('/');

function entropy(value) {
  const counts = new Map();
  for (const char of value) counts.set(char, (counts.get(char) || 0) + 1);
  let result = 0;
  for (const count of counts.values()) { const p = count / value.length; result -= p * Math.log2(p); }
  return {bits: result, unique: counts.size};
}

function highEntropy(value) {
  const detail = entropy(value);
  return value.length >= 24 && detail.unique >= 12 && detail.bits >= 3.5;
}

// Inspect text without ever including matching values in an error or log.
// Embedded image bytes in native projects are preserved and are not credentials.
export function assertNoCredentials(value, location = 'document') {
  const visit = (item, field = '') => {
    if (typeof item === 'string') {
      if (/^data:image\/[a-z0-9.+-]+;base64,[A-Za-z0-9+/=\s]+$/i.test(item)) return;
      let found = /-----BEGIN (?:RSA |EC |OPENSSH |DSA |ENCRYPTED )?PRIVATE KEY-----/.test(item);
      for (const match of item.matchAll(/\b(?:sk-(?:proj-|svcacct-)?|gh[pousr]_|github_pat_)([A-Za-z0-9_-]{24,})/g)) found ||= highEntropy(match[1]);
      for (const match of item.matchAll(/\bBearer\s+([A-Za-z0-9._~+-]{24,})/gi)) found ||= highEntropy(match[1]);
      if (/^(?:api[_-]?key|access[_-]?token|refresh[_-]?token|authorization|password|client[_-]?secret)$/i.test(field)) found ||= highEntropy(item);
      if (found) throw new Error(`Possible credential found in ${location}; export stopped. The matching value was not logged.`);
    } else if (Array.isArray(item)) item.forEach(entry => visit(entry));
    else if (item && typeof item === 'object') for (const [key, entry] of Object.entries(item)) visit(entry, key);
  };
  visit(value);
}

function identicalStat(left, right) {
  return ['dev', 'ino', 'size', 'mtimeNs', 'ctimeNs'].every(key => left[key] === right[key]);
}

async function stableRead(file) {
  const before = await lstat(file, {bigint: true});
  if (!before.isFile() || before.isSymbolicLink()) throw new Error('Export source must contain ordinary files, not links.');
  const bytes = await readFile(file);
  const after = await stat(file, {bigint: true});
  if (!identicalStat(before, after) || BigInt(bytes.length) !== after.size) throw new Error('A source file changed during export. Retry after the app is idle.');
  return {bytes, stats: after, digest: sha(bytes)};
}

async function emptyDestination(directory) {
  try {
    const info = await lstat(directory);
    if (!info.isDirectory() || info.isSymbolicLink() || (await readdir(directory)).length) throw new Error('Export destinations must be new or empty ordinary directories.');
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    await mkdir(directory, {recursive: true});
  }
}

function contains(parent, child) {
  const relative = path.relative(parent, child);
  return relative === '' || (!relative.startsWith('..' + path.sep) && relative !== '..' && !path.isAbsolute(relative));
}

async function inventory(source) {
  const result = [];
  for (const group of groups) {
    const directory = path.join(source, group);
    const info = await lstat(directory);
    if (!info.isDirectory() || info.isSymbolicLink()) throw new Error(`Invalid ${group} source directory.`);
    const entries = await readdir(directory, {withFileTypes: true});
    if (entries.some(entry => entry.isSymbolicLink())) throw new Error(`Links are not allowed in ${group}.`);
    const names = entries.filter(entry => entry.isFile()).map(entry => entry.name).sort();
    for (const name of names.filter(name => jobName.test(name))) {
      const id = name.match(jobName)[1];
      const match = new RegExp(`^${id}\\.(?:project\\.asun|(?:input-\\d+\\.)?(?:png|jpe?g|webp))$`, 'i');
      const assets = names.filter(name => match.test(name));
      const signatures = [];
      for (const selected of [name, ...assets]) {
        const info = await lstat(path.join(directory, selected), {bigint: true});
        if (!info.isFile() || info.isSymbolicLink()) throw new Error(`Invalid source file in ${group}.`);
        signatures.push({name: selected, ...Object.fromEntries(['dev', 'ino', 'size', 'mtimeNs', 'ctimeNs'].map(key => [key, String(info[key])]))});
      }
      result.push({group, id, recordName: name, assets, signatures});
    }
  }
  return result;
}

export async function exportProjectLibrary({source, out, catalog: catalogDirectory}) {
  if (!source || !out || !catalogDirectory) throw new Error('Source, output and catalog directories are required.');
  source = await realpath(source);
  out = path.resolve(out);
  catalogDirectory = path.resolve(catalogDirectory);
  if ([out, catalogDirectory].some(destination => contains(source, destination) || contains(destination, source)) || contains(out, catalogDirectory) || contains(catalogDirectory, out)) {
    throw new Error('Source, archive staging and catalog directories must be separate, non-overlapping locations.');
  }
  const jobs = await inventory(source);
  if (!jobs.length) throw new Error('No stored image or sheet jobs were found.');
  const observations = [];
  for (const job of jobs) {
    const filename = path.join(source, job.group, job.recordName);
    const observation = await stableRead(filename);
    let record;
    try { record = JSON.parse(observation.bytes.toString('utf8')); } catch { throw new Error(`Invalid JSON record for ${job.id}.`); }
    if (record.id !== job.id || !terminalStatuses.has(record.status)) throw new Error(`Job ${job.id} is unfinished or has inconsistent identity. Wait until generation is idle.`);
    assertNoCredentials(record, `job ${job.id}`);
    job.record = Object.fromEntries(recordFields.filter(field => Object.hasOwn(record, field)).map(field => [field, record[field]]));
    observations.push({filename, stats: observation.stats, digest: observation.digest});
  }
  await emptyDestination(out);
  await emptyDestination(catalogDirectory);
  const manifest = {format: 'asun-project-library', version: 1, exportedAt: new Date().toISOString(), counts: {jobs: jobs.length, sourceProjects: 0, inputImages: 0, outputImages: 0, prompts: 0}, files: []};
  const catalog = {format: 'asun-project-library-catalog', version: 1, exportedAt: manifest.exportedAt, jobs: []};
  const save = async (relative, bytes, detail) => {
    const destination = path.join(out, relative);
    await mkdir(path.dirname(destination), {recursive: true});
    await writeFile(destination, bytes, {flag: 'wx'});
    const copied = await readFile(destination);
    if (sha(copied) !== sha(bytes)) throw new Error('Export copy checksum did not match.');
    manifest.files.push({path: slash(relative), bytes: bytes.length, sha256: sha(bytes), ...detail});
  };
  for (const job of jobs) {
    const directory = path.join(job.group, job.id);
    const entry = {...job.record, kind: job.group === 'image-jobs' ? 'image' : 'sheet', recordPath: slash(path.join(directory, 'record.json')), files: [], promptRecorded: typeof job.record.settings?.prompt === 'string'};
    await save(path.join(directory, 'record.json'), Buffer.from(JSON.stringify(job.record, null, 2) + '\n'), {kind: 'job-record', jobId: job.id});
    for (const name of job.assets) {
      const filename = path.join(source, job.group, name);
      const observation = await stableRead(filename);
      const kind = name.endsWith('.asun') ? 'source-project' : name.includes('.input-') ? 'input-image' : 'generated-image';
      if (kind === 'source-project') {
        let project;
        try { project = JSON.parse(observation.bytes.toString('utf8')); } catch { throw new Error(`Invalid editable project for ${job.id}.`); }
        assertNoCredentials(project, `editable project ${job.id}`);
      }
      observations.push({filename, stats: observation.stats, digest: observation.digest});
      await save(path.join(directory, name), observation.bytes, {kind, jobId: job.id});
      entry.files.push({path: slash(path.join(directory, name)), kind, bytes: observation.bytes.length, sha256: observation.digest});
      manifest.counts[kind === 'source-project' ? 'sourceProjects' : kind === 'input-image' ? 'inputImages' : 'outputImages']++;
    }
    if (entry.promptRecorded) {
      const prompt = Buffer.from(job.record.settings.prompt, 'utf8');
      await save(path.join(directory, 'prompt.txt'), prompt, {kind: 'prompt', jobId: job.id});
      const catalogPrompt = slash(path.join('prompts', `${entry.kind}-${job.id}.txt`));
      await mkdir(path.join(catalogDirectory, 'prompts'), {recursive: true});
      await writeFile(path.join(catalogDirectory, catalogPrompt), prompt, {flag: 'wx'});
      entry.promptPath = catalogPrompt;
      manifest.counts.prompts++;
    }
    catalog.jobs.push(entry);
  }
  if (JSON.stringify(await inventory(source)) !== JSON.stringify(jobs.map(({record, ...job}) => job))) throw new Error('The stored job inventory changed during export. Retry after the app is idle.');
  // Re-read every selected source at the end, including completed job records.
  // A matching size alone cannot establish an immutable snapshot.
  for (const expected of observations) {
    const current = await stableRead(expected.filename);
    if (!identicalStat(expected.stats, current.stats) || expected.digest !== current.digest) throw new Error('A source file changed during export. No complete manifest was written.');
  }
  manifest.totalFiles = manifest.files.length;
  manifest.totalBytes = manifest.files.reduce((sum, file) => sum + file.bytes, 0);
  catalog.counts = manifest.counts;
  catalog.missingPromptRecords = catalog.jobs.filter(job => !job.promptRecorded).length;
  const manifestBytes = Buffer.from(JSON.stringify(manifest, null, 2) + '\n');
  await writeFile(path.join(out, 'manifest.json'), manifestBytes, {flag: 'wx'});
  catalog.manifestSha256 = sha(manifestBytes);
  await writeFile(path.join(catalogDirectory, 'catalog.json'), JSON.stringify(catalog, null, 2) + '\n', {flag: 'wx'});
  await writeFile(path.join(catalogDirectory, 'manifest.json'), manifestBytes, {flag: 'wx'});
  return {manifest, catalog};
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const args = process.argv.slice(2), options = {};
    for (let i = 0; i < args.length; i += 2) {
      const key = args[i]?.replace(/^--/, '');
      if (!['source', 'out', 'catalog'].includes(key) || !args[i + 1] || options[key]) throw new Error('Usage: node scripts/export-project-library.mjs --source DATA_DIRECTORY --out EMPTY_ARCHIVE_STAGING --catalog EMPTY_CATALOG_DIRECTORY');
      options[key] = args[i + 1];
    }
    const {manifest, catalog} = await exportProjectLibrary(options);
    console.log(JSON.stringify({counts: manifest.counts, files: manifest.totalFiles, bytes: manifest.totalBytes, missingPromptRecords: catalog.missingPromptRecords, manifestSha256: catalog.manifestSha256}));
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
