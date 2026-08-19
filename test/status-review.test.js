// La cola de revisión de estado y su salida humana (#190).
//
// Lo que estas pruebas protegen es exactamente lo que no puede estar mal:
//
//  1. El marcador privado de "probable" y la justificación de quien revisó NO
//     salen en ninguna lectura pública. Es la razón por la que se descartó
//     crear un estado público "probablemente encontrado": una familia que lee
//     esperanza en la ficha de su hijo, cuando era un homónimo, es un daño que
//     causamos nosotros.
//  2. No se puede resolver sin haber escrito con qué. Sin eso la cola es un
//     botón sin memoria — y ese botón le escribe a familias.
//  3. Resolver queda registrado: quién, cuándo, con qué evidencia, a cuántos
//     se les avisó y en qué modo salió el aviso.
//  4. La pantalla dice ANTES de confirmar que la acción notifica y a cuántos.
//  5. Una ficha se resuelve UNA VEZ: el segundo intento se rechaza, no manda
//     un segundo aviso de muerte a la misma familia.
//  6. No hay resolución en lote.
//
// Todos los nombres de estas pruebas son sintéticos. Cero PII real.
const test = require('node:test');
const assert = require('node:assert');
const crypto = require('node:crypto');
const { createSqliteAdapter } = require('../src/store/sqlite');
const { createStore } = require('../src/people');
const { createApp } = require('../src/server');
const { nullMatcher } = require('../src/faces');
const { publicUpdate } = require('../src/privacy');

const ADMIN = 'revisora@ejemplo.com';
const SECRET = 'secreto-de-prueba';
const NOTA_PRIVADA = 'La prensa regional confirma el hallazgo y coincide el municipio; descarté homónimo por la edad.';

// Cookie de sesión de /admin firmada con el mismo HMAC que src/adminAuth.js.
// Se arma acá para que estas pruebas midan la cola y no el flujo de OAuth,
// que ya tiene su propio archivo (test/admin-auth.test.js).
function sessionCookie(email = ADMIN) {
  const payload = Buffer.from(
    JSON.stringify({ email, exp: Math.floor(Date.now() / 1000) + 3600 })
  ).toString('base64url');
  const sig = crypto.createHmac('sha256', SECRET).update(payload).digest('base64url');
  return `admin_session=${payload}.${sig}`;
}

async function startApp() {
  process.env.ADMIN_EMAILS = ADMIN;
  process.env.ADMIN_SESSION_SECRET = SECRET;
  // Modo relevo explícito (es también el de por omisión): así ninguna prueba
  // intenta escribirle a un tercero de verdad.
  process.env.NOTIFY_MODE = 'relay';
  delete process.env.AVISO_EMAIL;
  const adapter = await createSqliteAdapter(':memory:');
  const store = createStore(adapter);
  const app = await createApp(adapter, nullMatcher);
  const server = await new Promise((resolve) => {
    const s = app.listen(0, () => resolve(s));
  });
  return {
    store,
    adapter,
    base: `http://127.0.0.1:${server.address().port}`,
    stop() {
      server.close();
      delete process.env.ADMIN_EMAILS;
      delete process.env.ADMIN_SESSION_SECRET;
      delete process.env.NOTIFY_MODE;
    }
  };
}

// Una ficha en `unknown`: el estacionamiento del que el issue dice que no hay
// salida. Es a lo que llega "Localizada sin vida" del registro público y buena
// parte de lo que el filtro bidireccional de medios va a encontrar.
async function fichaSinConfirmar(store, name = 'Ana Sintética Uno') {
  const { person } = await store.findOrCreatePerson(name);
  await store.addUpdate(person.id, {
    status: 'unknown',
    message: 'La fuente la reporta como localizada, sin decir en qué estado.',
    location: 'Municipio de prueba',
    source: 'aggregator',
    sourceUrl: 'https://ejemplo.test/ficha/1',
    reporter: 'Registro de prueba'
  });
  return store.getPerson(person.id);
}

function form(fields) {
  return {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', Cookie: sessionCookie() },
    redirect: 'manual',
    body: new URLSearchParams(fields).toString()
  };
}

async function reviews(adapter, personId) {
  return adapter.statusReviewsForPerson(personId);
}

// ---------------------------------------------------------------------------
// 1. El marcador privado no se filtra a una lectura pública
// ---------------------------------------------------------------------------

