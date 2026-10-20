const http = require('http');

const port = Number(process.env.PORT) || 45999;
let hits = 0;

http
  .createServer((req, res) => {
    hits += 1;
    console.log(`${req.method} ${req.url} - requisição ${hits}`);
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ ok: true, hits }));
  })
  .listen(port, () => {
    console.log(`API de demonstração escutando em http://127.0.0.1:${port}`);
  });

process.on('SIGTERM', () => {
  console.log('Encerrando gracefully...');
  process.exit(0);
});
