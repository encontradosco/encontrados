// Shared test helpers: a stand-in SendGrid so tests exercise the real
// "email actually sent" path instead of the failure path.
const http = require('node:http');

async function fakeSendgrid() {
  const received = [];
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      received.push({ url: req.url, auth: req.headers.authorization, body: JSON.parse(body || '{}') });
      res.writeHead(202).end();
    });
  });
  await new Promise((r) => server.listen(0, r));
  const base = `http://127.0.0.1:${server.address().port}`;
  process.env.SENDGRID_API_KEY = 'SG.test-key';
  process.env.SENDGRID_API_BASE = base;
  return {
    server,
    received,
    base,
    stop() {
      server.close();
      delete process.env.SENDGRID_API_KEY;
      delete process.env.SENDGRID_API_BASE;
    }
  };
}

module.exports = { fakeSendgrid };
