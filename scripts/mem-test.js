'use strict';

/**
 * Mede o custo de memoria do app em dois cenarios: so na bandeja (janela
 * fechada) e com a janela aberta.
 *
 *   node scripts/mem-test.js
 */

const { spawn, execFile } = require('node:child_process');
const path = require('node:path');
const os = require('node:os');

const APP = path.resolve(__dirname, '..');
const ELECTRON = path.join(APP, 'node_modules', 'electron', 'dist', 'electron.exe');
const MODE = process.argv[2] || 'bandeja';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function ps(script) {
  return new Promise((resolve) => {
    execFile(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script],
      { windowsHide: true, timeout: 20000 },
      (err, stdout) => resolve(err ? '' : stdout.toString())
    );
  });
}

async function tree(rootPid) {
  const out = await ps(
    'Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,WorkingSetSize,Name | ConvertTo-Json -Compress'
  );
  if (!out.trim()) return [];
  let rows;
  try {
    rows = JSON.parse(out);
  } catch {
    return [];
  }
  if (!Array.isArray(rows)) rows = [rows];

  const byParent = new Map();
  for (const row of rows) {
    byParent.set(row.ParentProcessId, [...(byParent.get(row.ParentProcessId) || []), row]);
  }
  const all = [];
  const walk = (pid) => {
    for (const child of byParent.get(pid) || []) {
      all.push(child);
      walk(child.ProcessId);
    }
  };
  walk(rootPid);
  return all;
}

(async () => {
  const userData = path.join(os.tmpdir(), `memtest-${Date.now()}`);
  const comJanela = MODE === 'janela';
  const flags = comJanela ? [] : ['--hidden'];

  const child = spawn(ELECTRON, [APP, `--user-data-dir=${userData}`, ...flags], {
    cwd: APP,
    stdio: 'ignore',
    windowsHide: true,
  });

  await sleep(comJanela ? 22000 : 16000);

  const rows = await tree(child.pid);
  let total = 0;
  const porNome = new Map();
  for (const row of rows) {
    const mb = (row.WorkingSetSize || 0) / (1024 * 1024);
    total += mb;
    const nome = row.Name || '?';
    porNome.set(nome, (porNome.get(nome) || 0) + mb);
  }

  try {
    process.kill(child.pid);
  } catch {
    /* ja encerrado */
  }
  await sleep(2000);

  const detalhe = [...porNome.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([nome, mb]) => `${nome} ${mb.toFixed(0)}MB`)
    .join(' + ');

  console.log(`\n  ${MODE.padEnd(8)} ${total.toFixed(0).padStart(4)} MB  |  ${detalhe}\n`);
  process.exit(0);
})();