test('la constancia privada no sale por ninguna lectura pública', async () => {
  const app = await startApp();
  try {
    const person = await fichaSinConfirmar(app.store);

    const res = await fetch(
      `${app.base}/admin/revision/${person.id}/nota`,
      form({ estado: 'deceased', evidencia: NOTA_PRIVADA })
    );
    assert.equal(res.status, 302, 'la constancia se guarda y vuelve a la ficha');

    const guardadas = await reviews(app.adapter, person.id);
    assert.equal(guardadas.length, 1);
    assert.equal(guardadas[0].probable_status, 'deceased');
    assert.equal(guardadas[0].resolved, 0, 'una constancia NO resuelve nada');

    // (a) El estado público no se movió: sigue en la cola, sigue SIN CONFIRMAR.
    const latest = await app.store.getLatestUpdate(person.id);
    assert.equal(latest.status, 'unknown');

    // (b) La proyección pública de la fila de updates no ganó ningún campo.
    assert.deepEqual(
      Object.keys(publicUpdate(latest)).sort(),
      [
        'created_at',
        'id',
        'lat',
        'lng',
        'location',
        'message',
        'person_id',
        'reporter_label',
        'source',
        'status'
      ].sort(),
      'publicUpdate enumera campo por campo: si esto crece, algo nuevo empezó a salir al público'
    );

    // (c) Ni el JSON público ni el HTML público mencionan la nota, el marcador
    //     ni el correo de quien la escribió.
    const json = await (await fetch(`${app.base}/api/people/${person.id}`)).text();
    const html = await (await fetch(`${app.base}/person/${person.id}`)).text();
    for (const [donde, cuerpo] of [['JSON', json], ['HTML', html]]) {
      assert.ok(!cuerpo.includes(NOTA_PRIVADA), `la nota privada se filtró al ${donde} público`);
      assert.ok(!cuerpo.includes(ADMIN), `el correo de quien revisó se filtró al ${donde} público`);
      assert.ok(!/probable/i.test(cuerpo), `la palabra "probable" apareció en el ${donde} público`);
    }
  } finally {
    app.stop();
  }
});

test('la evidencia de una resolución tampoco viaja al mensaje público', async () => {
  const app = await startApp();
  try {
    const person = await fichaSinConfirmar(app.store, 'Beatriz Sintética Dos');
    const res = await fetch(
      `${app.base}/admin/revision/${person.id}/resolver`,
      form({
        estado: 'deceased',
        evidencia: NOTA_PRIVADA,
        enlace: 'https://ejemplo.test/noticia',
        confirmo: '1'
      })
    );
    assert.equal(res.status, 200);

    const latest = await app.store.getLatestUpdate(person.id);
    assert.equal(latest.status, 'deceased');
    assert.equal(latest.message, null, 'la justificación de quien revisó es privada: message queda vacío');
    assert.equal(latest.source_url, 'https://ejemplo.test/noticia', 'el enlace SÍ es público: va en source_url');

    const json = await (await fetch(`${app.base}/api/people/${person.id}`)).text();
    assert.ok(!json.includes(NOTA_PRIVADA));
    assert.ok(!json.includes(ADMIN));
  } finally {
    app.stop();
  }
});

// ---------------------------------------------------------------------------
// 2. No se resuelve sin evidencia (ni sin la confirmación explícita)
// ---------------------------------------------------------------------------

test('sin evidencia escrita no se resuelve, y no se manda ningún aviso', async () => {
  const app = await startApp();
  try {
    const person = await fichaSinConfirmar(app.store, 'Carmen Sintética Tres');
    await app.store.subscribe(person.id, 'email', 'familiar@ejemplo.test', { verified: true });

    for (const evidencia of ['', '   ']) {
      const res = await fetch(
        `${app.base}/admin/revision/${person.id}/resolver`,
        form({ estado: 'deceased', evidencia, confirmo: '1' })
      );
      assert.equal(res.status, 400, `«${evidencia}» no puede pasar como evidencia`);
      const cuerpo = await res.text();
      assert.match(cuerpo, /con qué evidencia/i);
      // Y lo importante: nada cambió y nada se registró.
      assert.equal((await app.store.getLatestUpdate(person.id)).status, 'unknown');
      assert.equal((await reviews(app.adapter, person.id)).length, 0);
    }
  } finally {
    app.stop();
  }
});

test('sin marcar la casilla de "esto manda un aviso" no se resuelve', async () => {
  const app = await startApp();
  try {
    const person = await fichaSinConfirmar(app.store, 'Diana Sintética Cuatro');
    const res = await fetch(
      `${app.base}/admin/revision/${person.id}/resolver`,
      form({ estado: 'safe', evidencia: NOTA_PRIVADA })
    );
    assert.equal(res.status, 400);
    assert.match(await res.text(), /manda un aviso/i);
    assert.equal((await app.store.getLatestUpdate(person.id)).status, 'unknown');
    assert.equal((await reviews(app.adapter, person.id)).length, 0);
  } finally {
    app.stop();
  }
});

