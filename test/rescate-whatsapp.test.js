// El rescatista y sus canales: cuándo un aviso se retiene, cuándo se releva y
// cuándo —solo cuándo— sale con el contacto de una familia adentro.
//
// Dos reglas se fijan acá:
//
//   1. Una suscripción SIN verificar no hace que el aviso se pierda. Sí bloquea
//      el envío directo, que es el único camino donde el mensaje sale hacia una
//      dirección que nadie comprobó; en modo relevo el aviso llega al buzón del
//      operador, marcado, para que una persona decida.
//   2. Por WhatsApp el primer mensaje es una PLANTILLA que solo pregunta. El
//      contacto de la familia espera a que respondan que sí.
//
// Todos los nombres, correos y teléfonos de este archivo son inventados.
const test = require('node:test');
const assert = require('node:assert');
const sharp = require('sharp');
const { createSqliteAdapter } = require('../src/store/sqlite');
const { createApp } = require('../src/server');
const { fakeSendgrid, fakeWhatsApp } = require('./helpers');

const BUZON = 'operacion@ejemplo.com';
const PLANTILLA = 'rescate_confirmacion';

const FAKE_GEOMETRY = {
  box: { l: 0.25, t: 0.1, w: 0.5, h: 0.6 },
  points: [{ t: 'nose', x: 0.5, y: 0.45 }],
  pose: { roll: 0, yaw: 0, pitch: 0 },
  confidence: 99.5
};

// Bytes idénticos = mismo rostro, así toda la cadena corre sin AWS.
function fakeMatcher() {
  const indexed = new Map();
  let n = 0;
  const key = (b) => b.toString('utf8');
  return {
    enabled: true,
    async indexFace(bytes) {
      const id = `face-${++n}`;
      if (!indexed.has(key(bytes))) indexed.set(key(bytes), []);
      indexed.get(key(bytes)).push(id);
      return { faceId: id, geometry: FAKE_GEOMETRY };
    },
    async detectFace() {
      return FAKE_GEOMETRY;
    },
    async searchByImage(bytes) {
      return (indexed.get(key(bytes)) || []).map((faceId) => ({ faceId, similarity: 97 }));
    }
  };
}

const jpegCache = new Map();
async function photoBytes(label) {
  if (!jpegCache.has(label)) {
    let h = 0;
    for (const ch of label) h = (h * 31 + ch.charCodeAt(0)) % 16777216;
    jpegCache.set(
      label,
      await sharp({
        create: { width: 400, height: 500, channels: 3, background: { r: (h >> 16) & 255, g: (h >> 8) & 255, b: h & 255 } }
      })
        .jpeg()
        .toBuffer()
    );
  }
  return jpegCache.get(label);
}

async function startApp(matcher) {
  const app = await createApp(await createSqliteAdapter(':memory:'), matcher || fakeMatcher());
  const server = await new Promise((resolve) => {
    const s = app.listen(0, () => resolve(s));
  });
  return { server, base: `http://127.0.0.1:${server.address().port}`, store: app.locals.store };
}

async function rescate(base, { face, email, phone, searchOnly }) {
  const fd = new FormData();
  fd.set('photo', new File([await photoBytes(face)], 'r.jpg', { type: 'image/jpeg' }));
  if (email) fd.set('email', email);
  if (phone) fd.set('phone', phone);
  if (searchOnly) fd.set('solo_busqueda', '1');
  return fetch(`${base}/rescate`, { method: 'POST', body: fd });
}

async function reportar(base, { name, contact, face }) {
  const fd = new FormData();
  fd.set('name', name);
  fd.set('location', 'Barrio San José');
  fd.set('contact', contact);
  fd.append('photos', new File([await photoBytes(face)], 'f.jpg', { type: 'image/jpeg' }));
  return fetch(`${base}/report`, { method: 'POST', body: fd, redirect: 'manual' });
}

// Simula un mensaje entrante de Meta.
async function inbound(base, { from, text, button }) {
  const msg = button
    ? { from, type: 'button', button: { text: button } }
    : { from, type: 'text', text: { body: text } };
  return fetch(`${base}/webhooks/whatsapp`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ entry: [{ changes: [{ value: { messages: [msg] } }] }] })
  });
}

