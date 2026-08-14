// GET /admin/stats — el panel de estadísticas (#116, PR 6).
//
// Lo que estos tests protegen: que la vista NO filtre PII en su HTML
// renderizado (mismo patrón que los tests anteriores, ahora sobre HTML en
// vez de JSON); que sin PUBLIC_STATS la vista exige sesión (cerrado por
// omisión); que /api/admin/* — el hogar de un futuro drill-down — exige
// sesión SIEMPRE, con y sin el flag; y que las cifras del panel coinciden
// con las que produce gatherReportData, la misma función que usa el correo.
const test = require('node:test');
const assert = require('node:assert');
const sharp = require('sharp');
const env = require('../src/env');
const { createSqliteAdapter } = require('../src/store/sqlite');
const { createApp } = require('../src/server');
const { gatherReportData } = require('../src/report');
const { fakeSendgrid } = require('./helpers');

function fakeMatcher() {
  const indexed = new Map();
  let n = 0;
  const key = (b) => b.toString('utf8');
  return {
    enabled: true,
    status: 'activo (fake)',
    async indexFace(bytes) {
      const id = `face-${++n}`;
      if (!indexed.has(key(bytes))) indexed.set(key(bytes), []);
      indexed.get(key(bytes)).push(id);
      return { faceId: id, geometry: null };
    },
    async detectFace() {
      return null;
    },
    async searchByImage(bytes) {
      return (indexed.get(key(bytes)) || []).map((faceId) => ({ faceId, similarity: 97 }));
    },
    // computeMatchStats no es el foco de este archivo (ya lo cubre
    // test/match-stats.test.js) — alcanza con que no reviente y deje el
    // embudo en 0.
    async searchByFaceId() {
      return [];
    }
  };
}

async function photoBytes(label) {
  let h = 0;
  for (const ch of label) h = (h * 31 + ch.charCodeAt(0)) % 16777216;
  return sharp({
    create: { width: 200, height: 250, channels: 3, background: { r: (h >> 16) & 255, g: (h >> 8) & 255, b: h & 255 } }
  })
    .jpeg()
    .toBuffer();
}

async function startApp(matcher) {
  const app = await createApp(await createSqliteAdapter(':memory:'), matcher || fakeMatcher());
  const server = await new Promise((resolve) => {
    const s = app.listen(0, () => resolve(s));
  });
  return { server, base: `http://127.0.0.1:${server.address().port}`, store: app.locals.store, matcher: app.locals.matcher };
}

async function reportMissing(base, { name, contact, face }) {
  const fd = new FormData();
  fd.set('name', name);
  fd.set('location', 'Barrio San José');
  fd.set('contact', contact);
  fd.append('photos', new File([await photoBytes(face)], 'f.jpg', { type: 'image/jpeg' }));
  return fetch(`${base}/report`, { method: 'POST', body: fd, redirect: 'manual' });
}

function cleanupEnv() {
  delete process.env.PUBLIC_STATS;
  delete process.env.ADMIN_SESSION_SECRET;
  delete process.env.ADMIN_EMAILS;
  env.API_KEY = '';
}

test('sin PUBLIC_STATS, GET /admin/stats exige sesión — cerrado por omisión', async (t) => {
  const { server, base } = await startApp();
  t.after(() => {
    server.close();
    cleanupEnv();
  });

  const res = await fetch(`${base}/admin/stats`, { redirect: 'manual' });
  assert.equal(res.status, 302);
  assert.match(res.headers.get('location'), /^\/admin\/login/);
});

test('con PUBLIC_STATS=1, GET /admin/stats responde sin sesión — con noindex y el banner', async (t) => {
  const { server, base } = await startApp();
  t.after(() => {
    server.close();
    cleanupEnv();
  });
  process.env.PUBLIC_STATS = '1';

  const res = await fetch(`${base}/admin/stats`);
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('x-robots-tag'), 'noindex, nofollow');

  const html = await res.text();
  assert.match(html, /<meta name="robots" content="noindex, nofollow">/);
  assert.match(html, /Vista temporal sin autenticación/);
  assert.match(html, /issues\/116/);
});

