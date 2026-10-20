'use strict';

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { spawn } = require('node:child_process');
const { EventEmitter } = require('node:events');

/**
 * Coleta CPU/memoria dos processos filhos em amostragem periodica.
 *
 * Windows: um PowerShell persistente le um arquivo com a lista de PIDs a cada
 * ciclo e imprime uma linha "pid|cpuSegundos|memoriaBytes" por processo.
 * POSIX: loop equivalente usando `ps`.
 *
 * O arquivo de PIDs e reescrito sempre que a lista muda, evitando reiniciar
 * o processo coletor a cada start/stop de servico.
 */
class MetricsCollector extends EventEmitter {
  constructor(options = {}) {
    super();
    this.intervalMs = options.intervalMs ?? 2000;
    this.dir = options.dir || os.tmpdir();
    this.pidFile = path.join(this.dir, `painel-servidores-pids-${process.pid}.txt`);
    this.pids = new Map(); // id do servico -> pid
    this.previous = new Map(); // pid -> { cpu, ts }
    this.child = null;
    this.buffer = '';
  }

  setPids(entries) {
    const next = new Map(entries.filter(([, pid]) => pid).map(([id, pid]) => [id, pid]));
    const changed =
      next.size !== this.pids.size || [...next].some(([id, pid]) => this.pids.get(id) !== pid);
    this.pids = next;
    if (changed) this.#writePidFile();
  }

  #writePidFile() {
    try {
      fs.writeFileSync(this.pidFile, [...this.pids.values()].join('\n'), 'utf8');
    } catch (err) {
      console.error('[metrics] falha ao escrever arquivo de pids:', err.message);
    }
  }

  start() {
    if (this.child) return;
    this.#writePidFile();
    const child = process.platform === 'win32' ? this.#startWindows() : this.#startPosix();
    this.attach(child);
    child.on('error', (err) => console.error('[metrics] coletor falhou:', err.message));
    child.on('exit', () => {
      this.child = null;
    });
  }

  #startWindows() {
    const script = [
      `$pidFile = '${this.pidFile.replace(/'/g, "''")}'`,
      'while ($true) {',
      '  $ids = @()',
      '  if (Test-Path $pidFile) {',
      '    $ids = @(Get-Content $pidFile -ErrorAction SilentlyContinue | Where-Object { $_ -match "^\\d+$" })',
      '  }',
      '  if ($ids.Count -gt 0) {',
      '    $out = @(Get-Process -Id $ids -ErrorAction SilentlyContinue | ForEach-Object {',
      '      $cpu = 0; if ($_.CPU -ne $null) { $cpu = $_.CPU }',
      '      "$($_.Id)|$cpu|$($_.WorkingSet64)"',
      '    })',
      '    if ($out.Count -gt 0) { [Console]::Out.WriteLine(($out -join ";")); [Console]::Out.Flush() }',
      '  }',
      `  Start-Sleep -Milliseconds ${Math.max(500, this.intervalMs)}`,
      '}',
    ].join('\n');

    return spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script], {
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  }

  #startPosix() {
    const script = `
pid_file="${this.pidFile}"
while true; do
  ids=$(tr '\\n' ',' < "$pid_file" 2>/dev/null | sed 's/,$//')
  if [ -n "$ids" ]; then
    ps -o pid=,pcpu=,rss= -p "$ids" 2>/dev/null | awk '{print $1"|"$2"|"($3*1024)}'
  fi
  sleep $(awk "BEGIN {print ${this.intervalMs / 1000}}")
done
`;
    return spawn('sh', ['-c', script], { stdio: ['ignore', 'pipe', 'pipe'] });
  }

  attach(child) {
    this.child = child;
    child.stdout?.setEncoding('utf8');
    child.stdout?.on('data', (chunk) => this.#consume(chunk));
    // stderr do coletor nao contem amostras: fica separado para nao corromper o buffer.
    child.stderr?.setEncoding('utf8');
    child.stderr?.on('data', (chunk) => {
      if (!this._stderrSeen) {
        this._stderrSeen = true;
        console.error('[metrics] stderr do coletor:', chunk.slice(0, 400));
      }
    });
  }

  #consume(chunk) {
    this.buffer += chunk;
    const lines = this.buffer.split(/\r?\n/);
    this.buffer = lines.pop() ?? '';
    for (const line of lines) {
      if (!line.trim()) continue;
      this.#processLine(line);
    }
  }

  #processLine(line) {
    const now = Date.now();
    const samples = [];

    for (const chunk of line.split(';')) {
      const [pidRaw, cpuRaw, memRaw] = chunk.split('|');
      const pid = Number(pidRaw);
      if (!pid) continue;

      const cpuTotal = Number(cpuRaw) || 0;
      const memBytes = Number(memRaw) || 0;
      const prev = this.previous.get(pid);
      let cpuPercent = 0;

      if (prev) {
        const elapsed = (now - prev.ts) / 1000;
        if (elapsed > 0) {
          cpuPercent = Math.max(0, ((cpuTotal - prev.cpu) / elapsed) * 100);
        }
      }
      this.previous.set(pid, { cpu: cpuTotal, ts: now });

      samples.push({ pid, cpuPercent: Math.round(cpuPercent * 10) / 10, memBytes });
    }

    if (!samples.length) return;

    const byPid = new Map(samples.map((s) => [s.pid, s]));
    const payload = [];
    for (const [id, pid] of this.pids) {
      const sample = byPid.get(pid);
      if (!sample) continue;
      payload.push({
        id,
        pid,
        cpu: sample.cpuPercent,
        mem: Math.round((sample.memBytes / (1024 * 1024)) * 10) / 10,
      });
    }
    if (payload.length) this.emit('metrics', payload);
  }

  stop() {
    if (this.child) {
      try {
        this.child.kill();
      } catch {
        /* ignorado */
      }
      this.child = null;
    }
    try {
      fs.unlinkSync(this.pidFile);
    } catch {
      /* ignorado */
    }
    this.previous.clear();
  }
}

module.exports = { MetricsCollector };
