# Painel de Servidores

Aplicativo desktop (Electron) para iniciar, parar e monitorar servidores locais
pela interface grafica, no lugar de varios terminais abertos.

## O que ele faz

- **Cadastro pela propria interface** - cada servico tem nome, grupo, comando,
  argumentos, diretorio de trabalho, variaveis de ambiente e opcoes de
  monitoramento. Tudo e gravado em `config.local.json`.
- **Ciclo de vida** - iniciar, parar, reiniciar, iniciar todos, parar todos.
- **Health check** - verificacao por porta TCP ou por endpoint HTTP (com status
  esperado, intervalo, timeout e janela de espera apos o start).
- **Recuperacao automatica** - quando o processo cai, o painel reinicia com
  backoff exponencial. Também reinicia quando o health check falha
  consecutivamente (configuravel).
- **Logs em tempo real** - stdout e stderr capturados por servico, com buffer
  circular, filtro por texto, auto-scroll e arquivo em `logs/<id>.log`.
- **Metricas** - CPU e memoria por processo, coletadas por amostragem.
- **Descoberta** - varre as portas em escuta da maquina e permite adotar
  servidores que ja rodam fora do painel em modo "somente monitorar".

## Como rodar

```bash
npm install
npm start
```

## Testes

```bash
npm test
```

O selftest sobe o motor sem interface grafica e valida ciclo de vida, health
check, captura de logs, metricas de CPU/memoria, auto-restart com backoff e
edicao/remocao de servicos.

## Configuracao dos servicos

Os servicos ficam em `config.local.json`, na raiz do projeto. Esse arquivo pode
ser editado a mao ou pela propria interface - as duas vias escrevem no mesmo
lugar.

> `config.local.json` e local da maquina e **nao** entra no versionamento
> (esta no `.gitignore`). O arquivo `config.example.json` mostra o formato de
> referencia com um servico de exemplo. Copie-o para `config.local.json` se
> quiser comecar com ele:
>
> ```bash
> cp config.example.json config.local.json
> ```

Formato de um servico:

```json
{
  "id": "api",
  "name": "API Principal",
  "group": "Backend",
  "command": "npm",
  "args": ["run", "dev"],
  "cwd": "C:\\projetos\\api",
  "env": { "PORT": "3000" },
  "shell": false,
  "autostart": true,
  "monitorOnly": false,
  "health": {
    "type": "http",
    "port": 3000,
    "path": "/health",
    "expectStatus": 200,
    "intervalMs": 5000,
    "timeoutMs": 3000,
    "graceMs": 10000,
    "failuresBeforeUnhealthy": 3
  },
  "restart": {
    "enabled": true,
    "maxRetries": 5,
    "backoffMs": 1000,
    "maxBackoffMs": 30000,
    "restartOnUnhealthy": true,
    "stabilityMs": 60000
  }
}
```

- `health.type`: `none`, `tcp` (porta aberta) ou `http` (endpoint com status esperado).
- `restart.enabled`: reinicia o processo quando ele cai, com backoff exponencial.
- `restart.restartOnUnhealthy`: tambem reinicia quando o health check falha
  `failuresBeforeUnhealthy` vezes seguidas.
- `monitorOnly`: servico apenas observado - o painel nao inicia nem para o
  processo (util para servidores que ja rodam fora do painel).
- `cwd`: vazio usa a pasta do app. Caminho **relativo** e resolvido a partir
  dela (o config continua valido se o projeto for movido); caminho absoluto e
  usado como veio. Se o diretorio nao existir, o app avisa no log e usa a
  pasta do app.

## Organizacao do codigo

```
electron/
  main.js             ciclo de vida do app, janela, protocolo app://
  preload.js          ponte contextBridge <-> ipcRenderer
  ipc.js              handlers IPC
  store.js            persistencia em config.local.json + normalizacao
  service-manager.js  orquestra runners, monitores e metricas
  service-runner.js   spawn, captura de logs, stop/restart com backoff
  health-checker.js   verificacoes TCP/HTTP
  metrics.js          coletor de CPU/memoria por processo
  discovery.js        varredura de portas em escuta
src/
  index.html          shell da interface
  styles.css          design system (tema escuro)
  js/
    app.js            orquestrador do renderer
    service-form.js   formulario de cadastro/edicao
    discovery.js      modal de descoberta
    log-panel.js      painel de logs ao vivo
    modal.js          modais genericos e confirmacao
    toast.js          notificacoes
    util.js           helpers de DOM e formatacao
scripts/
  selftest.js         teste funcional do motor
examples/
  api-demo.js         servidor HTTP de exemplo
```

## Notas de implementacao

- O renderer nao tem acesso ao Node: toda comunicacao passa por `preload.js`
  com `contextIsolation` e `sandbox` habilitados.
- Os arquivos do renderer sao servidos via `app://bundle/...` (protocolo
  registrado com `protocol.handle`), o que permite ES modules sem bundler.
- O log e gravado em `logs/<id>.log` e mantido em memoria (buffer circular de
  2000 linhas por padrao, configuravel em `settings.logBufferLines`).
- No Windows, o encerramento de um servico encerra a arvore de processos com
  `taskkill /T /F`; em POSIX usa grupos de processos (`SIGTERM` -> `SIGKILL`).
