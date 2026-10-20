'use strict';

const { contextBridge, ipcRenderer } = require('electron');

const invoke = async (channel, ...args) => {
  const result = await ipcRenderer.invoke(channel, ...args);
  if (!result?.ok) throw new Error(result?.error || 'Falha na comunicacao com o processo principal.');
  return result.data;
};

const subscribe = (channel, callback) => {
  const listener = (_event, payload) => callback(payload);
  ipcRenderer.on(channel, listener);
  return () => ipcRenderer.removeListener(channel, listener);
};

contextBridge.exposeInMainWorld('api', {
  services: {
    list: () => invoke('services:list'),
    state: () => invoke('services:state'),
    create: (definition) => invoke('services:create', definition),
    update: (id, definition) => invoke('services:update', id, definition),
    remove: (id) => invoke('services:remove', id),
    start: (id) => invoke('services:start', id),
    stop: (id) => invoke('services:stop', id),
    restart: (id) => invoke('services:restart', id),
    startAll: () => invoke('services:start-all'),
    stopAll: () => invoke('services:stop-all'),
    logs: (id) => invoke('services:logs', id),
    clearLogs: (id) => invoke('services:clear-logs', id),
  },
  settings: {
    get: () => invoke('settings:get'),
    set: (key, value) => invoke('settings:set', key, value),
  },
  discovery: {
    scan: () => invoke('discovery:scan'),
  },
  docker: {
    status: () => invoke('docker:status'),
    containers: () => invoke('docker:containers'),
  },
  servico: {
    list: () => invoke('servico:list'),
  },
  app: {
    relaunchElevated: () => invoke('app:relaunch-elevated'),
    isElevated: () => invoke('app:is-elevated'),
  },
  node: {
    version: (nodePath) => invoke('node:version', nodePath),
    discover: (cwd) => invoke('node:discover', cwd),
  },
  on: {
    state: (cb) => subscribe('svc:state', cb),
    log: (cb) => subscribe('svc:log', cb),
    health: (cb) => subscribe('svc:health', cb),
    metrics: (cb) => subscribe('svc:metrics', cb),
    notice: (cb) => subscribe('svc:notice', cb),
    list: (cb) => subscribe('svc:list', cb),
  },
});
