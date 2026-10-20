# Painel de Servidores

Aplicativo desktop (Electron) para iniciar, parar e monitorar servidores locais
pela interface grafica, no lugar de varios terminais abertos.

## O que ele faz

- **Cadastro pela propria interface** - cada servico tem nome, grupo, comando,
  argumentos, diretorio de trabalho, variaveis de ambiente e opcoes de
  monitoramento. Tudo e gravado em `config.local.json`.
- **Ciclo de vida** - iniciar, parar, reiniciar, iniciar todos, parar todos.
- **Node proprio por servico** - cada servico pode usar uma versao diferente do
  Node (node embutido no projeto, versao especifica do nvm, etc). A pasta do
  node entra no PATH do processo, entao `npm`, `npx` e os processos filhos usam
  a mesma versao. O painel mostra a versao de cada servico no card. O botao
  **"Procurar na pasta"** localiza o `node.exe` embarcado no diretorio de
  trabalho do servico e preenche o campo sozinho.
- **Docker** - containers podem ser iniciados, parados e reiniciados pelo
  painel, com estado real, HEALTHCHECK, logs ao vivo e metricas de CPU/memoria.
- **Servicos do Windows** - servicos registrados no Windows (Service Control
  Manager) podem ser acompanhados e controlados pelo painel, com estado real
  (incluindo *Paused*), PID, modo de inicializacao e metricas. O painel
  detecta que a conta precisa de permissao e oferece reiniciar-se como
  administrador.
- **Health check** - verificacao por porta TCP ou por endpoint HTTP (com status
  esperado, intervalo, timeout e janela de espera apos o start).
- **Recuperacao automatica** - quando o processo cai, o painel reinicia com
  backoff exponencial. Também reinicia quando o health check falha
  consecutivamente (configuravel).
- **Logs em tempo real** - stdout e stderr capturados por servico, com buffer
  circular, filtro por texto, auto-scroll e arquivo em `logs/<id>.log`.
- **Metricas** - CPU e memoria por processo, coletadas por amostragem.
- **Descoberta** - varre as portas em escuta da maquina e os containers Docker
  existentes, permitindo adotar servidores que ja rodam fora do painel em modo
  "somente monitorar".

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
check, captura de logs, metricas de CPU/memoria, auto-restart com backoff,
edicao/remocao de servicos, node customizado (inclusive duas versoes rodando
em paralelo) e o ciclo de vida de containers Docker.

A parte de Docker exige a CLI do Docker e o daemon em execucao. Sem eles, o
teste de container e ignorado e os demais continuam valendo. A parte de
servicos do Windows so roda no Windows.

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

Formato de um servico de processo:

```json
{
  "id": "api",
  "name": "API Principal",
  "group": "Backend",
  "type": "processo",
  "command": "npm",
  "args": ["run", "dev"],
  "cwd": "C:\\projetos\\api",
  "env": { "PORT": "3000" },
  "shell": false,
  "autostart": true,
  "monitorOnly": false,
  "nodePath": "C:\\Users\\ferna\\AppData\\Local\\nvm\\v18.20.8\\node.exe",
  "container": "",
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

Formato de um servico Docker:

```json
{
  "id": "api-docker",
  "name": "API (docker)",
  "group": "Backend",
  "type": "docker",
  "container": "gameshelfproject-api-1",
  "autostart": false,
  "monitorOnly": false,
  "restart": { "enabled": true, "maxRetries": 3, "backoffMs": 1000, "maxBackoffMs": 30000 }
}
```

- `type`: `processo` (padrao), `docker` ou `servico`.
- `nodePath`: caminho do `node.exe` (ou da pasta que o contem) especifico do
  servico. Vazio usa o node do PATH. A pasta do node e placed no PATH do
  processo, de modo que `npm`, `npx` e os filhos usam a mesma versao - e o que
  permite rodar versoes diferentes ao mesmo tempo.
- `container`: nome do container alvo quando `type` e `docker`.
- `service`: nome do servico do Windows quando `type` e `servico` (o mesmo
  nome que aparece em `services.msc`).
- `health.type`: `none`, `tcp` (porta aberta) ou `http` (endpoint com status esperado).
  Em containers, o status vem do `HEALTHCHECK` proprio do Docker. O health check
  tambem informa **quem responde na porta** (processo e pid), o que evita o
  falso positivo de outro servico estar ocupando a mesma porta.
- `restart.enabled`: reinicia o processo quando ele cai, com backoff exponencial.
  Em containers, o container e reiniciado quando sai com codigo de erro.
- `restart.restartOnUnhealthy`: tambem reinicia quando o health check falha
  `failuresBeforeUnhealthy` vezes seguidas.
- `monitorOnly`: servico apenas observado - o painel nao inicia nem para o
  processo (util para servidores que ja rodam fora do painel). Em containers,
  o painel acompanha estado, logs e metricas sem poder agir.
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
  executables.js      resolucao do node customizado e deteccao de versao
  docker.js           cliente da CLI do Docker
  docker-runner.js    ciclo de vida de containers (start/stop/logs/metricas)
  windows-service.js  cliente do Service Control Manager do Windows
  windows-service-runner.js  ciclo de vida de servicos do Windows
  health-checker.js   verificacoes TCP/HTTP
  metrics.js          coletor de CPU/memoria por processo
  discovery.js        varredura de portas em escuta
src/
  index.html          shell da interface
  styles.css          design system (tema escuro)
  js/
    app.js            orquestrador do renderer
    service-form.js   formulario de cadastro/edicao
    discovery.js      modal de descoberta (portas e containers)
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
