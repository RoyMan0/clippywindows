#!/usr/bin/env node
'use strict';

/**
 * Smoke test for the Windows window helper on a real Windows machine (CI's
 * windows-latest runner, or your own PC): compiles the PowerShell/C# helper and
 * runs each read-only command once. Exits non-zero if any of them fails.
 *
 *   node scripts/win-helper-smoke.js
 */

const { WinWindows } = require('../src/win-windows');

async function main() {
  if (process.platform !== 'win32') {
    console.log('skipped: not Windows');
    return;
  }
  const helper = new WinWindows();
  try {
    const started = Date.now();
    console.log('ping:', await helper.call('ping'), `(${Date.now() - started} ms, includes compile)`);
    const windows = await helper.list();
    console.log(`list: ${windows.length} window(s)`);
    for (const w of windows.slice(0, 10)) console.log('  ', JSON.stringify(w));
    console.log('front:', JSON.stringify(await helper.front()));
    if (windows[0]) console.log('bounds:', JSON.stringify(await helper.bounds(windows[0].hwnd)));
    console.log('bounds of a window that is not there:', JSON.stringify(await helper.bounds(1)));
  } finally {
    helper.stop();
  }
}

main().catch((err) => {
  console.error('window helper smoke test failed:', err.message);
  process.exit(1);
});