const to = (mail) => JSON.stringify(mail.body.personalizations);
const text = (mail) => mail.body.content[0].value;

// ------------------------------------------------------ el gate de verificación

test('una coincidencia contra una suscripción SIN verificar llega al relevo, no se descarta', async (t) => {
  const sg = await fakeSendgrid();
  process.env.AVISO_EMAIL = BUZON;
  const app = await startApp();
  t.after(() => {
    sg.stop();
    app.server.close();
    delete process.env.AVISO_EMAIL;
  });

  // El rescatista deja su correo y NO confirma el enlace: queda sin verificar,
  // que es el estado de la enorme mayoría de las suscripciones reales.
  await rescate(app.base, { face: 'nn', email: 'rescatista@ejemplo.com' });
  sg.received.length = 0;

  await reportar(app.base, { name: 'Rosa Elvira Prueba', contact: '300 000 0000', face: 'nn' });

  assert.equal(sg.received.length, 1, 'el aviso tiene que existir: antes se perdía en silencio');
  const mail = sg.received[0];
  assert.match(to(mail), new RegExp(BUZON), 'va al buzón del operador');
  assert.doesNotMatch(to(mail), /rescatista@ejemplo\.com/, 'nunca a la dirección sin verificar');

  // Y el humano tiene que enterarse de que no está verificada: eso cambia lo
  // que decide hacer con el aviso.
  assert.match(mail.body.subject, /SIN verificar/);
  assert.match(text(mail), /NO está verificada/);
  assert.match(text(mail), /Contacto de quien la busca.*300 000 0000/);
});

test('esa misma suscripción sin verificar NUNCA produce un envío directo', async (t) => {
  const sg = await fakeSendgrid();
  process.env.NOTIFY_MODE = 'direct';
  process.env.AVISO_EMAIL = BUZON;
  const app = await startApp();
  t.after(() => {
    sg.stop();
    app.server.close();
    delete process.env.NOTIFY_MODE;
    delete process.env.AVISO_EMAIL;
  });

  await rescate(app.base, { face: 'nn', email: 'rescatista@ejemplo.com' });
  sg.received.length = 0;

  await reportar(app.base, { name: 'Rosa Elvira Prueba', contact: '300 000 0000', face: 'nn' });

  assert.equal(
    sg.received.length,
    0,
    'sin relevo y sin verificar no sale nada: el corte vive en el camino de envío'
  );
});

// ------------------------------------------------------------ el número tecleado

test('el WhatsApp del formulario queda con la forma que usa el bot, y sin verificar', async (t) => {
  const app = await startApp();
  t.after(() => app.server.close());

  await rescate(app.base, { face: 'a', phone: '300 123 4567' });
  await rescate(app.base, { face: 'b', phone: '+57 300 123 4567' });

  // Las dos formas de escribir el mismo teléfono tienen que aterrizar en la
  // misma dirección; si no, la baja y la deduplicación no lo vuelven a hallar.
  const subs = await app.store.subscriptionsForAddress('whatsapp', '573001234567');
  assert.equal(subs.length, 2, 'los dos rescates apuntan al mismo número normalizado');
  for (const s of subs) {
    assert.ok(!s.verified, 'un número tecleado no lo comprueba nadie: nace sin verificar');
  }
});

test('un número que no parece teléfono se ignora en silencio, sin trancar el formulario', async (t) => {
  const app = await startApp();
  t.after(() => app.server.close());

  await reportar(app.base, { name: 'Camila Prueba Rojas', contact: '300 111 2222', face: 'camila' });
  const res = await rescate(app.base, { face: 'camila', phone: 'no tengo, llámenme al fijo' });

  assert.equal(res.status, 200, 'el rescate no se puede caer por el formato de un campo opcional');
  assert.match(await res.text(), /Camila Prueba Rojas/, 'la coincidencia se muestra igual');
  assert.equal((await app.store.counts()).subscriptions, 0, 'no se guardó ninguna dirección inservible');
});

// ------------------------------------------------------ modo solo búsqueda

