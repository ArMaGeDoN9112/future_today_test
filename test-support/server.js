import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { resolve } from 'node:path';

const serverPath = resolve('src/server.js');

export async function start(cwd, nodeArgs = []) {
  const child = spawn(process.execPath, [...nodeArgs, serverPath], {
    cwd, env: { ...process.env, PORT: '0' }, stdio: ['ignore', 'pipe', 'pipe'],
  });
  let errors = '';
  child.stderr.on('data', chunk => { errors += chunk; });
  const url = await new Promise((resolve, reject) => {
    let output = '';
    child.stdout.on('data', chunk => {
      output += chunk;
      const match = output.match(/http:\/\/localhost:\d+/);
      if (match) resolve(match[0]);
    });
    child.once('error', reject);
    child.once('exit', code => reject(new Error(`Server exited ${code}: ${errors}`)));
  });
  return {
    url,
    async request(path, method = 'GET', body) {
      const response = await fetch(new URL(path, url), {
        method,
        headers: body === undefined ? {} : { 'Content-Type': 'application/json' },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      return { status: response.status, body: await response.json() };
    },
    async stop() {
      if (child.exitCode !== null || child.signalCode !== null) return;
      const exited = once(child, 'exit');
      child.kill();
      await exited;
    },
  };
}
