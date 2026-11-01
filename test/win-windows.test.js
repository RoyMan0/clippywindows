'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const { EventEmitter } = require('node:events');
const { PassThrough } = require('node:stream');
const {
  WinWindows,
  pickWindow,
  titleNames,
  sendKeysText,
  helperScript,
  encodedCommand,
} = require('../src/win-windows');
const { terminalFromHeaders } = require('../src/terminal');

const desk = [
  { hwnd: 1, pid: 100, proc: 'Code', title: 'server.js - my-app - Visual Studio Code' },
  { hwnd: 2, pid: 100, proc: 'Code', title: '● notes.md - other-app - Visual Studio Code' },
  { hwnd: 3, pid: 200, proc: 'WindowsTerminal', title: '✳ Claude Code' },
  { hwnd: 4, pid: 300, proc: 'chrome', title: 'my-app - GitHub - Google Chrome' },
];

test('a title names a folder as a whole segment, never as a substring', () => {
  assert.equal(titleNames('server.js - my-app - Visual Studio Code', 'my-app'), true);
  assert.equal(titleNames('my-app — Visual Studio Code', 'My-App'), true);
  assert.equal(titleNames('● my-app - Cursor', 'my-app'), true);
  assert.equal(titleNames('my-app [WSL: Ubuntu] - Visual Studio Code', 'my-app'), true);
  assert.equal(titleNames('server.js - my-app - Visual Studio Code', 'app'), false);
  assert.equal(titleNames('anything', ''), false);
});

test('the VS Code extension finds its project window by folder', () => {
  const term = { program: 'vscode', hostPid: 100 };
  assert.equal(pickWindow(desk, term, 'my-app').hwnd, 1);
  assert.equal(pickWindow(desk, term, 'other-app').hwnd, 2);
});

test('a browser tab with the same folder name is never mistaken for the editor', () => {
  assert.equal(pickWindow(desk, { program: 'vscode' }, 'my-app').hwnd, 1);
  assert.equal(pickWindow([desk[3]], { program: 'vscode' }, 'my-app'), null);
});

test('with several editor windows and no matching title, it refuses to guess', () => {
  assert.equal(pickWindow(desk, { program: 'vscode', hostPid: 100 }, 'unrelated'), null);
});

test('one window of the right kind is enough without a title match', () => {
  assert.equal(pickWindow(desk, { program: 'Windows Terminal' }, 'my-app').hwnd, 3);
  assert.equal(pickWindow([desk[0]], { program: 'vscode' }, 'nope').hwnd, 1);
});

test('SendKeys syntax characters are typed literally and Return goes last', () => {
  assert.equal(sendKeysText('run 1+1 (now) {x} ~^%[]'), 'run 1{+}1 {(}now{)} {{}x{}} {~}{^}{%}{[}{]}{ENTER}');
  assert.equal(sendKeysText('two\nlines'), 'two lines{ENTER}');
});

test('http hook headers become a terminal record that names the host', () => {
  const ext = terminalFromHeaders({ 'x-clippy-hook': '#clippy', 'x-clippy-entrypoint': 'claude-vscode', 'x-clippy-host-pid': '100' });
  assert.deepEqual(ext, { program: 'vscode', tty: '', pid: 0, hostPid: 100, entrypoint: 'claude-vscode' });
  const wt = terminalFromHeaders({ 'x-clippy-hook': '#clippy', 'x-clippy-wt': 'abc' });
  assert.equal(wt.program, 'Windows Terminal');
  const bare = terminalFromHeaders({ 'x-clippy-hook': '#clippy' });
  assert.equal(bare.program, '');
  // The Mac's curl hooks are read exactly as before.
  assert.equal(terminalFromHeaders({}), null);
});