test('la casilla de solo búsqueda viene apagada y dice lo que cuesta antes de marcarla', async (t) => {
  const app = await startApp();
  t.after(() => app.server.close());

  const html = await (await fetch(`${app.base}/rescate`)).text();
  assert.match(html, /name="solo_busqueda"/);
  // Apagada: sin `checked` en ninguna parte de esa casilla.
  assert.doesNotMatch(html, /name="solo_busqueda"[^>]*checked/);
  // Y el costo se lee ahí mismo, no después de haber consultado.
  assert.match(html, /no vamos a poder avisarte si alguien reporta a esta persona/i);
});

test('solo búsqueda: encuentra la coincidencia y no deja ancla, ni foto, ni firma indexada', async (t) => {
  const matcher = fakeMatcher();
  let indexadas = 0;
  const indexFace = matcher.indexFace.bind(matcher);
  matcher.indexFace = async (...args) => {
    indexadas++;
    return indexFace(...args);
  };
  const app = await startApp(matcher);
  t.after(() => app.server.close());

  await reportar(app.base, { name: 'Rosa Elvira Prueba', contact: '300 000 0000', face: 'nn' });
  const antes = await app.store.counts();
  indexadas = 0;

  const html = await (
    await rescate(app.base, { face: 'nn', email: 'rescatista@ejemplo.com', phone: '311 222 3344', searchOnly: true })
  ).text();

  // La consulta sirve: la coincidencia se ve y el contacto también.
  assert.match(html, /Rosa Elvira Prueba/);
  assert.match(html, /300 000 0000/);

  const despues = await app.store.counts();
  assert.equal(despues.people, antes.people, 'no se crea la persona ancla');
  assert.equal(despues.photos, antes.photos, 'no queda fila de foto');
  assert.equal(despues.subscriptions, 0, 'ni correo ni WhatsApp dejan suscripción');
  assert.equal(indexadas, 0, 'nada nuevo entra a la colección facial');
  // Y se lo decimos, para que nadie crea que quedó esperando un aviso.
  assert.match(html, /no vamos a poder avisarte/i);
});

test('solo búsqueda sin coincidencias dice que no quedó nada esperando', async (t) => {
  const app = await startApp();
  t.after(() => app.server.close());

  const html = await (
    await rescate(app.base, { face: 'desconocido', email: 'rescatista@ejemplo.com', searchOnly: true })
  ).text();

  assert.match(html, /Nadie ha reportado a esta persona/);
  assert.match(html, /no vamos a poder avisarte/i);
  assert.doesNotMatch(html, /Te avisaremos/, 'no se puede prometer un aviso que no va a existir');
  assert.equal((await app.store.counts()).subscriptions, 0);
});

test('solo búsqueda no manda nada por WhatsApp ni por correo', async (t) => {
  const wa = await fakeWhatsApp();
  const sg = await fakeSendgrid();
  process.env.AVISO_EMAIL = BUZON;
  process.env.WHATSAPP_TEMPLATE_RESCUE_CONFIRM = PLANTILLA;
  const app = await startApp();
  t.after(() => {
    wa.stop();
    sg.stop();
    app.server.close();
    delete process.env.AVISO_EMAIL;
    delete process.env.WHATSAPP_TEMPLATE_RESCUE_CONFIRM;
  });

  await reportar(app.base, { name: 'Rosa Elvira Prueba', contact: '300 000 0000', face: 'nn' });
  sg.received.length = 0;

  await rescate(app.base, { face: 'nn', email: 'rescatista@ejemplo.com', phone: '311 222 3344', searchOnly: true });

  assert.equal(wa.received.length, 0, 'la plantilla también deja una fila: en este modo no sale');
  assert.equal(sg.received.length, 0, 'sin suscripción no hay verificación ni aviso que relevar');
});

test('la consulta normal sigue indexando: el modo efímero es opt-in, no el nuevo default', async (t) => {
  const app = await startApp();
  t.after(() => app.server.close());

  await reportar(app.base, { name: 'Rosa Elvira Prueba', contact: '300 000 0000', face: 'nn' });
  const antes = await app.store.counts();

  await rescate(app.base, { face: 'nn', email: 'rescatista@ejemplo.com' });

  const despues = await app.store.counts();
  assert.equal(despues.photos_query, antes.photos_query + 1, 'sin marcar la casilla, la firma se sigue guardando');
  assert.equal(despues.subscriptions, 1);
});

