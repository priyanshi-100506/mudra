#!/usr/bin/env node
/**
 * Brings up everything the demo needs, on macOS, Linux or Windows.
 *
 * Written in Node rather than as a shell script because Node is already a
 * hard dependency (the extension build needs it) and a .sh would strand
 * Windows. `make demo` shells out to this; so can `npm run demo`.
 *
 * Three things start: the FastAPI backend, a static server for the eval
 * fixtures, and a one-off extension build. The script is deliberately loud
 * about what it could not do — a demo that half-starts and says nothing is
 * worse than one that refuses, because you find out in front of people.
 */
import { spawn, spawnSync } from 'child_process';
import { existsSync } from 'fs';
import { resolve, dirname, join } from 'path';
import { fileURLToPath } from 'url';
import http from 'http';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const isWindows = process.platform === 'win32';

const BACKEND_PORT = process.env.PORT ?? '8000';
const FIXTURE_PORT = process.env.FIXTURE_PORT ?? '5173';

const children = [];
let shuttingDown = false;

function log(tag, message) {
  process.stdout.write(`  ${tag.padEnd(9)} ${message}\n`);
}

function die(message, hint) {
  process.stderr.write(`\n  ✗ ${message}\n`);
  if (hint) process.stderr.write(`    ${hint}\n`);
  shutdown(1);
}

function shutdown(code = 0) {
  if (shuttingDown) return;
  shuttingDown = true;
  for (const child of children) {
    try { child.kill(isWindows ? undefined : 'SIGTERM'); } catch { /* already gone */ }
  }
  process.exit(code);
}

process.on('SIGINT', () => shutdown(0));
process.on('SIGTERM', () => shutdown(0));

/** Finds the virtualenv's Python, wherever this platform puts it. */
function findPython() {
  const candidates = isWindows
    ? [join(root, '.venv', 'Scripts', 'python.exe'),
       join(root, 'backend', '.venv', 'Scripts', 'python.exe')]
    : [join(root, '.venv', 'bin', 'python'),
       join(root, 'backend', '.venv', 'bin', 'python')];
  return candidates.find(existsSync) ?? null;
}

function start(tag, command, args, cwd) {
  const child = spawn(command, args, {
    cwd,
    stdio: ['ignore', 'pipe', 'pipe'],
    shell: isWindows,
  });
  children.push(child);
  const relay = (stream, isError) => {
    stream.setEncoding('utf8');
    let buffer = '';
    stream.on('data', (chunk) => {
      buffer += chunk;
      const lines = buffer.split('\n');
      buffer = lines.pop() ?? '';
      for (const line of lines) {
        if (line.trim()) process[isError ? 'stderr' : 'stdout'].write(`  ${tag.padEnd(9)} ${line}\n`);
      }
    });
  };
  relay(child.stdout, false);
  relay(child.stderr, true);
  child.on('exit', (code) => {
    if (!shuttingDown && code !== 0) {
      process.stderr.write(`\n  ✗ ${tag} exited with code ${code}\n`);
      shutdown(code ?? 1);
    }
  });
  return child;
}

/** Waits for a port to answer, so we report readiness rather than hope. */
function waitForPort(port, path, timeoutMs = 30000) {
  const deadline = Date.now() + timeoutMs;
  return new Promise((resolveWait) => {
    const attempt = () => {
      const req = http.get({ host: '127.0.0.1', port, path, timeout: 1000 }, (res) => {
        res.resume();
        resolveWait(true);
      });
      req.on('error', () => {
        if (Date.now() > deadline) return resolveWait(false);
        setTimeout(attempt, 400);
      });
      req.on('timeout', () => { req.destroy(); });
    };
    attempt();
  });
}

async function main() {
  process.stdout.write('\n  MUDRA demo\n  ' + '─'.repeat(56) + '\n');

  // 1. Extension build, first and synchronously: everything else is useless
  //    without it, and a stale dist/ is a confusing way to lose ten minutes.
  log('build', 'building the extension…');
  const npm = isWindows ? 'npm.cmd' : 'npm';
  const build = spawnSync(npm, ['run', 'build'], {
    cwd: join(root, 'extension'),
    stdio: 'inherit',
    shell: isWindows,
  });
  if (build.status !== 0) die('Extension build failed.', 'Try: cd extension && npm install');
  log('build', 'extension/dist is ready');

  if (!existsSync(join(root, 'extension', 'public', 'models', 'version-RFB-320.onnx'))) {
    log('note', 'No ONNX weights: the visual pass will fail closed and send no image.');
    log('note', 'See extension/public/models/README.md.');
  }

  // 2. Backend.
  const python = findPython();
  if (!python) {
    die('No virtualenv found.',
        isWindows
          ? 'Create one: python -m venv .venv && .venv\\Scripts\\Activate.ps1 && pip install -r backend/requirements.txt'
          : 'Create one: python3 -m venv .venv && source .venv/bin/activate && pip install -r backend/requirements.txt');
  }
  log('backend', `starting on http://127.0.0.1:${BACKEND_PORT}`);
  start('backend', python,
        ['-m', 'uvicorn', 'app.main:app', '--host', '127.0.0.1', '--port', BACKEND_PORT],
        join(root, 'backend'));

  // 3. Fixture server, for the eval pages.
  log('fixtures', `serving eval/fixtures on http://127.0.0.1:${FIXTURE_PORT}`);
  start('fixtures', python, ['-m', 'http.server', FIXTURE_PORT, '--bind', '127.0.0.1'],
        join(root, 'eval', 'fixtures'));

  const [backendUp, fixturesUp] = await Promise.all([
    waitForPort(BACKEND_PORT, '/health'),
    waitForPort(FIXTURE_PORT, '/'),
  ]);

  if (!backendUp) die('Backend did not come up.', 'Check the backend log above.');
  if (!fixturesUp) die('Fixture server did not come up.');

  // Report which planner actually answered, rather than which one we hoped
  // for. A misconfigured backend should be obvious now, not mid-demo.
  http.get({ host: '127.0.0.1', port: BACKEND_PORT, path: '/health' }, (res) => {
    let body = '';
    res.setEncoding('utf8');
    res.on('data', (c) => { body += c; });
    res.on('end', () => {
      let planner = 'unknown';
      let status = 'unknown';
      try {
        const parsed = JSON.parse(body);
        planner = parsed.planner ?? 'unknown';
        status = parsed.status ?? 'unknown';
        if (parsed.detail) log('planner', parsed.detail);
      } catch { /* leave as unknown */ }

      process.stdout.write('\n  ' + '─'.repeat(56) + '\n');
      log('ready', `planner: ${planner} (${status})`);
      log('ready', `backend:  http://127.0.0.1:${BACKEND_PORT}`);
      log('ready', `fixtures: http://127.0.0.1:${FIXTURE_PORT}`);
      log('ready', 'load extension/dist at chrome://extensions (Developer mode)');
      process.stdout.write('\n  Ctrl-C to stop.\n\n');
    });
  }).on('error', () => log('ready', 'backend is up but /health did not answer'));
}

main().catch((err) => die(err instanceof Error ? err.message : String(err)));