test('cualquier valor de PUBLIC_STATS distinto de "1" deja la vista cerrada', async (t) => {
  const { server, base } = await startApp();
  t.after(() => {
    server.close();
    cleanupEnv();
  });
  process.env.PUBLIC_STATS = 'true'; // no es '1' — sigue cerrado

  const res = await fetch(`${base}/admin/stats`, { redirect: 'manual' });
  assert.equal(res.status, 302);
});

test('/api/admin/* exige sesión SIEMPRE — con y sin PUBLIC_STATS activo', async (t) => {
  const { server, base } = await startApp();
  t.after(() => {
    server.close();
    cleanupEnv();
  });

  const closedRes = await fetch(`${base}/api/admin/cualquier-cosa`, { redirect: 'manual' });
  assert.equal(closedRes.status, 302, 'sin PUBLIC_STATS, /api/admin/* pide sesión');

  process.env.PUBLIC_STATS = '1';
  const withFlagRes = await fetch(`${base}/api/admin/cualquier-cosa`, { redirect: 'manual' });
  assert.equal(withFlagRes.status, 302, 'PUBLIC_STATS abre /admin/stats, NUNCA /api/admin/* — el drill-down no tiene puerta "mientras tanto"');
});

test('el panel público no filtra nada de lo sembrado — solo cifras agregadas, como /api/diag', async (t) => {
  const matcher = fakeMatcher();
  const { server, base } = await startApp(matcher);
  t.after(() => {
    server.close();
    cleanupEnv();
  });
  process.env.PUBLIC_STATS = '1';

  await reportMissing(base, {
    name: 'Fernanda Prueba Rios',
    contact: 'familia-fernanda@ejemplo.com · 300 555 1212',
    face: 'fernanda'
  });
  // Un "rescate" con la misma cara — genera un match_log real, superficie rescate.
  const fd = new FormData();
  fd.set('photo', new File([await photoBytes('fernanda')], 'r.jpg', { type: 'image/jpeg' }));
  fd.set('email', 'rescatista-fernanda@ejemplo.com');
  await fetch(`${base}/rescate`, { method: 'POST', body: fd });

  const html = await (await fetch(`${base}/admin/stats`)).text();
  // 'face-1' es el id sintético que este fakeMatcher le puso a la firma
  // indexada — el chequeo real. El substring genérico "face-" NO sirve: la
  // clase CSS .face-noscript del script de miniaturas (src/html.js, en TODA
  // página vía layout()) da un falso positivo que no tiene nada que ver con
  // face_id.
  for (const leak of [
    'Fernanda',
    'Rios',
    'familia-fernanda',
    '300 555 1212',
    'rescatista-fernanda',
    'face-1',
    'person_id',
    'update_id'
  ]) {
    assert.ok(!html.includes(leak), `el panel no debe contener "${leak}"`);
  }
});

test('las cifras del panel coinciden con gatherReportData — la misma fuente que usa el correo', async (t) => {
  const matcher = fakeMatcher();
  const { server, base, store } = await startApp(matcher);
  t.after(() => {
    server.close();
    cleanupEnv();
  });
  process.env.PUBLIC_STATS = '1';

  // Cinco coincidencias distintas — arriba del umbral de supresión (#132),
  // para que el total salga exacto en las dos superficies y la comparación
  // pruebe una igualdad real, no dos "<5" que coincidirían por casualidad.
  for (let i = 0; i < 5; i++) {
    const face = `gustavo-panel-${i}`;
    await reportMissing(base, { name: `Gustavo Prueba Panel ${i}`, contact: `gustavo${i}@ejemplo.com`, face });
    const fd = new FormData();
    fd.set('photo', new File([await photoBytes(face)], 'r.jpg', { type: 'image/jpeg' }));
    fd.set('email', `rescatista${i}@ejemplo.com`);
    await fetch(`${base}/rescate`, { method: 'POST', body: fd });
  }

  // La MISMA función que arma el correo — no una consulta distinta que
  // pueda divergir.
  const data = await gatherReportData(store, matcher);
  assert.ok(data.activity.match.total >= 5, 'debía haber al menos 5 coincidencias para quedar arriba del umbral de supresión');

  const html = await (await fetch(`${base}/admin/stats`)).text();
  assert.match(html, new RegExp(`<strong>${data.activity.match.total}</strong>`), 'el total de coincidencias del panel debe ser el mismo número que gatherReportData');
});