// -------------------------------------------------- primer contacto por WhatsApp

test('la coincidencia en pantalla también sale por WhatsApp: plantilla, y sin datos de la familia', async (t) => {
  const wa = await fakeWhatsApp();
  const sg = await fakeSendgrid();
  process.env.AVISO_EMAIL = BUZON;
  process.env.WHATSAPP_TEMPLATE_RESCUE_CONFIRM = PLANTILLA;
  const app = await startApp();
  t.after(() => {
    wa.stop();
    sg.stop();
    app.server.close();
    delete process.env.AVISO_EMAIL;
    delete process.env.WHATSAPP_TEMPLATE_RESCUE_CONFIRM;
  });

  await reportar(app.base, { name: 'Rosa Elvira Prueba', contact: '300 000 0000', face: 'nn' });
  sg.received.length = 0;

  await rescate(app.base, { face: 'nn', phone: '311 222 3344' });

  assert.equal(wa.received.length, 1, 'un solo mensaje: la pregunta');
  const salida = wa.received[0].body;
  // Texto plano acá sería un 131047: el rescatista llegó por la web y no hay
  // ninguna ventana de 24 h abierta.
  assert.equal(salida.type, 'template', 'un mensaje que iniciamos nosotros tiene que ser plantilla');
  assert.equal(salida.template.name, PLANTILLA);
  assert.equal(salida.template.language.code, 'es');
  assert.equal(salida.to, '573112223344');
  assert.equal(salida.template.components[0].parameters[0].text, 'Rosa Elvira Prueba');
  assert.doesNotMatch(
    JSON.stringify(salida),
    /300 000 0000/,
    'el primer mensaje NO puede llevar el contacto de la familia'
  );

  // Y queda la fila que sostiene el estado pendiente de la pregunta.
  const subs = await app.store.subscriptionsForAddress('whatsapp', '573112223344');
  assert.ok(subs.length >= 1);
  assert.ok(subs.every((s) => !s.verified), 'nada se da por confirmado antes de que respondan');
});

test('la coincidencia en pantalla deja copia por correo, y sin verificar pasa por el relevo', async (t) => {
  const sg = await fakeSendgrid();
  process.env.AVISO_EMAIL = BUZON;
  const app = await startApp();
  t.after(() => {
    sg.stop();
    app.server.close();
    delete process.env.AVISO_EMAIL;
  });

  await reportar(app.base, { name: 'Rosa Elvira Prueba', contact: '300 000 0000', face: 'nn' });
  sg.received.length = 0;

  // La coincidencia se ve en pantalla; si cierra la página, esta es la copia
  // que sobrevive.
  await rescate(app.base, { face: 'nn', email: 'rescatista@ejemplo.com' });

  const verificacion = sg.received.find((m) => text(m).includes('/verify?token='));
  assert.ok(verificacion, 'la verificación del correo va directa, como siempre');
  const aviso = sg.received.find((m) => text(m).includes('300 000 0000'));
  assert.ok(aviso, 'la coincidencia tiene que dejar rastro fuera de la pantalla');
  assert.match(to(aviso), new RegExp(BUZON), 'sin verificar, la copia va al buzón');
  assert.doesNotMatch(to(aviso), /rescatista@ejemplo\.com/);
  assert.match(aviso.body.subject, /SIN verificar/);
});

test('sin plantilla configurada no se le escribe a nadie, y el rescate sigue funcionando', async (t) => {
  const wa = await fakeWhatsApp();
  delete process.env.WHATSAPP_TEMPLATE_RESCUE_CONFIRM;
  const app = await startApp();
  t.after(() => {
    wa.stop();
    app.server.close();
  });

  await reportar(app.base, { name: 'Rosa Elvira Prueba', contact: '300 000 0000', face: 'nn' });
  const res = await rescate(app.base, { face: 'nn', phone: '311 222 3344' });

  assert.equal(res.status, 200);
  assert.match(await res.text(), /Rosa Elvira Prueba/, 'la coincidencia se sigue viendo en pantalla');
  assert.equal(wa.received.length, 0, 'sin plantilla aprobada no se manda un texto que Meta va a rechazar');
});

// ---------------------------------------------------------- la respuesta afirmativa

