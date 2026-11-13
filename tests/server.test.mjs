import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, copyFile, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { once } from 'node:events';

test('public gallery preserves validated colors and accepts older drawings', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'color-plotter-api-'));
  await copyFile(new URL('../server.mjs', import.meta.url), join(directory, 'server.mjs'));
  await mkdir(join(directory, 'assets'));
  const port = 20000 + Math.floor(Math.random() * 20000);
  const server = spawn(process.execPath, [join(directory, 'server.mjs')], {
    env: { ...process.env, PORT: String(port), HOST: '127.0.0.1' }, stdio: ['ignore', 'pipe', 'pipe'],
  });
  try {
    await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('Server startup timed out')), 5000);
      server.stdout.on('data', () => { clearTimeout(timeout); resolve(); });
      server.once('exit', code => { clearTimeout(timeout); reject(new Error(`Server exited ${code}`)); });
    });
    const base = `http://127.0.0.1:${port}`;
    const response = await fetch(`${base}/api/drawings`, {
      method: 'POST', headers: {'content-type':'application/json'},
      body: JSON.stringify({name:'Color test',artist:'Test',strokes:[
        {points:[{x:.1,y:.2},{x:.8,y:.9}],shape:true,color:'#E53935'},
        {points:[{x:0,y:0},{x:1,y:1}],color:'url(unsafe)'},
        {points:[{x:.2,y:.1},{x:.9,y:.8}]}
      ]}),
    });
    assert.equal(response.status, 201);
    const saved = (await response.json()).drawing;
    assert.equal(saved.strokes[0].color, '#e53935');
    assert.equal(saved.strokes[0].shape, true);
    assert.equal(saved.strokes[1].color, undefined);
    assert.equal(saved.strokes[2].color, undefined);
    const gallery = await (await fetch(`${base}/api/drawings`)).json();
    assert.deepEqual(gallery.drawings[0].strokes, saved.strokes);
  } finally {
    server.kill();
    if (server.exitCode === null) await once(server, 'exit');
    await rm(directory, { recursive: true, force: true });
  }
});
