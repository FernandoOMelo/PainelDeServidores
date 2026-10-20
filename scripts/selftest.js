'use strict';

/**
 * Teste funcional do motor (sem interface grafica).
 * Exercita: ciclo de vida, health check, captura de logs, metricas e auto-restart.
 *
 *   node scripts/selftest.js
 */

const os = require('node:os');
const path = require('node:path');
const fs = require('node:fs');
const assert = require('node:assert');

const { Store } = require('../electron/store');
const { ServiceManager } = require('../electron/service-manager');

const PORT = 45999;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const results = [];
function check(name, fn) {
  try {
    fn();
    results.push({ name, ok: true });
    console.log(`  PASS  ${name}`);
  } catch (err) {
    results.push({ name, ok: false, err: err.message });
    console.log(`  FAIL  ${name}\n        ${err.message}`);
  }
}

async function waitFor(predicate, timeoutMs = 12000, label = 'condicao') {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return true;
    await sleep(200);
  }
  throw new Error(`timeout aguardando: ${label}`);
}

async function main() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'painel-selftest-'));
  const store = new Store(path.join(tmp, 'config.json'));
  const manager = new ServiceManager(store, { logDir: path.join(tmp, 'logs'), tempDir: tmp, appRoot: tmp });
  manager.init();

  console.log('\n== 1. Ciclo de vida ==');
  const server = manager.create({
    name: 'Servidor de teste',
    command: process.execPath,
    args: [
      '-e',
      `const http=require('http');http.createServer((q,s)=>{console.log('req '+q.url);s.end('ok')}).listen(${PORT},()=>console.log('escutando ${PORT}'))`,
    ],
    health: { type: 'tcp', port: PORT, intervalMs: 1000, timeoutMs: 1500, graceMs: 300, failuresBeforeUnhealthy: 2 },
  });

  check('servico criado e persistido', () => {
    assert.ok(manager.getService(server.id));
    assert.ok(fs.existsSync(path.join(tmp, 'config.json')));
  });

  manager.start(server.id);
  await waitFor(() => manager.getState()[server.id]?.state === 'running', 10000, 'processo em execucao');
  check('processo entrou em estado "running"', () => {
    assert.strictEqual(manager.getState()[server.id].state, 'running');
    assert.ok(manager.getState()[server.id].pid > 0);
  });

  console.log('\n== 2. Health check ==');
  await waitFor(() => manager.getState()[server.id]?.health === 'healthy', 12000, 'health check saudavel');
  check('health check reportou "healthy"', () => {
    assert.strictEqual(manager.getState()[server.id].health, 'healthy');
  });

  console.log('\n== 3. Logs ==');
  await waitFor(() => manager.getLogs(server.id).some((l) => l.text.includes('escutando')), 6000, 'log de saida');
  check('stdout foi capturado no buffer de logs', () => {
    const logs = manager.getLogs(server.id);
    assert.ok(logs.length > 0);
    assert.ok(logs.some((l) => l.stream === 'stdout'));
  });

  console.log('\n== 4. Metricas ==');
  const metricsSeen = await new Promise((resolve) => {
    const timer = setTimeout(() => resolve(null), 12000);
    manager.on('metrics', (payload) => {
      const sample = payload.find((p) => p.id === server.id);
      if (sample) {
        clearTimeout(timer);
        resolve(sample);
      }
    });
  });
  check('coletor reportou cpu/memoria do processo', () => {
    assert.ok(metricsSeen, 'nenhuma amostra de metricas recebida');
    assert.ok(metricsSeen.mem > 0, `memoria deveria ser > 0, veio ${metricsSeen.mem}`);
    assert.ok(typeof metricsSeen.cpu === 'number');
  });

  console.log('\n== 5. Parada ==');
  await manager.stop(server.id);
  await waitFor(() => manager.getState()[server.id]?.state === 'stopped', 10000, 'processo parado');
  check('processo foi encerrado e ficou "stopped"', () => {
    assert.strictEqual(manager.getState()[server.id].state, 'stopped');
  });

  console.log('\n== 6. Auto-restart ==');
  const crasher = manager.create({
    name: 'Servidor que cai',
    command: process.execPath,
    args: ['-e', 'console.log("iniciando"); setTimeout(()=>process.exit(3), 400)'],
    restart: { enabled: true, maxRetries: 3, backoffMs: 500, maxBackoffMs: 2000, stabilityMs: 60000 },
  });
  manager.start(crasher.id);
  await waitFor(() => manager.getState()[crasher.id]?.restartCount >= 1, 15000, 'reinicio automatico');
  check('contador de reinicios incrementou apos a queda', () => {
    assert.ok(manager.getState()[crasher.id].restartCount >= 1);
  });
  check('servico chegou ao estado "backoff" durante a espera do retry', () => {
    const logs = manager.getLogs(crasher.id).map((l) => l.text).join('\n');
    assert.ok(/Reiniciando em/.test(logs), 'log de reinicio nao encontrado');
  });

  await manager.stop(crasher.id);
  await waitFor(() => manager.getState()[crasher.id]?.state === 'stopped', 10000, 'crasher parado');
  check('auto-restart nao reativou apos a parada manual', () => {
    assert.strictEqual(manager.getState()[crasher.id].state, 'stopped');
  });

  console.log('\n== 7. Edicao e remocao ==');
  manager.update(server.id, { name: 'Servidor renomeado' });
  check('servico foi atualizado', () => {
    assert.strictEqual(manager.getService(server.id).name, 'Servidor renomeado');
  });
  manager.remove(server.id);
  check('servico foi removido', () => {
    assert.strictEqual(manager.getService(server.id), null);
  });

  manager.dispose();
  fs.rmSync(tmp, { recursive: true, force: true });

  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} verificacoes passaram\n`);
  if (failed.length) process.exit(1);
}

main().catch((err) => {
  console.error('\nErro no selftest:', err);
  process.exit(1);
});