test('recién cuando responden que sí se entrega el contacto (modo directo)', async (t) => {
  const wa = await fakeWhatsApp();
  const sg = await fakeSendgrid();
  process.env.NOTIFY_MODE = 'direct';
  process.env.WHATSAPP_TEMPLATE_RESCUE_CONFIRM = PLANTILLA;
  const app = await startApp();
  t.after(() => {
    wa.stop();
    sg.stop();
    app.server.close();
    delete process.env.NOTIFY_MODE;
    delete process.env.WHATSAPP_TEMPLATE_RESCUE_CONFIRM;
  });

  await reportar(app.base, { name: 'Rosa Elvira Prueba', contact: '300 000 0000', face: 'nn' });
  await rescate(app.base, { face: 'nn', phone: '311 222 3344' });
  assert.equal(wa.received.length, 1, 'hasta acá, solo la pregunta');

  await inbound(app.base, { from: '573112223344', text: 'Sí, está conmigo' });

  const cuerpos = wa.received.map((m) => JSON.stringify(m.body));
  const conContacto = cuerpos.filter((c) => c.includes('300 000 0000'));
  assert.equal(conContacto.length, 1, 'el contacto sale una sola vez, después del sí');
  assert.match(conContacto[0], /alguien está buscando a la persona que rescataste/i);
  assert.match(cuerpos[cuerpos.length - 1], /Gracias por confirmar/);

  // La respuesta desde su propio número es lo que verifica el número: prueba
  // que le pertenece y afirma el hecho, las dos cosas de una.
  const subs = await app.store.subscriptionsForAddress('whatsapp', '573112223344');
  assert.ok(subs.every((s) => s.verified), 'responder verifica el número');
});

test('en modo relevo el sí no le entrega el contacto al número: lo entrega al buzón', async (t) => {
  const wa = await fakeWhatsApp();
  const sg = await fakeSendgrid();
  process.env.AVISO_EMAIL = BUZON;
  process.env.WHATSAPP_TEMPLATE_RESCUE_CONFIRM = PLANTILLA;
  const app = await startApp();
  t.after(() => {
    wa.stop();
    sg.stop();
    app.server.close();
    delete process.env.AVISO_EMAIL;
    delete process.env.WHATSAPP_TEMPLATE_RESCUE_CONFIRM;
  });

  await reportar(app.base, { name: 'Rosa Elvira Prueba', contact: '300 000 0000', face: 'nn' });
  await rescate(app.base, { face: 'nn', phone: '311 222 3344' });
  sg.received.length = 0;

  // Botón de respuesta rápida de la plantilla: Meta no lo manda como texto.
  await inbound(app.base, { from: '573112223344', button: 'Sí, está conmigo' });

  assert.doesNotMatch(
    JSON.stringify(wa.received.map((m) => m.body)),
    /300 000 0000/,
    'la confirmación en banda no deroga el relevo: sigue habiendo humano en el circuito'
  );
  const relevo = sg.received.find((m) => text(m).includes('300 000 0000'));
  assert.ok(relevo, 'el contacto tiene que llegarle al operador');
  assert.match(relevo.body.subject, /^\[RETENIDO\] /);
  // Y al rescatista se le dice la verdad: que falta una revisión humana.
  assert.match(JSON.stringify(wa.received[wa.received.length - 1].body), /revisa cada caso/);
});

test('un "sí" de un número al que no le preguntamos nada no entrega nada', async (t) => {
  const wa = await fakeWhatsApp();
  process.env.NOTIFY_MODE = 'direct';
  const app = await startApp();
  t.after(() => {
    wa.stop();
    app.server.close();
    delete process.env.NOTIFY_MODE;
  });

  await reportar(app.base, { name: 'Rosa Elvira Prueba', contact: '300 000 0000', face: 'nn' });

  await inbound(app.base, { from: '573009998877', text: 'si' });

  const cuerpos = JSON.stringify(wa.received.map((m) => m.body));
  assert.doesNotMatch(cuerpos, /300 000 0000/, 'escribir "sí" no puede cosechar el contacto de una familia');
  assert.doesNotMatch(cuerpos, /Gracias por confirmar/, 'no hay nada que confirmar');
});
