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

// Stand-in GitHub API, so the ideas/bug tests run the real "issue actually
// filed" path. `reject` makes the next call fail, for the fallback tests.
async function fakeGithub() {
  const received = [];
  const failures = [];
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      const parsed = JSON.parse(body || '{}');
      received.push({ url: req.url, auth: req.headers.authorization, body: parsed });
      const fail = failures.shift();
      if (fail) {
        res.writeHead(fail, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ message: 'Validation Failed' }));
      }
      res.writeHead(201, { 'Content-Type': 'application/json' });
      res.end(
        JSON.stringify({
          number: received.length,
          html_url: `https://github.com/torrenegra/encontrados/issues/${received.length}`
        })
      );
    });
  });
  await new Promise((r) => server.listen(0, r));
  process.env.GITHUB_API_BASE = `http://127.0.0.1:${server.address().port}`;
  process.env.GITHUB_TOKEN = 'ghp_test';
  process.env.GITHUB_REPO = 'torrenegra/encontrados';
  return {
    received,
    // Make only the NEXT request fail — flipping a flag races the request that
    // is already in flight.
    failNext(status) {
      failures.push(status);
    },
    stop() {
      server.close();
      delete process.env.GITHUB_API_BASE;
      delete process.env.GITHUB_TOKEN;
      delete process.env.GITHUB_REPO;
    }
  };
}

module.exports = { fakeSendgrid, fakeGithub };
