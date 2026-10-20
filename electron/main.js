'use strict';

const { app, BrowserWindow, ipcMain, protocol, net, shell, Menu } = require('electron');
const path = require('node:path');
const fs = require('node:fs');
const { execFile } = require('node:child_process');
const { pathToFileURL } = require('node:url');

const { Store } = require('./store');
const { ServiceManager } = require('./service-manager');
const { registerIpc } = require('./ipc');
const { listListeningPorts, isPortOpen } = require('./discovery');

const APP_ROOT = path.resolve(__dirname, '..');
const IS_DEV = !app.isPackaged;

protocol.registerSchemesAsPrivileged([
  {
    scheme: 'app',
    privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true, stream: true },
  },
]);

let mainWindow = null;
let manager = null;
let store = null;

/** Serve os arquivos do renderer via app:// sem depender de file:// (habilita ES modules). */
function registerProtocol() {
  protocol.handle('app', async (request) => {
    const url = new URL(request.url);
    const relPath = decodeURIComponent(url.pathname).replace(/^\/+/, '');
    const filePath = path.join(APP_ROOT, relPath);

    if (!filePath.startsWith(APP_ROOT)) {
      return new Response('Acesso negado', { status: 403 });
    }
    if (!fs.existsSync(filePath)) {
      return new Response('Nao encontrado', { status: 404 });
    }
    return net.fetch(pathToFileURL(filePath).toString());
  });
}

function createWindow() {
  const bounds = store.getSetting('windowBounds', null);

  mainWindow = new BrowserWindow({
    width: bounds?.width ?? 1320,
    height: bounds?.height ?? 860,
    x: bounds?.x,
    y: bounds?.y,
    minWidth: 960,
    minHeight: 600,
    show: false,
    backgroundColor: '#0b0f16',
    title: 'Painel de Servidores',
    icon: path.join(APP_ROOT, 'assets', 'icon.png'),
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      spellcheck: false,
    },
  });

  Menu.setApplicationMenu(null);
  mainWindow.loadURL('app://bundle/src/index.html');

  mainWindow.once('ready-to-show', () => mainWindow.show());

  if (IS_DEV) {
    // Repassa mensagens do renderer para o terminal,uteis durante o desenvolvimento.
    mainWindow.webContents.on('console-message', (event) => {
      const level = ['debug', 'info', 'warning', 'error'][event.level] ?? 'info';
      console.log(`[renderer:${level}] ${event.message}`);
    });
    mainWindow.webContents.on('did-fail-load', (_event, code, description, url) => {
      console.error(`[renderer] falha ao carregar ${url}: ${description} (${code})`);
    });
    mainWindow.webContents.on('did-finish-load', () => {
      console.log('[renderer] pagina carregada');
    });
    mainWindow.webContents.on('preload-error', (_event, file, error) => {
      console.error(`[renderer] erro no preload ${file}:`, error);
    });
    mainWindow.webContents.on('render-process-gone', (_event, details) => {
      console.error('[renderer] processo do renderer encerrado:', JSON.stringify(details));
    });
  }

  // Rede de seguranca: se o renderer travar antes de pintar, a janela
  // aparece mesmo assim (com o estado vazio) em vez de ficar invisivel.
  setTimeout(() => {
    if (mainWindow && !mainWindow.isDestroyed() && !mainWindow.isVisible()) {
      mainWindow.show();
      console.warn('[app] janela exibida por fallback (renderer nao sinalizou ready-to-show)');
    }
  }, 5000).unref?.();

  mainWindow.on('close', () => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      store.setSetting('windowBounds', mainWindow.getNormalBounds());
    }
  });

  mainWindow.on('closed', () => {
    mainWindow = null;
  });

  // Links externos abrem no navegador padrao, nunca dentro do app.
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: 'deny' };
  });
}

function broadcast(channel, payload) {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send(channel, payload);
  }
}

app.whenReady().then(() => {
  const configPath = app.isPackaged
    ? path.join(app.getPath('userData'), 'config.json')
    : path.join(APP_ROOT, 'config.local.json');

  store = new Store(configPath);
  manager = new ServiceManager(store, { logDir: path.join(APP_ROOT, 'logs'), appRoot: APP_ROOT });

  registerProtocol();
  registerIpc({ manager, store, listListeningPorts, isPortOpen, app });

  manager.on('state', (snapshot) => broadcast('svc:state', snapshot));
  manager.on('log', (payload) => broadcast('svc:log', payload));
  manager.on('health', (payload) => broadcast('svc:health', payload));
  manager.on('metrics', (payload) => broadcast('svc:metrics', payload));
  manager.on('notice', (payload) => broadcast('svc:notice', payload));
  manager.on('services-changed', (payload) => broadcast('svc:list', payload));

  createWindow();
  manager.init();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('before-quit', () => {
  manager?.dispose();
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
