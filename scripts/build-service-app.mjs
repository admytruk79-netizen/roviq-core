// Builds the ROVIQ Service app: the tabbed shell at `/` plus each role's existing portal under its
// own folder (`/customer/`, `/diagnostic/`, `/tow/`, `/partner/`, `/parts/`, `/fleet/`, `/ops/`), all on one origin so the
// shell's single sign-in reaches every tab. Output: service/dist.
import { spawnSync } from 'node:child_process';
import { existsSync, rmSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dist = path.join(root, 'service', 'dist');

// Portal directory -> folder it is served from inside the Service app (see service/src/session.ts).
const tabs = [
  ['web', 'customer'],
  ['diagnostic', 'diagnostic'],
  ['tow', 'tow'],
  ['partner', 'partner'],
  ['parts-portal', 'parts'],
  ['fleet', 'fleet'],
  ['ops', 'ops']
];

function run(cwd, args) {
  const result = spawnSync('npm', args, { cwd, stdio: 'inherit', env: process.env });
  if (result.status !== 0) {
    console.error(`FAIL: npm ${args.join(' ')} in ${path.relative(root, cwd) || '.'}`);
    process.exit(result.status ?? 1);
  }
}

function install(cwd) {
  if (!existsSync(path.join(cwd, 'node_modules'))) run(cwd, ['ci', '--no-audit', '--no-fund']);
}

rmSync(dist, { recursive: true, force: true });

const shell = path.join(root, 'service');
install(shell);
run(shell, ['run', 'build']);

for (const [portal, folder] of tabs) {
  const cwd = path.join(root, portal);
  install(cwd);
  // `npm run build` is `tsc --noEmit && vite build`; the extra flags reach `vite build`.
  run(cwd, ['run', 'build', '--', `--base=/${folder}/`, `--outDir=${path.join(dist, folder)}`, '--emptyOutDir']);
}

console.log(`ROVIQ Service app built: ${path.relative(root, dist)} (shell + ${tabs.map(([, f]) => f).join(', ')})`);
