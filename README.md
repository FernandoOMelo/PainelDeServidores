# Painel de Servidores

Aplicativo desktop para iniciar, parar e monitorar servidores locais pela
interface grafica, no lugar de varios terminais abertos.

Escrito em **Rust (Tauri)** com o frontend em HTML/CSS/JavaScript puro.

## O que ele faz

- **Cadastro pela propria interface** - cada servico tem nome, grupo, comando,
  argumentos, diretorio de trabalho, variaveis de ambiente e opcoes de
  monitoramento. Tudo e gravado em `config.local.json`.
- **Ciclo de vida** - iniciar, parar, reiniciar, iniciar todos, parar todos.
- **Node proprio por servico** - cada servico pode usar uma versao diferente do
  Node (node embutido no projeto, versao especifica do nvm, etc). A pasta do
  node entra no PATH do processo, entao `npm`, `npx` e os processos filhos usam
  a mesma versao. O botao **"Procurar na pasta"** localiza o `node.exe`
  embarcado no diretorio de trabalho e preenche o campo sozinho.
- **Docker** - containers podem ser iniciados, parados e reiniciados pelo
  painel, com estado real, HEALTHCHECK, logs ao vivo e metricas de CPU/memoria.
- **Servicos do Windows** - servicos registrados no Service Control Manager
  podem ser acompanhados e controlados, com estado real (inclusive *Paused*),
  PID, modo de inicializacao e metricas.
- **Health check** - verificacao por porta TCP ou por endpoint HTTP (com status
  esperado, intervalo, timeout e janela de espera apos o start). O painel tambem
  informa **quem responde na porta**, o que evita o falso positivo de outro
  servico estar ocupando a mesma porta.
- **Recuperacao automatica** - quando o processo cai, o painel reinicia com
  backoff exponencial. Tambem reinicia quando o health check falha
  consecutivamente (configuravel).
- **Logs em tempo real** - stdout e stderr capturados por servico, com buffer
  circular, filtro por texto, auto-scroll e arquivo em `logs/<id>.log`.
- **Metricas** - CPU e memoria por processo, coletadas pela API nativa do
  Windows (sem PowerShell em background).
- **Dashboard** - soma das metricas de todos os servicos: CPU total, memoria
  total e o ranking dos maiores consumidores (ordenavel por memoria ou CPU).
- **Filtro por status** - os indicadores do topo (rodando, parados, fora do ar,
  com problema) sao clicaveis e filtram a lista. Combinam com o filtro por
  grupo, pela busca e por "somente ativos".
- **Descoberta** - varre as portas em escuta da maquina e os containers Docker
  existentes, permitindo adotar servidores que ja rodam fora do painel em modo
  "somente monitorar".
- **Bandeja do sistema** - fechar a janela nao encerra o app: ele continua
  monitorando os servicos em segundo plano, com icone na bandeja. A janela e
  destruida de verdade ao fechar, e a WebView2 so e criada quando o painel e
  aberto de fato - sem janela, o app fica com ~26 MB e zero processos de
  navegador.
- **Instancia unica** - rodar o executavel de novo nao abre um segundo app:
  ele avisa o que ja esta na bandeja, mostra a janela e sai.
- **Inicializacao automatica com o Windows** - o app pode subir junto com o
  sistema, direto na bandeja (sem abrir janela).

## Como rodar

### Desarrollo

```bash
npm install          # dependencias do frontend (CLI do Tauri)
cd src-tauri
cargo run            # sobe o app em modo debug
```

O modo debug le o `config.local.json` da raiz do projeto, entao da para
experimentar com os servicos ja cadastrados.

### Gerar o executavel

```bash
cd src-tauri
cargo build --release
```

O resultado e um unico executavel em
`src-tauri/target/release/painel-servidores.exe` (cerca de 5 MB), com o
frontend embutido. Nao precisa de Node nem de pasta de recursos ao lado.

Para gerar um pacote pronto para uso:

