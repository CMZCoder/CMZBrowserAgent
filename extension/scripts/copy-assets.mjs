import fs from 'node:fs';
import path from 'node:path';

const extensionRoot = process.cwd();
const buildDir = path.join(extensionRoot, 'build');

const assets = [
  ['manifest.json', 'manifest.json'],
  ['src/sidepanel.html', 'sidepanel.html'],
  ['src/options.html', 'options.html'],
  ['src/sidepanel.css', 'sidepanel.css'],
  ['src/content-script.runtime.js', 'content-script.runtime.js'],
];

for (const [fromRelative, toRelative] of assets) {
  const source = path.join(extensionRoot, fromRelative);
  const target = path.join(buildDir, toRelative);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.copyFileSync(source, target);
}

console.log('Copied extension assets into build/.');
