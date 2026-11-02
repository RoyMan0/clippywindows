#!/usr/bin/env node
'use strict';

/**
 * Copy Clippy's usage reader into the remote bridge extension before it is
 * packaged, so the extension can read Claude Code's usage files on the remote
 * machine with exactly the code Clippy itself uses. (VS Code extensions are
 * packaged from their own folder and can't reach ../../src at runtime.)
 *
 *   node scripts/prepare-bridge.js
 */

const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const LIB = path.join(ROOT, 'vscode', 'clippy-bridge-remote', 'lib');

fs.mkdirSync(LIB, { recursive: true });
for (const file of ['usage.js', 'jsonl.js']) {
  fs.copyFileSync(path.join(ROOT, 'src', file), path.join(LIB, file));
}
console.log(`copied usage.js and jsonl.js into ${path.relative(ROOT, LIB)}`);
