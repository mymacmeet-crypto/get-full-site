'use strict';

/**
 * Copy Turndown's browser builds into the extension.
 *
 * The extension converts pages to Markdown with the same library the crawler
 * uses, but it cannot `require` it: the offscreen document's rollup entry point
 * has no node-resolve plugin, and giving it one would mean the extension build
 * pulls from node_modules — a dependency the vendored `extension/` directory is
 * specifically meant not to have. So the two UMD bundles are copied in and
 * loaded as <script> tags, and this script is how they are refreshed after an
 * `npm update`, with the version recorded in the file itself.
 *
 *   node tools/vendor-turndown.js
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const OUTPUT_DIR = path.join(ROOT, 'extension', 'lib', 'vendor');

const PACKAGES = [
  { name: 'turndown', file: 'dist/turndown.js', global: 'TurndownService' },
  { name: 'turndown-plugin-gfm', file: 'dist/turndown-plugin-gfm.js', global: 'turndownPluginGfm' },
];

function version(name) {
  return require(path.join(ROOT, 'node_modules', name, 'package.json')).version;
}

function main() {
  fs.mkdirSync(OUTPUT_DIR, { recursive: true });
  for (const { name, file, global } of PACKAGES) {
    const source = path.join(ROOT, 'node_modules', name, file);
    if (!fs.existsSync(source)) {
      throw new Error(`${source} is missing — run npm install first`);
    }
    const notice = [
      '/*',
      ` * ${name} ${version(name)} (MIT), copied verbatim by tools/vendor-turndown.js.`,
      ` * Loaded as a <script> tag by src/ui/pages/offscreen-document.html, which`,
      ` * is what puts \`${global}\` on globalThis for the bundled offscreen code.`,
      ' * Do not edit here: re-run the script instead.',
      ' */',
      '',
    ].join('\n');
    const target = path.join(OUTPUT_DIR, path.basename(file));
    fs.writeFileSync(target, notice + fs.readFileSync(source, 'utf8'));
    console.log(`${name}@${version(name)} -> ${path.relative(ROOT, target)}`);
  }
}

main();
