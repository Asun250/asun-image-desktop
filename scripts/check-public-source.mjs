import {execFileSync} from 'node:child_process';
import path from 'node:path';

// Inspect the staged index, not ignored/local files. Synthetic test fixtures and
// application prompt builders are source code; personal prompt records are not.
const files = execFileSync('git', ['ls-files', '-z'], {encoding: 'utf8'}).split('\0').filter(Boolean);
const extensions = new Set(['.mjs', '.js', '.css', '.html', '.py', '.ps1', '.cs', '.json', '.md']);
const exact = new Set(['.gitignore', '.gitattributes', 'scripts/sam2-requirements.txt', '.githooks/pre-commit']);
const privateDirectory = /(^|\/)(?:data|logs|qa|backups|branding|node_modules|local-ai|prompts|references|outputs|exports|projects|\.venv|venv)(\/|$)/i;
const privateName = /(^|\/)(?:\.env(?:\..*)?|credentials[^/]*|secrets[^/]*|RELEASE\.json|pre-activation-[^/]*)$/i;
const forbidden = files.filter(file => privateDirectory.test(file) || privateName.test(file) || (!exact.has(file) && !extensions.has(path.posix.extname(file).toLowerCase())));
if (forbidden.length) {
  console.error('Code-only publication rejected these paths:\n' + forbidden.join('\n'));
  process.exitCode = 1;
} else {
  console.log(`Code-only index check passed: ${files.length} source/documentation files. Review text diffs for personal prompts and credentials before pushing.`);
}