test('un estado que no sea "apareció viva" o "murió" se rechaza', async () => {
  const app = await startApp();
  try {
    const person = await fichaSinConfirmar(app.store, 'Elena Sintética Cinco');
    for (const estado of ['missing', 'unknown', 'injured', 'cualquiera']) {
      const res = await fetch(
        `${app.base}/admin/revision/${person.id}/resolver`,
        form({ estado, evidencia: NOTA_PRIVADA, confirmo: '1' })
      );
      assert.equal(res.status, 400, `«${estado}» no es un destino de esta cola`);
      assert.equal((await app.store.getLatestUpdate(person.id)).status, 'unknown');
    }
  } finally {
    app.stop();
  }
});

// ---------------------------------------------------------------------------
// 3. Resolver queda registrado
// ---------------------------------------------------------------------------

test('resolver deja constancia de quién, cuándo, con qué y a cuántos', async () => {
  const app = await startApp();
  try {
    const person = await fichaSinConfirmar(app.store, 'Fabiola Sintética Seis');
    // Dos seguidoras verificadas y una sin verificar: la que no está
    // verificada no recibe aviso, así que no puede contar en el registro.
    await app.store.subscribe(person.id, 'email', 'hermana@ejemplo.test', { verified: true });
    await app.store.subscribe(person.id, 'whatsapp', '573000000001', { verified: true });
    await app.store.subscribe(person.id, 'email', 'vecina@ejemplo.test', { verified: false });

    const res = await fetch(
      `${app.base}/admin/revision/${person.id}/resolver`,
      form({
        estado: 'deceased',
        evidencia: NOTA_PRIVADA,
        enlace: 'https://ejemplo.test/noticia',
        confirmo: '1'
      })
    );
    assert.equal(res.status, 200);

    const [registro] = await reviews(app.adapter, person.id);
    assert.equal(registro.resolved, 1);
    assert.equal(registro.author, ADMIN, 'quién decidió');
    assert.equal(registro.evidence_note, NOTA_PRIVADA, 'con qué decidió');
    assert.equal(registro.probable_status, 'deceased');
    assert.equal(registro.recipients, 2, 'a cuántos: solo los notificables, no las suscripciones sin verificar');
    assert.equal(registro.notify_mode, 'relay');
    assert.ok(registro.update_id, 'apunta a la fila de updates que produjo');
    // Cuándo: TEXTO ISO en los dos motores. Un TIMESTAMPTZ volvería Date en
    // Postgres y string acá, y esa diferencia se cuela en producción.
    assert.equal(typeof registro.created_at, 'string');
    assert.match(registro.created_at, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/);

    // El correo de quien decidió queda en el registro privado, no en la ficha.
    const publica = publicUpdate(await app.store.getLatestUpdate(person.id));
    assert.ok(!JSON.stringify(publica).includes(ADMIN));
  } finally {
    app.stop();
  }
});

test('una ficha ya resuelta no se resuelve otra vez', async () => {
  const app = await startApp();
  try {
    const person = await fichaSinConfirmar(app.store, 'Gabriela Sintética Siete');
    const cuerpo = form({ estado: 'deceased', evidencia: NOTA_PRIVADA, confirmo: '1' });

    assert.equal((await fetch(`${app.base}/admin/revision/${person.id}/resolver`, cuerpo)).status, 200);

    const segundo = await fetch(`${app.base}/admin/revision/${person.id}/resolver`, cuerpo);
    assert.equal(segundo.status, 400, 'el segundo intento se rechaza');
    assert.match(await segundo.text(), /ya no está en la cola/i);
    assert.equal(
      (await reviews(app.adapter, person.id)).filter((r) => r.resolved).length,
      1,
      'una sola resolución, un solo aviso'
    );
  } finally {
    app.stop();
  }
});

// ---------------------------------------------------------------------------
// 4. La cola, la advertencia, y nada de lotes
// ---------------------------------------------------------------------------

test('la cola lista la ficha con su evidencia y la suelta al resolverla', async () => {
  const app = await startApp();
  try {
    const person = await fichaSinConfirmar(app.store, 'Helena Sintética Ocho');
    const headers = { Cookie: sessionCookie() };

    const antes = await (await fetch(`${app.base}/admin/revision`, { headers })).text();
    assert.match(antes, /Helena Sintética Ocho/);
    assert.match(antes, /https:\/\/ejemplo\.test\/ficha\/1/, 'la evidencia enlazable se ve en la cola');
    assert.match(antes, /Municipio de prueba/);

    // Nada de resolución en lote: la cola solo enlaza a fichas, no tiene
    // ningún formulario propio con el que despachar varias de una vez.
    assert.ok(!/<form/i.test(antes), 'la cola no puede tener un formulario de lote');

    await fetch(
      `${app.base}/admin/revision/${person.id}/resolver`,
      form({ estado: 'safe', evidencia: NOTA_PRIVADA, confirmo: '1' })
    );

    const despues = await (await fetch(`${app.base}/admin/revision`, { headers })).text();
    assert.ok(!despues.includes('Helena Sintética Ocho'), 'resuelta, sale de la cola');
  } finally {
    app.stop();
  }
});

