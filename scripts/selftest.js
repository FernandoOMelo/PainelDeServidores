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
const { execFile, spawn } = require('node:child_process');

const { Store } = require('../electron/store');
const { ServiceManager } = require('../electron/service-manager');
const { findEmbeddedNodes } = require('../electron/executables');
const { WindowsServiceClient } = require('../electron/windows-service');

const PORT = 45999;
const EXTERNAL_PORT = 45998;
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
    if (await predicate()) return true;
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

  console.log('\n== 8. Node customizado por servico ==');
  const customNode = manager.create({
    name: 'Servico com node proprio',
    command: 'node',
    args: ['-e', 'console.log("VERSAO=" + process.version)'],
    nodePath: process.execPath,
    health: { type: 'none' },
  });
  manager.start(customNode.id);
  await waitFor(
    () => manager.getLogs(customNode.id).some((l) => l.text.startsWith('VERSAO=')),
    10000,
    'log do node customizado'
  );
  check('servico com node customizado executou', () => {
    const logs = manager.getLogs(customNode.id).map((l) => l.text).join('\n');
    assert.ok(/VERSAO=v/.test(logs), `esperado VERSAO=v..., veio: ${logs.slice(0, 200)}`);
  });
  check('versao do node detectada e exposta no estado', async () => {
    const state = manager.getState()[customNode.id];
    assert.ok(state.nodeVersion, 'nodeVersion nao informado');
    assert.ok(state.nodeVersion.startsWith('v'), `versao inesperada: ${state.nodeVersion}`);
  });

  // Descoberta de node embarcado na pasta do projeto.
  const fakeProject = path.join(tmp, 'projeto');
  fs.mkdirSync(path.join(fakeProject, 'node'), { recursive: true });
  fs.writeFileSync(path.join(fakeProject, 'node', 'node.exe'), '');
  fs.mkdirSync(path.join(fakeProject, 'runtime', 'nodejs'), { recursive: true });
  fs.writeFileSync(path.join(fakeProject, 'runtime', 'nodejs', 'node.exe'), '');

  const embedded = findEmbeddedNodes(fakeProject);
  check('node embarcado encontrado na pasta do projeto', () => {
    assert.ok(embedded.length >= 1, 'nenhum node embarcado encontrado');
    assert.ok(
      embedded.some((exe) => exe.endsWith(path.join('node', 'node.exe'))),
      `esperado node/node.exe, veio: ${embedded.join(', ')}`
    );
  });
  check('node embarcado tambem encontrado em subdiretórios', () => {
    assert.ok(
      embedded.some((exe) => exe.includes(path.join('runtime', 'nodejs'))),
      `esperado runtime/nodejs/node.exe, veio: ${embedded.join(', ')}`
    );
  });
  check('pasta sem node embarcado devolve lista vazia', () => {
    assert.strictEqual(findEmbeddedNodes(path.join(tmp, 'vazio-inexistente')).length, 0);
  });
  await manager.stop(customNode.id);
  await waitFor(() => manager.getState()[customNode.id]?.state === 'stopped', 8000, 'node customizado parado');
  manager.remove(customNode.id);

  const otherNode = findAlternateNode(process.execPath);
  if (otherNode) {
    console.log(`   (alternativa encontrada: ${otherNode})`);
    const a = manager.create({
      name: 'Node A',
      command: 'node',
      args: ['-e', 'console.log("VERSAO=" + process.version)'],
      nodePath: process.execPath,
    });
    const b = manager.create({
      name: 'Node B',
      command: 'node',
      args: ['-e', 'console.log("VERSAO=" + process.version)'],
      nodePath: otherNode,
    });
    manager.start(a.id);
    manager.start(b.id);
    await waitFor(
      () =>
        manager.getState()[a.id]?.nodeVersion &&
        manager.getState()[b.id]?.nodeVersion &&
        manager.getLogs(a.id).some((l) => l.text.startsWith('VERSAO=')) &&
        manager.getLogs(b.id).some((l) => l.text.startsWith('VERSAO=')),
      15000,
      'duas versoes de node em paralelo'
    );
    check('duas versoes de node rodam em paralelo com versoes distintas', () => {
      const versionA = manager.getState()[a.id].nodeVersion;
      const versionB = manager.getState()[b.id].nodeVersion;
      assert.ok(versionA && versionB, `versoes ausentes: ${versionA} / ${versionB}`);
      assert.notStrictEqual(versionA, versionB, `as duas versoes should differ: ${versionA} vs ${versionB}`);
    });
    await manager.stop(a.id);
    await manager.stop(b.id);
    manager.remove(a.id);
    manager.remove(b.id);
  } else {
    console.log('   (nenhuma versao alternativa de node encontrada - pulando o teste de paralelismo)');
  }

  console.log('\n== 9. Docker ==');
  const dockerStatus = await manager.docker.availability();
  check('docker CLI responde', () => {
    assert.strictEqual(dockerStatus.ok, true, dockerStatus.error);
  });

  if (dockerStatus.ok) {
    const containerName = `painel-selftest-${process.pid}`;
    await runDocker(['rm', '-f', containerName]);
    await runDocker(['run', '-d', '--name', containerName, 'alpine:latest', 'sleep', '300']);

    const container = manager.create({
      name: 'Container de teste',
      type: 'docker',
      container: containerName,
    });
    manager.start(container.id);
    await waitFor(
      () => manager.getState()[container.id]?.containerState === 'running',
      25000,
      'container rodando'
    );
    check('container subiu e o estado foi detectado', () => {
      const state = manager.getState()[container.id];
      assert.strictEqual(state.state, 'running');
      assert.strictEqual(state.containerState, 'running');
    });

    const metricsSeen = await new Promise((resolve) => {
      const timer = setTimeout(() => resolve(null), 20000);
      manager.on('metrics', (payload) => {
        const sample = payload.find((p) => p.id === container.id);
        if (sample) {
          clearTimeout(timer);
          resolve(sample);
        }
      });
    });
    check('metricas do container coletadas (cpu/memoria)', () => {
      assert.ok(metricsSeen, 'nenhuma amostra de metricas do container');
      assert.ok(typeof metricsSeen.cpu === 'number');
      assert.ok(typeof metricsSeen.mem === 'number');
    });

    await manager.stop(container.id);
    await waitFor(() => manager.getState()[container.id]?.state === 'stopped', 25000, 'container parado');
    check('container foi encerrado', () => {
      assert.strictEqual(manager.getState()[container.id].state, 'stopped');
    });

    manager.remove(container.id);
    await runDocker(['rm', '-f', containerName]);
  }

  console.log('\n== 10. Servico iniciado fora do painel (somente monitorar) ==');
  // Simula um servidor que NAO foi iniciado pelo painel (ex.: um .exe que
  // gerencia a API). O painel deve detectar que ele esta online.
  const external = spawn(process.execPath, [
    '-e',
    `require('http').createServer((q,s)=>s.end('ok')).listen(${EXTERNAL_PORT},()=>console.log('externo no ar'))`,
  ]);
  external.stdout.resume();
  external.stderr.resume();
  await waitFor(() => isPortListening(EXTERNAL_PORT), 10000, 'servidor externo no ar');

  const watched = manager.create({
    name: 'API externa (gerida por outro app)',
    type: 'processo',
    command: '',
    monitorOnly: true,
    health: {
      type: 'http',
      port: EXTERNAL_PORT,
      path: '/',
      expectStatus: 200,
      intervalMs: 1000,
      timeoutMs: 1500,
      graceMs: 0,
      failuresBeforeUnhealthy: 2,
    },
  });
  check('servico somente monitorar foi criado sem comando', () => {
    assert.ok(manager.getService(watched.id));
    assert.strictEqual(manager.getService(watched.id).monitorOnly, true);
  });

  await waitFor(
    () => manager.getState()[watched.id]?.health === 'healthy',
    12000,
    'health check detectando o servico externo online'
  );
  check('painel detectou que o servico externo esta online', () => {
    assert.strictEqual(manager.getState()[watched.id].health, 'healthy');
  });
  check('painel nao assumiu o controle do processo externo', () => {
    const state = manager.getState()[watched.id];
    assert.strictEqual(state.pid, null, 'o painel nao deve ter PID de um servico que nao iniciou');
    assert.notStrictEqual(state.state, 'running', 'o painel nao deve marcar como running um servico que nao iniciou');
  });
  check('health check identifica quem responde na porta', () => {
    const detail = manager.getState()[watched.id].healthDetail;
    assert.ok(detail, 'sem detalhe do health check');
    assert.ok(detail.owner, 'health check nao informou o dono da porta');
    assert.ok(detail.owner.pid > 0, 'dono da porta sem pid');
  });

  external.kill();
  await waitFor(
    () => manager.getState()[watched.id]?.health === 'unhealthy',
    15000,
    'health check detectando a queda do servico externo'
  );
  check('painel detectou que o servico externo caiu', () => {
    assert.strictEqual(manager.getState()[watched.id].health, 'unhealthy');
  });

  manager.remove(watched.id);

  console.log('\n== 11. Servicos do Windows ==');
  if (process.platform !== 'win32') {
    console.log('   (ignorado: so Windows)');
  } else {
    const client = new WindowsServiceClient();
    const all = await client.list();
    check('lista de servicos do Windows obtida', () => {
      assert.ok(Array.isArray(all), 'lista invalida');
      assert.ok(all.length > 0, 'nenhum servico encontrado');
    });

    const running = all.find((s) => s.state === 'Running' && s.pid);
    if (running) {
      const t = Date.now();
      const info = await client.get(running.name);
      check('estado e PID de um servico em execucao', () => {
        assert.ok(info, `servico ${running.name} nao encontrado`);
        assert.strictEqual(info.state, 'Running');
        assert.ok(info.pid > 0, 'pid nao informado');
      });
      console.log(`   (consulta em ${Date.now() - t}ms)`);

      // Monitora sem controlar: o painel nao pode agir sobre o servico.
      const watchedService = manager.create({
        name: `Servico ${running.name}`,
        type: 'servico',
        service: running.name,
        monitorOnly: true,
      });
      await waitFor(
        () => manager.getState()[watchedService.id]?.state === 'running',
        15000,
        'servico do windows detectado em execucao'
      );
      check('painel detectou o servico do Windows em execucao', () => {
        const state = manager.getState()[watchedService.id];
        assert.strictEqual(state.state, 'running');
        assert.strictEqual(state.serviceState, 'Running');
        assert.ok(state.pid > 0, 'pid do servico nao informado');
      });
      manager.remove(watchedService.id);
    } else {
      console.log('   (nenhum servico em execucao para monitorar)');
    }

    // Sem permissao de administracao, o SCM recusa. O app precisa dizer isso
    // com clareza em vez de falhar de forma obscura.
    const stopped = all.find((s) => s.state !== 'Running');
    if (stopped) {
      const result = await client.stop(stopped.name);
      check('tentativa de parar sem permissao retorna erro claro', () => {
        assert.strictEqual(result.ok, false);
        assert.ok(result.error, 'sem mensagem de erro');
        assert.ok(
          result.needsElevation || result.code === 1062,
          `esperado necessidade de elevacao ou servico parado, veio codigo ${result.code}`
        );
      });
    }
  }

  manager.dispose();
  fs.rmSync(tmp, { recursive: true, force: true });

  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} verificacoes passaram\n`);
  if (failed.length) process.exit(1);
}

/** Verifica se ha algo escutando na porta local. */
function isPortListening(port) {
  const net = require('node:net');
  return new Promise((resolve) => {
    const socket = net.connect({ port, host: '127.0.0.1' });
    const timer = setTimeout(() => {
      socket.destroy();
      resolve(false);
    }, 700);
    socket.once('connect', () => {
      clearTimeout(timer);
      socket.destroy();
      resolve(true);
    });
    socket.once('error', () => {
      clearTimeout(timer);
      resolve(false);
    });
  });
}

/** Procura outra instalacao de node (nvm, nodejs padrao) para o teste de paralelismo. */
function findAlternateNode(currentExe) {
  const candidates = [];
  const roots = [process.env.NVM_HOME, path.join(os.homedir(), 'AppData', 'Local', 'nvm'), 'C:\\nvm4w']
    .filter(Boolean);

  for (const root of roots) {
    try {
      for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
        if (!entry.isDirectory()) continue;
        const exe = path.join(root, entry.name, 'node.exe');
        if (fs.existsSync(exe)) candidates.push(exe);
      }
    } catch {
      /* raiz inacessivel */
    }
  }
  candidates.push('C:\\Program Files\\nodejs\\node.exe');

  return candidates.find((exe) => {
    try {
      return path.resolve(exe) !== path.resolve(currentExe) && fs.existsSync(exe);
    } catch {
      return false;
    }
  });
}

function runDocker(args) {
  return new Promise((resolve) => {
    execFile('docker', args, { windowsHide: true, timeout: 60000 }, () => resolve());
  });
}

main().catch((err) => {
  console.error('\nErro no selftest:', err);
  process.exit(1);
});