test('#132 supresión de celdas pequeñas: un total chico sale como "<5" en el panel, nunca el número exacto', async (t) => {
  const matcher = fakeMatcher();
  const { server, base } = await startApp(matcher);
  t.after(() => {
    server.close();
    cleanupEnv();
  });
  process.env.PUBLIC_STATS = '1';

  // Una sola coincidencia — justo el caso que #132 no puede dejar pasar: un
  // conteo de 1 en una app de personas desaparecidas describe a una persona
  // puntual.
  await reportMissing(base, { name: 'Persona Chica Prueba', contact: 'chica@ejemplo.com', face: 'chica' });
  const fd = new FormData();
  fd.set('photo', new File([await photoBytes('chica')], 'r.jpg', { type: 'image/jpeg' }));
  fd.set('email', 'rescatista-chica@ejemplo.com');
  await fetch(`${base}/rescate`, { method: 'POST', body: fd });

  const html = await (await fetch(`${base}/admin/stats`)).text();
  assert.ok(!/<strong>1<\/strong>/.test(html), 'un total de 1 nunca debe salir exacto en el panel');
  assert.match(html, /&lt;5/, 'el panel debe mostrar la cifra suprimida como &lt;5');
});

test('#132 puntos 5-6: el embudo del encuentro y "nadie a quien avisar" contra datos reales, de principio a fin', async (t) => {
  const sg = await fakeSendgrid();
  const BUZON = 'buzon-embudo@ejemplo.com';
  process.env.AVISO_EMAIL = BUZON;
  process.env.PUBLIC_STATS = '1';
  const matcher = fakeMatcher();
  const { server, base, store } = await startApp(matcher);
  t.after(() => {
    sg.stop();
    server.close();
    delete process.env.AVISO_EMAIL;
    cleanupEnv();
  });

  // 5 rescates CON contacto (relevo activo por omisión → 5 avisos al buzón
  // del equipo) y 5 rescates SIN contacto (nadie a quien avisar) — el mínimo
  // para que TODAS las cifras de esta prueba queden arriba del umbral de
  // supresión (5) y se puedan comparar exactas.
  //
  // Etiquetas de cara elegidas a mano: el hash-a-color de photoBytes es
  // multiplicativo (`h = h*31 + charCode`), así que etiquetas "vecinas" tipo
  // `embudo-con-0`/`embudo-con-1` producen colores que la compresión JPEG
  // termina cuantizando al MISMO byte a byte — "caras" distintas que el
  // fakeMatcher ve como una sola. Estas diez sí producen bytes distintos
  // (verificado a mano antes de escribir la prueba).
  const CON_FACES = ['embudo-a1', 'embudo-b2', 'embudo-c3', 'embudo-d4', 'embudo-e5'];
  const SIN_FACES = ['embudo-f6', 'embudo-g7', 'embudo-h8', 'embudo-i9', 'embudo-j0'];
  const conContactoNames = [];
  for (let i = 0; i < 5; i++) {
    const face = CON_FACES[i];
    const name = `Persona Embudo Con Contacto ${i}`;
    conContactoNames.push(name);
    await reportMissing(base, { name, contact: `familia-con-${i}@ejemplo.com`, face });
    const fd = new FormData();
    fd.set('photo', new File([await photoBytes(face)], 'r.jpg', { type: 'image/jpeg' }));
    fd.set('email', `rescatista-con-${i}@ejemplo.com`);
    await fetch(`${base}/rescate`, { method: 'POST', body: fd });
  }
  for (let i = 0; i < 5; i++) {
    const face = SIN_FACES[i];
    await reportMissing(base, { name: `Persona Embudo Sin Contacto ${i}`, contact: `familia-sin-${i}@ejemplo.com`, face });
    const fd = new FormData();
    fd.set('photo', new File([await photoBytes(face)], 'r.jpg', { type: 'image/jpeg' }));
    // Sin email ni teléfono — el rescatista no deja cómo avisarle.
    await fetch(`${base}/rescate`, { method: 'POST', body: fd });
  }

  // Escalón 4: 5 de las personas encontradas quedan "a salvo" en su estado
  // más reciente — directo por el store, sin pasar por ningún aviso de esta
  // app (el punto que hace que el último escalón sea un piso, no un total).
  for (const name of conContactoNames) {
    const { person } = await store.findOrCreatePerson(name);
    await store.addUpdate(person.id, { status: 'safe', source: 'web' });
  }

  const data = await gatherReportData(store, matcher);
  assert.equal(data.activity.match.total, 10, '10 rescates → 10 coincidencias de superficie rescate');
  assert.equal(data.activity.match.rescate, 10);

  const html = await (await fetch(`${base}/admin/stats`)).text();

  // Punto 5: "nadie a quien avisar" — exacto, honesto, con las palabras del issue.
  const p5start = html.indexOf('Qué pasó después de cada coincidencia');
  const p5end = html.indexOf('El embudo del encuentro');
  assert.ok(p5start >= 0 && p5end > p5start, 'la sección del punto 5 debía existir');
  const p5 = html.slice(p5start, p5end);
  assert.match(p5, />5</, 'las 5 consultas sin contacto deben salir exactas (arriba del umbral de supresión)');
  assert.match(p5, /MÁS COMÚN/);
  assert.match(p5, /correcto/i);
  // Relevo activo por omisión + AVISO_EMAIL configurada + SendGrid falso que
  // responde 202 → los 5 avisos de "con contacto" SÍ llegaron al buzón del
  // equipo. Nada salió directo (el modo relevo lo impide por diseño).
  assert.match(p5, /esperando que una persona los revise/i);

  // Punto 6: el embudo completo, acumulado.
  const p6start = html.indexOf('El embudo del encuentro (acumulado)');
  assert.ok(p6start >= 0, 'la sección del punto 6 debía existir');
  const p6 = html.slice(p6start);
  assert.match(p6, />10</, 'escalón 1 y 2 (registrada, entregada) deben mostrar 10 — las 10 coincidencias son todas de superficie rescate');
  assert.match(p6, />5</, 'escalón 3 (avisada) y 4 (a salvo) deben mostrar 5 cada uno');
  assert.match(p6, /PISO, no un total/);
  assert.match(p6, /La app no puede ver el abrazo/i);

  // Los avisos SÍ llegaron al buzón falso — confirma que "esperando
  // intervención humana" en el punto 5 no es una cifra inventada. Los otros
  // 5 correos de las 10 recibidas son la verificación de suscripción de cada
  // rescatista (esa SÍ va directa a su dueño, nunca por relevo — regla
  // aparte, ya cubierta por test/relay.test.js).
  const alBuzon = sg.received.filter((mail) => new RegExp(BUZON).test(JSON.stringify(mail.body.personalizations)));
  assert.equal(alBuzon.length, 5, 'los 5 avisos de "con contacto" debían llegar al SendGrid falso, vía relevo');
  for (const mail of alBuzon) {
    assert.doesNotMatch(
      JSON.stringify(mail.body.personalizations),
      /rescatista-con-/,
      'un correo al buzón del equipo nunca puede ir TAMBIÉN al rescatista'
    );
  }

  // Cero PII nueva: ningún nombre, correo o teléfono de los que sembró esta
  // prueba puede aparecer en el HTML del panel.
  for (const leak of ['Embudo Con Contacto', 'Embudo Sin Contacto', 'familia-con-', 'familia-sin-', 'rescatista-con-']) {
    assert.ok(!html.includes(leak), `el panel no debe contener "${leak}"`);
  }
});