test('la pantalla avisa, antes de confirmar, que resolver notifica y a cuántos', async () => {
  const app = await startApp();
  try {
    const person = await fichaSinConfirmar(app.store, 'Irene Sintética Nueve');
    await app.store.subscribe(person.id, 'email', 'tia@ejemplo.test', { verified: true });
    await app.store.subscribe(person.id, 'email', 'primo@ejemplo.test', { verified: true });
    await app.store.subscribe(person.id, 'email', 'nadie@ejemplo.test', { verified: false });

    const html = await (
      await fetch(`${app.base}/admin/revision/${person.id}`, { headers: { Cookie: sessionCookie() } })
    ).text();

    assert.match(html, /Resolver esta ficha manda un aviso/i, 'la advertencia está, y no en letra chica');
    assert.match(html, /<strong>2<\/strong> suscripción/, 'dice cuántas personas, no "algunas"');
    assert.match(html, /relevo/i, 'y dice qué les pasa en el modo que está activo');
    assert.match(html, /FALLECIDO\(A\)/, 'dice que el aviso de muerte dice exactamente eso');
    assert.match(html, /name="confirmo"[^>]*required/, 'la confirmación es obligatoria en el formulario');
    assert.match(html, /name="evidencia"[^>]*rows="4" required/, 'la evidencia es obligatoria en el formulario');
    // Ni la dirección de una familia ni el correo del equipo se pintan acá.
    assert.ok(!html.includes('tia@ejemplo.test'), 'la cola no expone las direcciones de quien sigue la ficha');
  } finally {
    app.stop();
  }
});

test('sin nadie suscrito la pantalla lo dice, en vez de amenazar con un aviso que no existe', async () => {
  const app = await startApp();
  try {
    const person = await fichaSinConfirmar(app.store, 'Julia Sintética Diez');
    const html = await (
      await fetch(`${app.base}/admin/revision/${person.id}`, { headers: { Cookie: sessionCookie() } })
    ).text();
    assert.match(html, /no sale ningún aviso/i);
  } finally {
    app.stop();
  }
});

test('la cola entera exige sesión de /admin', async () => {
  const app = await startApp();
  try {
    const person = await fichaSinConfirmar(app.store, 'Karina Sintética Once');
    const rutas = [
      ['GET', '/admin/revision'],
      ['GET', `/admin/revision/${person.id}`],
      ['POST', `/admin/revision/${person.id}/nota`],
      ['POST', `/admin/revision/${person.id}/resolver`]
    ];
    for (const [method, ruta] of rutas) {
      const res = await fetch(`${app.base}${ruta}`, { method, redirect: 'manual' });
      assert.equal(res.status, 302, `${method} ${ruta} sin sesión`);
      assert.match(res.headers.get('location') || '', /^\/admin\/login/);
    }
    // Y nada se escribió por el intento.
    assert.equal((await reviews(app.adapter, person.id)).length, 0);
    assert.equal((await app.store.getLatestUpdate(person.id)).status, 'unknown');
  } finally {
    app.stop();
  }
});

test('una ficha que ya no está en la cola no muestra el botón de resolver', async () => {
  const app = await startApp();
  try {
    const person = await fichaSinConfirmar(app.store, 'Lucía Sintética Doce');
    await fetch(
      `${app.base}/admin/revision/${person.id}/resolver`,
      form({ estado: 'safe', evidencia: NOTA_PRIVADA, confirmo: '1' })
    );

    const html = await (
      await fetch(`${app.base}/admin/revision/${person.id}`, { headers: { Cookie: sessionCookie() } })
    ).text();
    assert.match(html, /no está en la cola/i, 'la pantalla dice por qué no hay botón');
    assert.ok(
      !/action="\/admin\/revision\/\d+\/resolver"/.test(html),
      'ofrecer el botón sobre una ficha ya cerrada invita a mandar un segundo aviso a la misma familia'
    );
    // El de dejar constancia sí sigue: no tiene efecto y sirve para el registro.
    assert.match(html, /action="\/admin\/revision\/\d+\/nota"/);
  } finally {
    app.stop();
  }
});
