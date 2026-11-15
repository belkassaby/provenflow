/**
 * Stages the desktop application for electron-builder, in packages/desktop/stage/:
 *
 *   main/                    the compiled main process and preload script (packages/desktop/out)
 *   ui/                      the built editor (packages/app/dist/app/browser)
 *   node_modules/            @provenflow/language, extract and server as npm installs them (their
 *                            "files": out, grammars, rules...), and their production dependencies
 *   package.json             the application's: name, version, main, and the Electron version to build
 *
 * The workspace packages are not published: each is packed (npm pack, which keeps its "files") and
 * installed from the tarball, so that node_modules holds real folders, as the packaged application
 * needs. Their dependencies on each other are dropped from the copies: all three are installed
 * side by side at the top of node_modules.
 *
 * Usage: npm run build (at the root), then npm run stage -w @provenflow/desktop.
 */
import { execFileSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const desktop = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const root = resolve(desktop, '../..');
const stage = join(desktop, 'stage');
const PACKAGES = ['language', 'extract', 'server'];
const json = path => JSON.parse(readFileSync(path, 'utf8'));
const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';

function need(path, hint) {
    if (!existsSync(path)) {
        console.error(`Missing ${path}: ${hint}`);
        process.exit(1);
    }
}

need(join(desktop, 'out/main.js'), 'run npm run build -w @provenflow/desktop');
need(join(root, 'packages/app/dist/app/browser/index.html'), 'run npm run build at the root');
for (const p of PACKAGES) need(join(root, `packages/${p}/out/index.js`), 'run npm run build at the root');

rmSync(stage, { recursive: true, force: true });
mkdirSync(stage, { recursive: true });
cpSync(join(desktop, 'out'), join(stage, 'main'), { recursive: true, filter: src => !src.endsWith('.map') });
cpSync(join(root, 'packages/app/dist/app/browser'), join(stage, 'ui'), { recursive: true });
cpSync(join(desktop, 'build/icon.png'), join(stage, 'icon.png'));

// Local copies of the workspace packages, packed.
const tarballs = {};
for (const p of PACKAGES) {
    const from = join(root, 'packages', p);
    const to = join(stage, 'local', p);
    const pkg = json(join(from, 'package.json'));
    const files = pkg.files ?? ['out'];
    for (const f of [...new Set([...files.filter(x => x !== 'src'), 'out'])]) if (existsSync(join(from, f))) cpSync(join(from, f), join(to, f), { recursive: true, filter: src => !src.endsWith('.map') && !src.endsWith('.tsbuildinfo') });
    for (const name of Object.keys(pkg.dependencies ?? {})) if (name.startsWith('@provenflow/')) delete pkg.dependencies[name];
    delete pkg.devDependencies;
    delete pkg.scripts;
    pkg.files = undefined;
    writeFileSync(join(to, 'package.json'), `${JSON.stringify(pkg, null, 2)}\n`);
    const packed = execFileSync(npm, ['pack', '--silent', '--pack-destination', join(stage, 'local')], { cwd: to, encoding: 'utf8', shell: process.platform === 'win32' }).trim().split('\n').pop();
    tarballs[p] = `file:./local/${packed}`;
}

const desktopPkg = json(join(desktop, 'package.json'));
const electronVersion = json(join(root, 'node_modules/electron/package.json')).version;
const appPkg = {
    name: 'provenflow',
    productName: 'ProvenFlow',
    version: desktopPkg.version,
    description: 'Design and verify state machines with nuXmv, and review code.',
    license: 'MIT',
    author: 'ProvenFlow',
    homepage: 'https://github.com/belkassaby/provenflow',
    type: 'module',
    main: 'main/main.js',
    dependencies: Object.fromEntries(PACKAGES.map(p => [`@provenflow/${p}`, tarballs[p]])),
    devDependencies: { electron: electronVersion }
};
writeFileSync(join(stage, 'package.json'), `${JSON.stringify(appPkg, null, 2)}\n`);

execFileSync(npm, ['install', '--omit=dev', '--no-audit', '--no-fund', '--ignore-scripts'], { cwd: stage, stdio: 'inherit', shell: process.platform === 'win32' });
rmSync(join(stage, 'local'), { recursive: true, force: true });
console.log(`Staged ProvenFlow ${appPkg.version} (Electron ${electronVersion}) in ${stage}`);
