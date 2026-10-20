'use strict';

const { app, BrowserWindow, ipcMain, protocol, net, shell, Menu, Tray, nativeImage } = require('electron');
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
let tray = null;
let isQuitting = false;

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

/* ------------------------------------------------------------------ */
/* Janela                                                              */
/* ------------------------------------------------------------------ */

/**
 * Cria a janela do painel. Ela e destruida (nao apenas escondida) quando o
 * usuario fecha, para liberar a memoria do renderer - o app continua
 * monitorando os servicos em segundo plano, na bandeja.
 */
function createWindow({ show = true } = {}) {
  if (mainWindow && !mainWindow.isDestroyed()) return mainWindow;

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

  mainWindow.once('ready-to-show', () => {
    if (show) mainWindow.show();
  });

  // Com renderizacao por software o 'ready-to-show' pode nao disparar, e a
  // janela so apareceria no fallback de 5s. O 'dom-ready' chega antes e a
  // cor de fundo ja esta aplicada, entao nao ha flash branco.
  mainWindow.webContents.once('dom-ready', () => {
    if (show && mainWindow && !mainWindow.isDestroyed() && !mainWindow.isVisible()) {
      mainWindow.show();
    }
  });

  if (IS_DEV) {
    // Repassa mensagens do renderer para o terminal, uteis durante o desenvolvimento.
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
    if (mainWindow && !mainWindow.isDestroyed() && show && !mainWindow.isVisible()) {
      mainWindow.show();
      console.warn('[app] janela exibida por fallback (renderer nao sinalizou ready-to-show)');
    }
  }, 5000).unref?.();

  mainWindow.on('close', (event) => {
    if (!mainWindow || mainWindow.isDestroyed()) return;

    store.setSetting('windowBounds', mainWindow.getNormalBounds());

    if (isQuitting) return;

    // Fechar a janela nao encerra o app: ele vai para a bandeja.
    event.preventDefault();
    hideToTray();
  });

  mainWindow.on('closed', () => {
    mainWindow = null;
  });

  // Links externos abrem no navegador padrao, nunca dentro do app.
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: 'deny' };
  });

  return mainWindow;
}

/** Destroi a janela, liberando a memoria do renderer. */
function hideToTray() {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  mainWindow.destroy();
  mainWindow = null;
  showTrayHint();
}

/** Abre (ou re-cria) a janela do painel. */
function showWindow() {
  if (!mainWindow || mainWindow.isDestroyed()) {
    createWindow({ show: true });
    return;
  }
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.show();
  mainWindow.focus();
}

function broadcast(channel, payload) {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send(channel, payload);
  }
}

/* ------------------------------------------------------------------ */
/* Bandeja                                                             */
/* ------------------------------------------------------------------ */

function createTray() {
  const iconPath = path.join(APP_ROOT, 'assets', 'tray-icon.png');
  const image = nativeImage.createFromPath(iconPath);
  if (!image.isEmpty()) image.resize({ width: 16, height: 16 });

  tray = new Tray(image);
  tray.setToolTip('Painel de Servidores');
  tray.setContextMenu(buildTrayMenu());

  tray.on('click', () => showWindow());
  tray.on('double-click', () => showWindow());
}

function buildTrayMenu() {
  const state = manager?.getState() || {};
  const counts = { running: 0, stopped: 0, other: 0 };
  for (const service of manager?.services || []) {
    const status = state[service.id]?.state;
    if (status === 'running') counts.running += 1;
    else if (status === 'stopped') counts.stopped += 1;
    else counts.other += 1;
  }

  return Menu.buildFromTemplate([
    { label: 'Abrir painel', click: () => showWindow() },
    { type: 'separator' },
    {
      label: `${counts.running} rodando · ${counts.stopped} parados${counts.other ? ` · ${counts.other} outros` : ''}`,
      enabled: false,
    },
    { type: 'separator' },
    { label: 'Iniciar todos', click: () => manager?.startAll() },
    { label: 'Parar todos', click: () => manager?.stopAll() },
    { type: 'separator' },
    {
      label: 'Iniciar com o Windows',
      type: 'checkbox',
      checked: isAutoStartEnabled(),
      click: (item) => setAutoStart(item.checked),
    },
    { type: 'separator' },
    {
      label: 'Sair',
      click: () => {
        isQuitting = true;
        app.quit();
      },
    },
  ]);
}

function refreshTrayMenu() {
  if (!tray) return;
  tray.setContextMenu(buildTrayMenu());
}

/** Explica uma vez que o app continua rodando na bandeja. */
function showTrayHint() {
  if (!tray) return;
  if (store.getSetting('trayHintShown', false)) return;
  store.setSetting('trayHintShown', true);

  tray.displayBalloon({
    title: 'Painel de Servidores',
    content: 'O painel continua monitorando seus servicos na bandeja. Clique no icone para abrir de novo.',
    iconType: 'info',
  });
}

/* ------------------------------------------------------------------ */
/* Inicializacao automatica com o Windows                              */
/* ------------------------------------------------------------------ */

const autostart = require('./autostart');

let autoStartEnabled = false;

function isAutoStartEnabled() {
  return autoStartEnabled;
}

function setAutoStart(enabled) {
  return autostart
    .setEnabled(enabled)
    .then(async (active) => {
      autoStartEnabled = active;
      store.setSetting('autoStart', active);
      refreshTrayMenu();
      return active;
    })
    .catch((err) => {
      console.error('[app] nao foi possivel alterar a inicializacao automatica:', err.message);
      return autoStartEnabled;
    });
}

/* ------------------------------------------------------------------ */
/* Ciclo de vida                                                       */
/* ------------------------------------------------------------------ */

app.disableHardwareAcceleration();
app.whenReady().then(() => {
  const configPath = app.isPackaged
    ? path.join(app.getPath('userData'), 'config.json')
    : path.join(APP_ROOT, 'config.local.json');

  store = new Store(configPath);
  manager = new ServiceManager(store, { logDir: path.join(APP_ROOT, 'logs'), appRoot: APP_ROOT });

  registerProtocol();
  registerIpc({
    manager,
    store,
    listListeningPorts,
    isPortOpen,
    app,
    hideWindow: hideToTray,
    isAutoStartEnabled,
    setAutoStart,
  });

  manager.on('state', (snapshot) => {
    broadcast('svc:state', snapshot);
    refreshTrayMenu();
  });
  manager.on('log', (payload) => broadcast('svc:log', payload));
  manager.on('health', (payload) => broadcast('svc:health', payload));
  manager.on('metrics', (payload) => broadcast('svc:metrics', payload));
  manager.on('notice', (payload) => broadcast('svc:notice', payload));
  manager.on('services-changed', (payload) => {
    broadcast('svc:list', payload);
    refreshTrayMenu();
  });

  createTray();
  manager.init();

  // Estado inicial da inicializacao automatica (leitura do registro).
  autostart.isEnabled().then((active) => {
    autoStartEnabled = active;
    refreshTrayMenu();
  });

  // --hidden: subir direto na bandeja, sem abrir a janela.
  const startedHidden = process.argv.includes('--hidden');
  createWindow({ show: !startedHidden });

  app.on('activate', () => showWindow());
});

app.on('before-quit', () => {
  isQuitting = true;
  manager?.dispose();
});

app.on('window-all-closed', () => {
  // Com bandeja o app continua rodando mesmo sem janela.
  if (!tray && process.platform !== 'darwin') app.quit();
});
