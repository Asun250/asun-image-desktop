import {execFileSync} from 'node:child_process';
import path from 'node:path';

// Inspect the staged index. The owner authorizes app images, prompts and projects;
// credentials and raw runtime/account records remain excluded.
const files = execFileSync('git', ['ls-files', '-z'], {encoding: 'utf8'}).split('\0').filter(Boolean);
const extensions = new Set(['.mjs', '.js', '.css', '.html', '.py', '.ps1', '.cs', '.json', '.md', '.txt', '.png', '.jpg', '.jpeg', '.webp', '.gif', '.ico', '.svg', '.asun', '.zip']);
const exact = new Set(['.gitignore', '.gitattributes', 'scripts/sam2-requirements.txt', '.githooks/pre-commit']);
const privateDirectory = /(^|\/)(?:data|logs|qa|backups|node_modules|local-ai|release-build|\.venv|venv)(\/|$)/i;
const privateName = /(^|\/)(?:\.env(?:\..*)?|credentials[^/]*|secrets[^/]*|RELEASE\.json|pre-activation-[^/]*)$/i;
const forbidden = files.filter(file => privateDirectory.test(file) || privateName.test(file) || (!exact.has(file) && !extensions.has(path.posix.extname(file).toLowerCase())));
const sizes = files.length ? execFileSync('git', ['cat-file', '--batch-check=%(objectsize)'], {input: files.map(file => ':' + file).join('\n') + '\n', encoding: 'utf8'}).trim().split('\n') : [];
for (const [index, file] of files.entries()) {
  if (forbidden.includes(file)) continue;
  const size = Number(sizes[index]);
  if (!Number.isFinite(size)) throw new Error('Could not inspect staged file size: ' + file);
  if (size > 90 * 1024 * 1024) forbidden.push(file + ' (use a release asset for large files)');
}
if (forbidden.length) {
  console.error('Publication safety check rejected these paths:\n' + forbidden.join('\n'));
  process.exitCode = 1;
} else {
  console.log(`Publication index check passed: ${files.length} source/material files. Review content for credentials and unrelated private data before pushing.`);
}