// La sección "Qué sabemos de cada coincidencia — y qué pudo haber pasado".
//
// Lo que esta prueba protege NO es una cifra bonita: es que el panel siga
// separando el único desenlace comprobable (se mostró en una pantalla) del
// resto, y que los límites declarados no se caigan solos en un refactor. Un
// panel que pierda estas frases vuelve a leerse como si cada coincidencia
// fuera un suceso con desenlace conocido, que es justo lo que no es.
test('el panel separa las coincidencias que se mostraron en pantalla de las que no, y declara lo que no se puede saber', async (t) => {
  const sg = await fakeSendgrid();
  process.env.PUBLIC_STATS = '1';
  const matcher = fakeMatcher();
  const { server, base, store } = await startApp(matcher);
  t.after(() => {
    sg.stop();
    server.close();
    cleanupEnv();
  });

  // 5 coincidencias de superficie RESCATE: se reporta a alguien y después un
  // rescatista sube esa misma cara.
  // Etiquetas verificadas a mano: el hash-a-color de photoBytes es
  // multiplicativo, así que etiquetas vecinas producen colores que la
  // compresión JPEG cuantiza a la misma imagen. Y la colisión que de verdad
  // muerde es más sutil: fakeMatcher indexa por `bytes.toString('utf8')`, y
  // esa conversión colapsa secuencias binarias inválidas distintas en la
  // MISMA cadena — dos JPEG que difieren byte a byte pueden ser una sola cara
  // para el matcher falso. Estas diez se eligieron distintas bajo ESA llave.
  const RESCATE_FACES = ['saber-0', 'saber-1', 'saber-3', 'saber-5', 'saber-7'];
  for (let i = 0; i < RESCATE_FACES.length; i++) {
    const face = RESCATE_FACES[i];
    await reportMissing(base, { name: `Persona Saber Rescate ${i}`, contact: `saber-r${i}@ejemplo.com`, face });
    const fd = new FormData();
    fd.set('photo', new File([await photoBytes(face)], 'r.jpg', { type: 'image/jpeg' }));
    await fetch(`${base}/rescate`, { method: 'POST', body: fd });
  }

  // 5 coincidencias de superficie REPORTE: el orden inverso al de arriba —
  // primero pasa el rescatista (sin nadie reportado todavía, así que su
  // consulta no coincide con nada) y DESPUÉS la familia reporta esa misma
  // cara. El cruce se registra del lado del reporte, sin pantalla que nadie
  // mire: es justo la coincidencia cuyo desenlace esta base no puede probar.
  const REPORTE_FACES = ['saber-8', 'saber-9', 'saber-10', 'saber-12', 'saber-14'];
  for (let i = 0; i < REPORTE_FACES.length; i++) {
    const face = REPORTE_FACES[i];
    const fd = new FormData();
    fd.set('photo', new File([await photoBytes(face)], 'r.jpg', { type: 'image/jpeg' }));
    await fetch(`${base}/rescate`, { method: 'POST', body: fd });
    await reportMissing(base, { name: `Persona Saber Reporte ${i}`, contact: `saber-p${i}@ejemplo.com`, face });
  }

  const data = await gatherReportData(store, matcher);
  assert.equal(data.activity.match.rescate, 5, '5 coincidencias de superficie rescate');
  assert.equal(data.activity.match.report, 5, '5 coincidencias de superficie reporte');
  assert.equal(data.activity.match.total, 10);

  const html = await (await fetch(`${base}/admin/stats`)).text();
  const start = html.indexOf('Qué sabemos de cada coincidencia');
  const end = html.indexOf('Qué pasó después de cada coincidencia');
  assert.ok(start >= 0 && end > start, 'la sección debía existir, antes de "Qué pasó después de cada coincidencia"');
  const s = html.slice(start, end);

  // Las dos casillas del reparto salen exactas: 5 y 5, ambas arriba del
  // umbral de supresión, y suman el mismo total que la tarjeta de arriba.
  assert.match(s, /Se mostraron en una pantalla[\s\S]*?>5</, 'las 5 de rescate deben salir como "se mostraron en una pantalla"');
  assert.match(s, /No tuvieron pantalla[\s\S]*?>5</, 'las 5 de reporte deben salir como "no tuvieron pantalla"');

  // El único desenlace que la base puede probar, dicho con esas palabras.
  assert.match(s, /único desenlace que esta base puede probar/i);

  // Los límites declarados: si alguno desaparece, el panel promete más
  // certeza de la que tiene.
  assert.match(s, /no guarda <code>match_id<\/code>/i, 'debe seguir diciendo por qué no se puede atar aviso y coincidencia');
  assert.match(s, /falso positivo/i, 'debe seguir nombrando el falso positivo como desenlace posible');
  assert.match(s, /no puede verlo/i, 'debe seguir diciendo que el reencuentro no es observable');
  assert.match(s, /indistinguibles entre sí/i, 'debe seguir diciendo cuáles desenlaces no se pueden separar');
  assert.match(s, /decisión de una persona, no de este panel/i, 'el cambio de esquema se declara como decisión humana');

  // Y nada de PII en el HTML, igual que el resto del panel.
  for (const leak of ['Saber Rescate', 'Saber Reporte', 'saber-r', 'saber-p', 'saber-q']) {
    assert.ok(!html.includes(leak), `el panel no debe contener "${leak}"`);
  }
});