test('the helper script survives encoding and keeps its C# intact', () => {
  const script = helperScript();
  assert.match(script, /\$src = @'\n/);
  assert.match(script, /\n'@\nAdd-Type/);
  assert.ok(!/^'@/m.test(script.split("@'\n")[1].split("\n'@")[0]), 'C# must not end the here-string early');
  assert.equal(Buffer.from(encodedCommand(), 'base64').toString('utf16le'), script);
});

/** A stand-in for powershell.exe that answers like the real helper would. */
function fakeHelper(answer) {
  const spawned = [];
  const spawnImpl = (file, args) => {
    const child = new EventEmitter();
    child.stdin = new PassThrough();
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.kill = () => child.emit('exit', null);
    let buf = '';
    child.stdin.on('data', (d) => {
      buf += d;
      let nl;
      while ((nl = buf.indexOf('\n')) !== -1) {
        const [id, cmd, arg] = buf.slice(0, nl).split(' ');
        buf = buf.slice(nl + 1);
        const reply = answer(cmd, arg, child);
        if (reply !== undefined) child.stdout.write(`${id} ${JSON.stringify(reply)}\n`);
      }
    });
    spawned.push({ file, args, child });
    return child;
  };
  return { spawnImpl, spawned };
}

test('calls are matched to answers by id, through one helper process', async () => {
  const { spawnImpl, spawned } = fakeHelper((cmd, arg) =>
    cmd === 'list' ? desk : cmd === 'bounds' ? { x: Number(arg), y: 0, width: 10, height: 10 } : { ok: true }
  );
  const helper = new WinWindows({ spawnImpl, platform: 'win32' });
  const [list, b1, b2] = await Promise.all([helper.list(), helper.bounds(7), helper.bounds(9)]);
  assert.equal(list.length, desk.length);
  assert.equal(b1.x, 7);
  assert.equal(b2.x, 9);
  assert.equal(spawned.length, 1);
  assert.equal(spawned[0].file, 'powershell.exe');
  assert.ok(spawned[0].args.includes('-EncodedCommand'));
});

test('a helper error rejects that call only, and a dead helper is restarted', async () => {
  const { spawnImpl, spawned } = fakeHelper((cmd, arg, child) => {
    if (cmd === 'raise') return { error: 'no such window' };
    if (cmd === 'die') {
      child.emit('exit', 1);
      return undefined;
    }
    return { ok: true };
  });
  const helper = new WinWindows({ spawnImpl, platform: 'win32', log: () => {} });
  await assert.rejects(helper.raise(5), /no such window/);
  await assert.rejects(helper.call('die'), /exited/);
  assert.deepEqual(await helper.call('ping'), { ok: true });
  assert.equal(spawned.length, 2);
});

test('typing sends escaped keystrokes as base64', async () => {
  let got = '';
  const { spawnImpl } = fakeHelper((cmd, arg) => {
    if (cmd === 'type') got = Buffer.from(arg, 'base64').toString('utf8');
    return { ok: true };
  });
  const helper = new WinWindows({ spawnImpl, platform: 'win32' });
  await helper.type('npm test (again)');
  assert.equal(got, 'npm test {(}again{)}{ENTER}');
});

test('off Windows the helper is never started', async () => {
  let started = false;
  const helper = new WinWindows({ spawnImpl: () => (started = true), platform: 'darwin' });
  await assert.rejects(helper.list(), /Windows-only/);
  assert.equal(started, false);
});

test('the Windows icon is a valid multi-size .ico of PNGs', () => {
  const { buildIco } = require('../scripts/package-win');
  const ico = buildIco([16, 256]);
  assert.equal(ico.readUInt16LE(2), 1);
  assert.equal(ico.readUInt16LE(4), 2);
  assert.equal(ico.readUInt8(6), 16);
  assert.equal(ico.readUInt8(6 + 16), 0); // 256 is written as 0
  const offset = ico.readUInt32LE(6 + 12);
  assert.deepEqual([...ico.subarray(offset, offset + 4)], [0x89, 0x50, 0x4e, 0x47]);
  assert.equal(offset + ico.readUInt32LE(6 + 8), ico.readUInt32LE(6 + 16 + 12));
});
