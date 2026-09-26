const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');

const projectRoot = path.resolve(__dirname, '..');
const sourceRoot = path.join(projectRoot, 'src');
const entry = path.join(sourceRoot, 'index.ts');
const runner = path.join(projectRoot, 'node_modules', 'ts-node', 'dist', 'bin.js');

let child = null;
let restartTimer = null;
let stopping = false;
let restartRequested = false;

function startChild() {
  if (stopping || child) return;
  console.log('[dev] starting bot process');
  const next = spawn(process.execPath, [runner, entry], {
    cwd: projectRoot,
    env: { ...process.env, TS_NODE_TRANSPILE_ONLY: '1' },
    stdio: 'inherit',
    windowsHide: false,
  });
  child = next;

  next.once('error', (error) => {
    console.error(`[dev] could not start bot: ${error.message}`);
    if (child === next) child = null;
    scheduleRestart(3000);
  });
  next.once('exit', (code, signal) => {
    if (child === next) child = null;
    if (!stopping) {
      const reason = signal ? `signal ${signal}` : `code ${code ?? 0}`;
      console.error(`[dev] bot process exited (${reason})`);
      scheduleRestart(restartRequested ? 100 : 3000);
    }
    restartRequested = false;
  });
}

function scheduleRestart(delay) {
  if (stopping || restartTimer) return;
  restartTimer = setTimeout(() => {
    restartTimer = null;
    startChild();
  }, delay);
}

function restartChild() {
  if (stopping) return;
  restartRequested = true;
  if (child) {
    child.kill();
  } else {
    scheduleRestart(100);
  }
}

let debounceTimer = null;
const watcher = fs.watch(sourceRoot, { recursive: true }, (_event, filename) => {
  if (filename && !String(filename).endsWith('.ts') && !String(filename).endsWith('.tsx')) return;
  if (debounceTimer) clearTimeout(debounceTimer);
  debounceTimer = setTimeout(restartChild, 250);
});

function stop(signal) {
  if (stopping) return;
  stopping = true;
  console.log(`[dev] stopping (${signal})`);
  watcher.close();
  if (debounceTimer) clearTimeout(debounceTimer);
  if (restartTimer) clearTimeout(restartTimer);
  if (child) child.kill();
  setTimeout(() => process.exit(0), 500);
}

process.once('SIGINT', () => stop('SIGINT'));
process.once('SIGTERM', () => stop('SIGTERM'));

startChild();
