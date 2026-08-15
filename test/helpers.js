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
          html_url: `https://github.com/encontradosco/encontrados/issues/${received.length}`
        })
      );
    });
  });
  await new Promise((r) => server.listen(0, r));
  process.env.GITHUB_API_BASE = `http://127.0.0.1:${server.address().port}`;
  process.env.GITHUB_TOKEN = 'ghp_test';
  process.env.GITHUB_REPO = 'encontradosco/encontrados';
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

// Stand-in Meta Cloud API, so the WhatsApp tests exercise the real "message
// actually sent" path and can leer exactly what payload salió — que es donde
// vive la diferencia entre una plantilla y un texto plano.
async function fakeWhatsApp() {
  const received = [];
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      received.push({ url: req.url, auth: req.headers.authorization, body: JSON.parse(body || '{}') });
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ messages: [{ id: `wamid.test.${received.length}` }] }));
    });
  });
  await new Promise((r) => server.listen(0, r));
  process.env.WHATSAPP_API_BASE = `http://127.0.0.1:${server.address().port}`;
  process.env.WHATSAPP_TOKEN = 'wa-test-token';
  process.env.WHATSAPP_PHONE_NUMBER_ID = '1234567890';
  return {
    received,
    stop() {
      server.close();
      delete process.env.WHATSAPP_API_BASE;
      delete process.env.WHATSAPP_TOKEN;
      delete process.env.WHATSAPP_PHONE_NUMBER_ID;
    }
  };
}

// Stand-in "Sign in with Vercel" (#116, PR 5) — token + userinfo + revoke, lo
// mínimo que src/adminAuth.js necesita para probar el flujo completo (login
// → callback → sesión) sin hablar con Vercel de verdad. setUserInfo() decide
// qué correo "inicia sesión" en la siguiente llamada al callback.
async function fakeVercelOAuth() {
  let nextUserInfo = { email: 'nadie@ejemplo.com', email_verified: true };
  const server = http.createServer((req, res) => {
    if (req.method === 'POST' && req.url.startsWith('/login/oauth/token/revoke')) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end('{}');
    }
    if (req.method === 'POST' && req.url.startsWith('/login/oauth/token')) {
      let body = '';
      req.on('data', (c) => (body += c));
      req.on('end', () => {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(
          JSON.stringify({
            access_token: 'fake-access-token',
            token_type: 'Bearer',
            expires_in: 3600,
            scope: 'openid email'
          })
        );
      });
      return;
    }
    if (req.method === 'GET' && req.url.startsWith('/login/oauth/userinfo')) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify(nextUserInfo));
    }
    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end('{}');
  });
  await new Promise((r) => server.listen(0, r));
  const base = `http://127.0.0.1:${server.address().port}`;
  process.env.VERCEL_OAUTH_API_BASE = base;
  process.env.VERCEL_APP_CLIENT_ID = 'test-client-id';
  process.env.VERCEL_APP_CLIENT_SECRET = 'test-client-secret';
  return {
    base,
    setUserInfo(info) {
      nextUserInfo = info;
    },
    stop() {
      server.close();
      delete process.env.VERCEL_OAUTH_API_BASE;
      delete process.env.VERCEL_APP_CLIENT_ID;
      delete process.env.VERCEL_APP_CLIENT_SECRET;
    }
  };
}

// Stand-in del servicio Python (pet-matcher/), para que las pruebas de rutas
// ejerciten POST /embed de verdad sin necesitar Python instalado. Por
// omisión responde un vector fijo; respondWith() lo cambia cuando una prueba
// necesita un vector específico (para forzar o evitar una coincidencia).
async function fakePetMatcher() {
  const received = [];
  let vector = [1, 0, 0];
  const server = http.createServer((req, res) => {
    received.push({ url: req.url });
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ embedding: vector, model: 'fake-pet-model' }));
  });
  await new Promise((r) => server.listen(0, r));
  const base = `http://127.0.0.1:${server.address().port}`;
  process.env.PET_MATCH_API_URL = base;
  return {
    received,
    base,
    respondWith(v) {
      vector = v;
    },
    stop() {
      server.close();
      delete process.env.PET_MATCH_API_URL;
    }
  };
}

module.exports = { fakeSendgrid, fakeGithub, fakeWhatsApp, fakeVercelOAuth, fakePetMatcher };
