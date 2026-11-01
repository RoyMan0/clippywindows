#!/usr/bin/env node
'use strict';

/**
 * Build the Windows installer: dist/Clippy-for-Claude-Code-Setup-<version>.exe
 *
 *   npm run package:win
 *
 * The Mac build (package-app.js) assembles its bundle by hand. Windows wants an
 * installer with a Start-menu entry and an uninstaller, which is exactly what
 * electron-builder's NSIS target produces, so this script only prepares what
 * electron-builder can't: the drawn buddies and a drawn icon.
 *
 * Run it on Windows (or in CI's windows-latest). On macOS/Linux electron-builder
 * needs Wine to stamp the .exe, and fails without it.
 *
 * The installer is unsigned, so Windows SmartScreen will warn on first run
 * ("Windows protected your PC" → More info → Run anyway) until it is signed
 * with a code-signing certificate.
 */

const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { encodePng, renderIconPixels } = require('./package-app');

const ROOT = path.join(__dirname, '..');
const BUILD = path.join(ROOT, 'build');
const ICON_SIZES = [16, 24, 32, 48, 64, 128, 256];

/**
 * A multi-size .ico. Since Windows Vista an icon entry may simply be a PNG,
 * so this is a 6-byte header, a 16-byte directory entry per size, and the
 * PNGs the Mac icon is already drawn with.
 */
function buildIco(sizes = ICON_SIZES) {
  const images = sizes.map((size) => ({ size, png: encodePng(size, size, renderIconPixels(size)) }));
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0); // reserved
  header.writeUInt16LE(1, 2); // 1 = icon
  header.writeUInt16LE(images.length, 4);
  const entries = [];
  let offset = 6 + 16 * images.length;
  for (const { size, png } of images) {
    const e = Buffer.alloc(16);
    e.writeUInt8(size >= 256 ? 0 : size, 0); // 0 means 256
    e.writeUInt8(size >= 256 ? 0 : size, 1);
    e.writeUInt8(0, 2); // no palette
    e.writeUInt8(0, 3);
    e.writeUInt16LE(1, 4); // colour planes
    e.writeUInt16LE(32, 6); // bits per pixel
    e.writeUInt32LE(png.length, 8);
    e.writeUInt32LE(offset, 12);
    offset += png.length;
    entries.push(e);
  }
  return Buffer.concat([header, ...entries, ...images.map((i) => i.png)]);
}

function main() {
  // The buddies are drawn, not stored; the installer has to carry them.
  execFileSync(process.execPath, [path.join(__dirname, 'make-buddies.js')], { stdio: 'inherit', cwd: ROOT });
  fs.mkdirSync(BUILD, { recursive: true });
  fs.writeFileSync(path.join(BUILD, 'icon.ico'), buildIco());

  // electron-builder reads its settings from package.json's "build" key.
  const cli = require.resolve('electron-builder/cli.js');
  execFileSync(process.execPath, [cli, '--win', 'nsis', '--x64', '--publish', 'never'], {
    stdio: 'inherit',
    cwd: ROOT,
  });
}

if (require.main === module) main();

module.exports = { buildIco };
