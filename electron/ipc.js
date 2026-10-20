'use strict';

const { ipcMain, BrowserWindow } = require('electron');

/**
 * Registra os handlers IPC. Toda a comunicacao renderer -> main passa por
 * aqui; o renderer nunca tem acesso direto ao Node.
 */
function registerIpc({ manager, store, listListeningPorts, isPortOpen }) {
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

  handle('shell:show-item', (_filePath) => {
    // Mantido para futuras integracoes com "abrir pasta do servico".
  });
}

module.exports = { registerIpc };
