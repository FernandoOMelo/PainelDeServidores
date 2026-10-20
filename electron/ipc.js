'use strict';

const { ipcMain, BrowserWindow } = require('electron');
const { execFile } = require('node:child_process');

/**
 * O processo esta rodando com token elevado (administrador de verdade)?
 * Uma conta do grupo Administradores com token filtrado pelo UAC devolve
 * false aqui - e e exatamente o caso em que iniciar/parar servico do
 * Windows falha com "Acesso negado".
 */
let elevatedCache = null;
function isElevated() {
  if (elevatedCache !== null) return elevatedCache;
  const script = [
    '([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent())',
    '.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)',
  ].join('');

  return new Promise((resolve) => {
    execFile(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script],
      { windowsHide: true, timeout: 10000 },
      (err, stdout) => {
        if (err) {
          elevatedCache = false;
          resolve(false);
          return;
        }
        elevatedCache = String(stdout).trim().toLowerCase() === 'true';
        resolve(elevatedCache);
      }
    );
  });
}

/**
 * Registra os handlers IPC. Toda a comunicacao renderer -> main passa por
 * aqui; o renderer nunca tem acesso direto ao Node.
 */
function registerIpc({ manager, store, listListeningPorts, isPortOpen, app }) {
  const handle = (channel, fn) => {
    ipcMain.handle(channel, async (_event, ...args) => {
      try {
        return { ok: true, data: await fn(...args) };
      } catch (err) {
        return { ok: false, error: err.message };
      }
    });
  };

  handle('services:list', () => manager.list());
  handle('services:state', () => manager.getState());
  handle('services:create', (definition) => manager.create(definition));
  handle('services:update', (id, definition) => manager.update(id, definition));
  handle('services:remove', (id) => manager.remove(id));
  handle('services:start', (id) => manager.start(id));
  handle('services:stop', (id) => manager.stop(id));
  handle('services:restart', (id) => manager.restart(id));
  handle('services:start-all', () => manager.startAll());
  handle('services:stop-all', () => manager.stopAll());
  handle('services:logs', (id) => manager.getLogs(id));
  handle('services:clear-logs', (id) => manager.clearLogs(id));

  handle('settings:get', () => store.settings);
  handle('settings:set', (key, value) => store.setSetting(key, value));

  handle('discovery:scan', async () => {
    const ports = await listListeningPorts();
    const known = new Set(manager.services.map((s) => s.health?.port).filter(Boolean));
    const results = [];
    for (const entry of ports) {
      if (known.has(entry.port)) continue;
      results.push({ ...entry, reachable: await isPortOpen(entry.port) });
    }
    return results;
  });

  handle('docker:status', () => manager.docker.availability());
  handle('docker:containers', () => manager.listContainers());

  handle('servico:list', () => manager.listWindowsServices());

  handle('node:version', (nodePath) => manager.detectNodeVersion(nodePath));
  handle('node:discover', (cwd) => manager.discoverNodes(cwd));

  // Servicos do Windows exigem permissao no SCM. Sem elevacao o Windows
  // devolve "Acesso negado", entao o app oferece reiniciar-se como admin.
  handle('app:is-elevated', () => isElevated());

  handle('app:relaunch-elevated', () => {
    const args = process.argv.slice(1).map((arg) => `'${arg.replace(/'/g, "''")}'`).join(',');
    const exe = process.execPath.replace(/'/g, "''");
    const script = `Start-Process -FilePath '${exe}' -ArgumentList ${args} -Verb RunAs`;

    execFile(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script],
      { windowsHide: true, timeout: 20000 },
      (err) => {
        if (err) {
          console.error('[app] falha ao reiniciar elevado:', err.message);
          return;
        }
        app.quit();
      }
    );
    return true;
  });
}

module.exports = { registerIpc };
