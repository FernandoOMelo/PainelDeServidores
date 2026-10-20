'use strict';

const net = require('node:net');
const http = require('node:http');
const https = require('node:https');
const { EventEmitter } = require('node:events');

/**
 * Monitora a saude de um servico: porta TCP, endpoint HTTP ou nada.
 * Emite 'result' a cada verificacao e 'unhealthy' quando o limiar de
 * falhas consecutivas for ultrapassado.
 */
class HealthMonitor extends EventEmitter {
  constructor(service) {
    super();
    this.service = service;
    this.state = 'unknown'; // unknown | healthy | unhealthy
    this.consecutiveFailures = 0;
    this.lastResult = null;
    this._timer = null;
  }

  start() {
    this.stop();
    const interval = this.service.health?.intervalMs ?? 5000;
    this._timer = setInterval(() => {
      this.check().catch(() => {});
    }, interval);
    this._timer.unref?.();
  }

  stop() {
    if (this._timer) {
      clearInterval(this._timer);
      this._timer = null;
    }
  }

  reset() {
    this.state = 'unknown';
    this.consecutiveFailures = 0;
    this.lastResult = null;
  }

  async check() {
    const health = this.service.health || {};
    if (health.type === 'none' || !health.port) {
      return { ok: true, state: 'unknown', latencyMs: 0 };
    }

    const started = Date.now();
    let result;
    try {
      if (health.type === 'tcp') {
        result = await this.#checkTcp(health.port, health.timeoutMs);
      } else {
        result = await this.#checkHttp(health);
      }
    } catch (err) {
      result = { ok: false, error: err.message };
    }

    result.latencyMs = Date.now() - started;
    result.checkedAt = Date.now();
    this.lastResult = result;

    if (result.ok) {
      this.consecutiveFailures = 0;
      const wasUnhealthy = this.state === 'unhealthy';
      this.state = 'healthy';
      if (wasUnhealthy) this.emit('recovered', result);
    } else {
      this.consecutiveFailures += 1;
      const threshold = health.failuresBeforeUnhealthy ?? 3;
      if (this.consecutiveFailures >= threshold && this.state !== 'unhealthy') {
        this.state = 'unhealthy';
        this.emit('unhealthy', result);
      }
    }

    this.emit('result', { ...result, state: this.state, consecutiveFailures: this.consecutiveFailures });
    return result;
  }

  #checkTcp(port, timeoutMs) {
    return new Promise((resolve, reject) => {
      const socket = net.connect({ port, host: '127.0.0.1' });
      const timer = setTimeout(() => {
        socket.destroy();
        reject(new Error(`timeout apos ${timeoutMs}ms`));
      }, timeoutMs);
      socket.once('connect', () => {
        clearTimeout(timer);
        socket.destroy();
        resolve({ ok: true, status: 'aberta' });
      });
      socket.once('error', (err) => {
        clearTimeout(timer);
        reject(err);
      });
    });
  }

  #checkHttp(health) {
    return new Promise((resolve, reject) => {
      const port = health.port;
      const pathname = health.path || '/';
      const isHttps = health.protocol === 'https';
      const client = isHttps ? https : http;
      const req = client.request(
        {
          host: '127.0.0.1',
          port,
          path: pathname,
          method: 'GET',
          timeout: health.timeoutMs,
          rejectUnauthorized: false,
          headers: { 'user-agent': 'painel-servidores/health' },
        },
        (res) => {
          res.resume();
          const expected = health.expectStatus ?? 200;
          const ok = expected === 0 ? res.statusCode < 400 : res.statusCode === expected;
          if (ok) resolve({ ok: true, status: res.statusCode });
          else reject(new Error(`HTTP ${res.statusCode} (esperado ${expected})`));
        }
      );
      req.on('timeout', () => {
        req.destroy();
        reject(new Error(`timeout apos ${health.timeoutMs}ms`));
      });
      req.on('error', reject);
      req.end();
    });
  }
}

module.exports = { HealthMonitor };
