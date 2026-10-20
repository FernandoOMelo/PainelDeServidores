'use strict';

/**
 * Verifica o registro de inicializacao automatica com o Windows.
 * Grava a entrada, confere no registro e remove tudo no final.
 *
 *   npx electron scripts/autostart-check.js
 */

const { app } = require('electron');
const path = require('node:path');
const autostart = require('../electron/autostart');

async function main() {
  await app.whenReady();

  const antes = await autostart.readRunEntries();
  console.log('entradas antes :', antes.length);
  console.log('app esta ligado?:', await autostart.isEnabled());

  console.log('\n-> ligando...');
  const ligado = await autostart.setEnabled(true);
  console.log('   isEnabled() =', ligado);

  const durante = await autostart.readRunEntries();
  const propias = await autostart.findOwnEntries();
  console.log('   entradas no registro:', durante.length, '(antes', antes.length + ')');
  console.log('   entrada criada     :', propias[0] || '(nenhuma)');

  console.log('\n-> desligando...');
  const desligado = await autostart.setEnabled(false);
  console.log('   isEnabled() =', desligado);

  const depois = await autostart.readRunEntries();
  console.log('   entradas no registro:', depois.length, '(antes', antes.length + ')');
  console.log('   sobrou entrada do app?', (await autostart.findOwnEntries()).length > 0);

  const ok = ligado === true && desligado === false && depois.length === antes.length;
  console.log('\nRESULTADO:', ok ? 'OK' : 'FALHOU');
  app.exit(ok ? 0 : 1);
}

main();
