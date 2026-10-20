'use strict';

const { execFile } = require('node:child_process');

/**
 * Cliente dos servicos do Windows (Service Control Manager).
 *
 * Leitura (estado, PID, modo de inicializacao) funciona sempre.
 * Iniciar/parar exige permissao no SCM - sem elevacao o Windows devolve
 * "Acesso negado" (erro 5), e o app trata isso com uma mensagem clara.
 */
class WindowsServiceClient {
  constructor(options = {}) {
    this.scBinary = options.scBinary || 'sc.exe';
    this._listCache = null;
  }

  exec(binary, args, timeout = 30000) {
    return new Promise((resolve) => {
      execFile(
        binary,
        args,
        { windowsHide: true, timeout, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 },
        (err, stdout, stderr) => {
          resolve({
            code: err?.code ?? 0,
            stdout: stdout || '',
            stderr: stderr || '',
          });
        }
      );
    });
  }

  /** Todos os servicos, com estado, PID e modo de inicializacao. */
  async list() {
    if (this._listCache && Date.now() - this._listCache.at < 10000) {
      return this._listCache.rows;
    }

    const script = [
      'Get-CimInstance Win32_Service',
      '| Select-Object Name,DisplayName,State,StartMode,ProcessId,PathName',
      '| ConvertTo-Json -Compress -Depth 2',
    ].join(' ');

    const { stdout, code } = await this.exec(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script],
      30000
    );

    if (code !== 0 || !stdout.trim()) return [];

    let parsed;
    try {
      parsed = JSON.parse(stdout);
    } catch {
      return [];
    }

    const rows = (Array.isArray(parsed) ? parsed : [parsed]).map((row) => ({
      name: row.Name,
      displayName: row.DisplayName,
      state: row.State,
      startMode: row.StartMode,
      pid: row.ProcessId || null,
      path: row.PathName,
    }));

    this._listCache = { at: Date.now(), rows };
    return rows;
  }

  /**
   * Detalhes de UM servico, via sc.exe queryex.
   *
   * O sc.exe devolve o estado como numero e o PID, em ~40ms - tres vezes
   * mais rapido que consultar o CIM (que leva >1s por consulta). O estado
   * numerico tambem independe do idioma do Windows. Os dados de exibicao
   * (nome, modo de inicializacao, caminho) vem da listagem, que fica em cache.
   */
  async get(name) {
    const { code, stdout } = await this.exec(this.scBinary, ['queryex', name], 15000);
    if (code !== 0) return null;

    const lines = stdout
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean);

    // Linha 3 do sc.exe e sempre o estado (nome, tipo, estado...).
    const stateMatch = lines[2]?.match(/:\s*(\d+)/);
    const stateNumber = stateMatch ? Number(stateMatch[1]) : null;
    const pidMatch = stdout.match(/PID\s*:\s*(\d+)/i);
    const pid = pidMatch ? Number(pidMatch[1]) : null;

    const details = (await this.list().catch(() => [])).find((s) => s.name === name);

    return {
      name,
      displayName: details?.displayName ?? name,
      state: STATE_NAMES[stateNumber] ?? 'Unknown',
      stateNumber,
      startMode: details?.startMode ?? null,
      pid: pid || null,
      path: details?.path ?? null,
    };
  }

  async start(name) {
    return this.#control(['start', name]);
  }

  async stop(name) {
    return this.#control(['stop', name]);
  }

  /** Reinicia: para (esperando parar) e sobe de novo. */
  async restart(name) {
    const stopped = await this.#control(['stop', name]);
    if (!stopped.ok && stopped.code !== 1062) return stopped;
    await this.#waitForState(name, ['Stopped'], 30000);
    return this.#control(['start', name]);
  }

  /** Executa um comando do sc.exe e traduz o codigo de saida. */
  async #control(args) {
    const { code, stdout, stderr } = await this.exec(this.scBinary, args, 60000);
    const output = `${stdout}\n${stderr}`.trim();

    if (code === 0) return { ok: true, code, output };

    return {
      ok: false,
      code,
      output,
      error: translateScError(code, output),
      // Erro 5 = sem permissao no SCM: o app precisa rodar como administrador.
      needsElevation: code === 5,
    };
  }

  /** Aguarda o servico chegar a um dos estados esperados. */
  async #waitForState(name, expected, timeoutMs = 30000) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const info = await this.get(name);
      if (info && expected.includes(info.state)) return info;
      await new Promise((resolve) => setTimeout(resolve, 700));
    }
    return null;
  }

  /** Espera o servico chegar ao estado Running apos um start. */
  waitForRunning(name, timeoutMs = 60000) {
    return this.#waitForState(name, ['Running'], timeoutMs);
  }
}

/** Estado numerico do sc.exe -> nome oficial do estado. */
const STATE_NAMES = {
  1: 'Stopped',
  2: 'Start Pending',
  3: 'Stop Pending',
  4: 'Running',
  5: 'Continue Pending',
  6: 'Pause Pending',
  7: 'Paused',
};

/** Traduz os codigos do sc.exe em mensagens uteis. */
function translateScError(code, output) {
  switch (code) {
    case 5:
      return 'Acesso negado ao abrir o servico. Reinicie o painel como administrador para poder iniciar ou parar servicos do Windows.';
    case 1056:
      return 'O servico ja esta em execucao.';
    case 1057:
      return 'O servico nao foi iniciado.';
    case 1058:
      return 'O servico esta desabilitado.';
    case 1060:
      return 'O servico nao existe.';
    case 1061:
      return 'O servico foi marcado para exclusao.';
    case 1062:
      return 'O servico nao esta em execucao.';
    case 1053:
      return 'O servico nao respondeu a tempo para iniciar ou parar.';
    default:
      return output || `Falha (codigo ${code}) ao controlar o servico.`;
  }
}

module.exports = { WindowsServiceClient, translateScError };
