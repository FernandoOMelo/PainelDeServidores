'use strict';

const { app } = require('electron');
const { execFile } = require('node:child_process');
const path = require('node:path');

const RUN_KEY = 'HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Run';

/**
 * Inicializacao automatica com o Windows.
 *
 * Nao da para confiar so no app.getLoginItemSettings(): no modo dev o
 * Electron grava a chave "electron.app.Electron" (derivada do executavel)
 * mas consulta "electron.app.<nome-do-app>" - o status voltaria sempre
 * desligado. Por isso a leitura e feita direto no registro, casando pelo
 * caminho do executavel.
 */

/** Todas as entradas da chave Run do usuario atual. */
function readRunEntries() {
  const script = [
    `(Get-ItemProperty -Path '${RUN_KEY}' -ErrorAction SilentlyContinue).PSObject.Properties`,
    "| Where-Object { $_.Name -notlike 'PS*' }",
    "| ForEach-Object { \"$($_.Name)=$($_.Value)\" }",
  ].join(' ');

  return new Promise((resolve) => {
    execFile(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script],
      { windowsHide: true, timeout: 15000 },
      (err, stdout) => resolve(err ? [] : stdout.toString().split(/\r?\n/).filter(Boolean))
    );
  });
}

/** Entradas que apontam para o executavel deste app. */
async function findOwnEntries() {
  const exe = process.execPath.toLowerCase();
  const entries = await readRunEntries();
  return entries.filter((line) => line.toLowerCase().includes(exe));
}

/** O app esta configurado para subir com o Windows? */
async function isEnabled() {
  return (await findOwnEntries()).length > 0;
}

/** Argumentos do atalho: em desenvolvimento o caminho do projeto vai junto. */
function loginArgs() {
  const args = [];
  if (!app.isPackaged) args.push(path.resolve(__dirname, '..'));
  args.push('--hidden');
  return args;
}

/** Liga ou desliga a inicializacao automatica. */
async function setEnabled(enabled) {
  if (enabled) {
    app.setLoginItemSettings({
      openAtLogin: true,
      path: process.execPath,
      args: loginArgs(),
    });
  } else {
    app.setLoginItemSettings({ openAtLogin: false });
    await removeOwnEntries();
  }
  return isEnabled();
}

/** Remove do registro as entradas que apontam para este executavel. */
function removeOwnEntries() {
  const exe = process.execPath.toLowerCase().replace(/'/g, "''");
  const script = [
    `$key = '${RUN_KEY}'`,
    '$props = (Get-ItemProperty -Path $key -ErrorAction SilentlyContinue).PSObject.Properties | Where-Object { $_.Name -notlike "PS*" }',
    `foreach ($p in $props) { if ("$($p.Value)".ToLower().Contains('${exe}')) { Remove-ItemProperty -Path $key -Name $p.Name -ErrorAction SilentlyContinue } }`,
  ].join('; ');

  return new Promise((resolve) => {
    execFile(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script],
      { windowsHide: true, timeout: 15000 },
      () => resolve()
    );
  });
}

module.exports = { isEnabled, setEnabled, readRunEntries, findOwnEntries, loginArgs };