```bash
npm run build:exe    # dist\PainelDeServidores.exe
```

### Testes

```bash
cd src-tauri
cargo test
```

Cobre leitura/escrita do config (e o formato compartilhado com o frontend),
normalizacao de servicos, resolucao do node proprio, leitura do Service
Control Manager e traducao de erros.

## Configuracao dos servicos

Os servicos ficam em `config.local.json`, na raiz do projeto em
desenvolvimento e em `%APPDATA%\painel-servidores\config.json` no app
empacotado. Esse arquivo pode ser editado a mao ou pela propria interface - as
duas vias escrevem no mesmo lugar.

> O `config.local.json` e local da maquina e **nao** entra no versionamento
> (esta no `.gitignore`). O arquivo `config.example.json` mostra o formato de
> referencia com um servico de exemplo.

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
  "service": "",
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
  },
  "createdAt": "2026-01-01T00:00:00.000Z"
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
  "monitorOnly": false
}
```

Formato de um servico do Windows:

```json
{
  "id": "api-one",
  "name": "Galileo One API",
  "group": "GalileoPlus",
  "type": "servico",
  "service": "galileo_one_api",
  "autostart": false,
  "monitorOnly": true
}
```

- `type`: `processo` (padrao), `docker` ou `servico`.
- `nodePath`: caminho do `node.exe` (ou da pasta que o contem) especifico do
  servico. Vazio usa o node do PATH. A pasta do node e placed no PATH do
  processo, de modo que `npm`, `npx` e os filhos usam a mesma versao - e o que
  permite rodar versoes diferentes ao mesmo tempo.
- `container`: nome do container alvo quando `type` e `docker`.
- `service`: nome do servico do Windows quando `type` e `servico` (o mesmo nome
  que aparece em `services.msc`).
- `health.type`: `none`, `tcp` (porta aberta) ou `http` (endpoint com status
  esperado). Em containers, o status vem do `HEALTHCHECK` proprio do Docker.
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
src-tauri/
  Cargo.toml
  tauri.conf.json      configuracao do app (janela criada sob demanda)
  capabilities/        permissoes do Tauri (eventos, janela, bandeja)
  icons/               icones do app e da bandeja
  src/
    main.rs            ponto de entrada
    lib.rs             janela sob demanda, bandeja, ciclo de vida
    commands.rs        a API exposta a interface
    types.rs           tipos compartilhados (config, runtime, eventos)
    store.rs           persistencia em config.local.json
    service.rs         runner: processo, container ou servico do Windows
    manager.rs         orquestrador, eventos e coleta de metricas
    health.rs          verificacoes TCP e HTTP
    metrics.rs         CPU/memoria pela API nativa do Windows
    docker.rs          cliente do Docker
    winsvc.rs          cliente do Service Control Manager
    discovery.rs       varredura de portas
    executables.rs     node proprio por servico
    autostart.rs       inicializacao automatica com o Windows
  tests/nucleo.rs      testes do nucleo
src/                   frontend (HTML/CSS/JS puro, compartilhado)
examples/              servidor HTTP de exemplo
scripts/               utilitarios de desenvolvimento
```

## Notas de implementacao

- O renderer nao tem acesso ao Node: a comunicacao passa pelo IPC do Tauri, com
  as permissoes declaradas em `capabilities/default.json`.
- A janela e criada sob demanda. Com o app so na bandeja, nao existe nenhuma
  WebView2 em memoria - e o que mantem o consumo em ~20 MB.
- As metricas usam `GetProcessTimes` e `GetProcessMemoryInfo` diretamente: nao
  ha PowerShell em background.
- O Docker e acessado pela CLI: a API do Engine pelo named pipe aceita apenas
  um cliente por vez, o que quebra com varios containers sendo acompanhados.
- No Windows, o encerramento de um servico encerra a arvore de processos com
  `taskkill /T /F`; em POSIX usa grupos de processos (`SIGTERM` -> `SIGKILL`).
