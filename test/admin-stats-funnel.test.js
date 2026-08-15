// Hotfix post-#127: /admin/stats daba 504 porque el recompute del embudo
// (computeMatchStats, contra Rekognition — medido en 28,7s en prod con ~110
// fotos) corría ADENTRO del request de la página, con un maxDuration de 30s.
//
// Lo que estos tests protegen: que /admin/stats renderiza SIN llamar al
// recompute caro (la regresión real que hay que fijar — se prueba con un
// matcher cuyo método caro lanza, y la página igual responde bien); que el
// fragmento diferido (/admin/stats/funnel) sí lo llama y responde bien en el
// caso normal; y que si el recompute revienta, la sección lo dice con
// claridad — nunca un cero que parezca un dato real.
const test = require('node:test');
const assert = require('node:assert');
const { createSqliteAdapter } = require('../src/store/sqlite');
const { createApp } = require('../src/server');

// Un matcher cuyo searchByFaceId SIEMPRE lanza — si /admin/stats lo llamara,
// esto se notaría (o en un 500, o en que la sección del embudo apareciera
// con datos). No se usa `enabled: true` con firmas indexadas para no
// necesitar sembrar nada: el punto es que ni siquiera se intente.
function explosiveMatcher() {
  return {
    enabled: true,
    status: 'activo (fake, explota a propósito)',
    async ensureReady() {},
    async searchByFaceId() {
      throw new Error('searchByFaceId no debería llamarse desde GET /admin/stats');
    }
  };
}

// Para el caso 502 del fragmento: falla ANTES del try/catch por-foto que ya
// tiene computeMatchStats — ensureReady() no está protegido internamente,
// así que un rechazo ahí sí sube como una falla real del recompute completo.
function brokenEnsureReadyMatcher() {
  return {
    enabled: true,
    status: 'activo (fake, ensureReady roto)',
    async ensureReady() {
      throw new Error('la base de Rekognition no respondió (simulado)');
    }
  };
}

async function startApp(matcher) {
  const app = await createApp(await createSqliteAdapter(':memory:'), matcher);
  const server = await new Promise((resolve) => {
    const s = app.listen(0, () => resolve(s));
  });
  return { server, base: `http://127.0.0.1:${server.address().port}` };
}

function cleanupEnv() {
  delete process.env.PUBLIC_STATS;
}

test('GET /admin/stats renderiza rápido y bien SIN invocar el recompute caro', async (t) => {
  const { server, base } = await startApp(explosiveMatcher());
  t.after(() => {
    server.close();
    cleanupEnv();
  });
  process.env.PUBLIC_STATS = '1';

  const startedAt = Date.now();
  const res = await fetch(`${base}/admin/stats`);
  const elapsedMs = Date.now() - startedAt;

  assert.equal(res.status, 200, 'la página debe responder 200 aunque el matcher explote — no debería tocarlo');
  assert.ok(elapsedMs < 2000, `la página debía responder rápido (fue ${elapsedMs}ms) — si tardó, algo la sigue bloqueando en el recompute`);

  const html = await res.text();
  // La sección cara queda diferida: los DOS placeholders (la card de salud
  // arriba, el detalle del embudo más abajo) y el script están, pero NINGÚN
  // número del embudo (que solo existiría si se hubiera llamado al matcher)
  // aparece en este primer render.
  assert.match(html, /id="salud-card-slot"/);
  assert.match(html, /id="funnel-details-slot"/);
  assert.match(html, /Calculando el embudo/);
  assert.match(html, /fetch\('\/admin\/stats\/funnel'\)/);
  assert.doesNotMatch(html, /El embudo \(acumulado\)<\/h2><svg/, 'el embudo no debe venir renderizado en el HTML inicial — se pide aparte');
});

test('GET /admin/stats/funnel calcula el embudo de verdad y lo devuelve como fragmento', async (t) => {
  const matcher = {
    enabled: true,
    status: 'activo (fake)',
    async ensureReady() {},
    async searchByFaceId() {
      return [];
    }
  };
  const { server, base } = await startApp(matcher);
  t.after(() => {
    server.close();
    cleanupEnv();
  });
  process.env.PUBLIC_STATS = '1';

  const res = await fetch(`${base}/admin/stats/funnel`);
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('x-robots-tag'), 'noindex, nofollow');
  const html = await res.text();
  assert.match(html, /id="salud-card-slot"/);
  assert.match(html, /id="funnel-details-fragment"/);
  assert.match(html, /El embudo \(acumulado\)/);
  assert.match(html, /Señal de confiabilidad/);
});

test('si el recompute revienta, /admin/stats/funnel lo dice con claridad — nunca un cero que parezca un dato real', async (t) => {
  const { server, base } = await startApp(brokenEnsureReadyMatcher());
  t.after(() => {
    server.close();
    cleanupEnv();
  });
  process.env.PUBLIC_STATS = '1';

  const res = await fetch(`${base}/admin/stats/funnel`);
  assert.equal(res.status, 502);
  const html = await res.text();
  assert.match(html, /No se pudo calcular el embudo/);
  assert.doesNotMatch(html, />0<\/td>/, 'un fallo no debe disfrazarse de un cero en una tabla');
});

test('GET /admin/stats/funnel exige sesión igual que /admin/stats — mismo statsGate', async (t) => {
  const { server, base } = await startApp(explosiveMatcher());
  t.after(() => {
    server.close();
    cleanupEnv();
  });
  // Sin PUBLIC_STATS.
  const res = await fetch(`${base}/admin/stats/funnel`, { redirect: 'manual' });
  assert.equal(res.status, 302);
  assert.match(res.headers.get('location'), /^\/admin\/login/);
});
