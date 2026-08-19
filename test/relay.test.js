// Modo relevo: ningún aviso a un tercero sale solo.
//
// El caso duro es la coincidencia facial. Su cuerpo lleva el contacto de la
// familia y su destinatario es alguien que dice haber rescatado a la persona,
// sin que nadie lo haya verificado: entregarle ese dato es un vector de
// extorsión. Estas pruebas fijan que con el relevo activo nada llega al
// tercero y todo llega al buzón del operador con el contexto para enrutarlo, y
// que con `NOTIFY_MODE=direct` el comportamiento anterior queda intacto.
//
// Todos los correos y teléfonos de acá son inventados.
const test = require('node:test');
const assert = require('node:assert');
const sharp = require('sharp');
const { createSqliteAdapter } = require('../src/store/sqlite');
const { createApp } = require('../src/server');
const { nullMatcher } = require('../src/faces');
const { fakeSendgrid } = require('./helpers');

const BUZON = 'operacion@ejemplo.com';

// Misma forma que devuelve Rekognition; bytes idénticos = mismo rostro.
const FAKE_GEOMETRY = {
  box: { l: 0.25, t: 0.1, w: 0.5, h: 0.6 },
  points: [{ t: 'nose', x: 0.5, y: 0.45 }],
  pose: { roll: 0, yaw: 0, pitch: 0 },
  confidence: 99.5
};

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

// JPEGs de verdad: las miniaturas se decodifican y recortan.
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
  const app = await createApp(await createSqliteAdapter(':memory:'), matcher || nullMatcher);
  const server = await new Promise((resolve) => {
    const s = app.listen(0, () => resolve(s));
  });
  return { server, base: `http://127.0.0.1:${server.address().port}`, store: app.locals.store };
}

const to = (mail) => JSON.stringify(mail.body.personalizations);
const text = (mail) => mail.body.content[0].value;

test('relevo activo: la actualización no llega al suscriptor, llega al buzón con el contexto', async (t) => {
  const sg = await fakeSendgrid();
  process.env.AVISO_EMAIL = BUZON;
  const app = await startApp();
  t.after(() => {
    sg.stop();
    app.server.close();
    delete process.env.AVISO_EMAIL;
  });

  const { person } = await app.store.findOrCreatePerson('Hernán Duque Prueba');
  const { sub } = await app.store.subscribe(person.id, 'email', 'tio@ejemplo.com');
  await app.store.verifySubscription(sub.verify_token);
  sg.received.length = 0;

  const res = await fetch(`${app.base}/api/updates`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: 'Hernán Duque Prueba', status: 'safe', message: 'Está en el albergue' })
  });
  assert.equal(res.status, 201);

  assert.equal(sg.received.length, 1, 'exactamente un correo: el relevo');
  const mail = sg.received[0];
  assert.match(to(mail), new RegExp(BUZON), 'el correo va al buzón del operador');
  assert.doesNotMatch(to(mail), /tio@ejemplo\.com/, 'nada puede salir a la dirección del tercero');

  // Al humano le tiene que bastar este correo para enrutar sin abrir la base.
  assert.match(mail.body.subject, /^\[RETENIDO\] /, 'asunto con prefijo estable y grepeable');
  assert.match(mail.body.subject, /Hernán Duque Prueba/);
  const body = text(mail);
  assert.match(body, /NO se envió/, 'tiene que decir que está retenido, no enviado');
  assert.match(body, /Iba dirigido a: tio@ejemplo\.com/);
  assert.match(body, /Canal: correo/);
  assert.match(body, /\/person\/\d+/, 'el enlace a la ficha');
  assert.match(body, /A SALVO/, 'el texto que se le iba a decir');
  assert.match(body, /unsubscribe\?token=/);
});

test('relevo activo: la coincidencia facial no llega al rescatista, y el contacto de la familia viaja al buzón', async (t) => {
  const sg = await fakeSendgrid();
  process.env.AVISO_EMAIL = BUZON;
  const app = await startApp(fakeMatcher());
  t.after(() => {
    sg.stop();
    app.server.close();
    delete process.env.AVISO_EMAIL;
  });

  // El rescatista sube una foto y deja su correo.
  const fd = new FormData();
  fd.set('photo', new File([await photoBytes('nn')], 'r.jpg', { type: 'image/jpeg' }));
  fd.set('email', 'rescatista@ejemplo.com');
  await fetch(`${app.base}/rescate`, { method: 'POST', body: fd });

  // La verificación NO se releva: va derecho al dueño de la dirección.
  assert.equal(sg.received.length, 1);
  assert.match(to(sg.received[0]), /rescatista@ejemplo\.com/, 'la verificación va directa, siempre');
  assert.doesNotMatch(sg.received[0].body.subject, /RETENIDO/);
  const link = /https?:\/\/[^\s]+\/verify\?token=([a-f0-9]+)/.exec(text(sg.received[0]));
  assert.ok(link, 'el correo de verificación debe traer el enlace');
  await fetch(`${app.base}/verify?token=${link[1]}`);
  sg.received.length = 0;

  // Más tarde, una familia reporta a esa misma persona como desaparecida.
  const rf = new FormData();
  rf.set('name', 'Rosa Elvira Prueba');
  rf.set('location', 'Barrio San José');
  rf.set('department', 'Antioquia');
  rf.set('contact', '300 000 0000');
  rf.append('photos', new File([await photoBytes('nn')], 'f.jpg', { type: 'image/jpeg' }));
  await fetch(`${app.base}/report`, { method: 'POST', body: rf, redirect: 'manual' });

  assert.equal(sg.received.length, 1, 'exactamente un correo: el relevo');
  const mail = sg.received[0];
  assert.match(to(mail), new RegExp(BUZON));
  assert.doesNotMatch(to(mail), /rescatista@ejemplo\.com/, 'el aviso no puede salirle al rescatista sin verificar');

  const body = text(mail);
  assert.match(body, /Iba dirigido a: rescatista@ejemplo\.com/);
  assert.match(body, /Coincidencia facial: 97%/, 'el porcentaje, para poder juzgar la coincidencia');
  assert.match(body, /Contacto de quien la busca.*300 000 0000/);
  assert.match(body, /Rosa Elvira Prueba/);
  assert.match(body, /\/person\/\d+/);
  assert.match(body, /alguien está buscando a la persona que rescataste/i, 'el texto original, íntegro');
});

test('relevo apagado (NOTIFY_MODE=direct): el aviso le llega al rescatista SIN el contacto, y el operador recibe su copia CON el contacto', async (t) => {
  const sg = await fakeSendgrid();
  process.env.NOTIFY_MODE = 'direct';
  process.env.AVISO_EMAIL = BUZON;
  const app = await startApp(fakeMatcher());
  t.after(() => {
    sg.stop();
    app.server.close();
    delete process.env.NOTIFY_MODE;
    delete process.env.AVISO_EMAIL;
  });

  const fd = new FormData();
  fd.set('photo', new File([await photoBytes('nn')], 'r.jpg', { type: 'image/jpeg' }));
  fd.set('email', 'rescatista@ejemplo.com');
  await fetch(`${app.base}/rescate`, { method: 'POST', body: fd });
  const link = /https?:\/\/[^\s]+\/verify\?token=([a-f0-9]+)/.exec(text(sg.received[0]));
  await fetch(`${app.base}/verify?token=${link[1]}`);
  sg.received.length = 0;

  const rf = new FormData();
  rf.set('name', 'Rosa Elvira Prueba');
  rf.set('location', 'Barrio San José');
  rf.set('department', 'Antioquia');
  rf.set('contact', '300 000 0000');
  rf.append('photos', new File([await photoBytes('nn')], 'f.jpg', { type: 'image/jpeg' }));
  await fetch(`${app.base}/report`, { method: 'POST', body: rf, redirect: 'manual' });

  // Dos correos: el del rescatista y la copia del operador. Antes salía uno
  // solo, y llevaba el teléfono de la familia adentro.
  assert.equal(sg.received.length, 2);

  const alRescatista = sg.received.find((m) => /rescatista@ejemplo\.com/.test(to(m)));
  assert.ok(alRescatista, 'en directo el aviso sí va al destinatario');
  assert.doesNotMatch(alRescatista.body.subject, /RETENIDO/);
  assert.match(text(alRescatista), /alguien está buscando a la persona que rescataste/i);
  assert.doesNotMatch(
    text(alRescatista),
    /300 000 0000/,
    'el contacto de la familia no sale por correo, tampoco en modo directo'
  );
  assert.match(text(alRescatista), /No damos el contacto de su familia por este medio/);

  // Y el caso no se queda huérfano: alguien sabe dónde está una persona, así
  // que el dato que permite cerrarlo le llega a un humano.
  const alOperador = sg.received.find((m) => new RegExp(BUZON).test(to(m)));
  assert.ok(alOperador, 'el operador tiene que recibir su copia');
  assert.match(text(alOperador), /300 000 0000/);
  assert.match(
    text(alOperador),
    /SÍ se envió a su destinatario, pero SIN el contacto/,
    'la copia no puede decir "no se envió" cuando sí se envió: eso duplica avisos'
  );
});

test('un NOTIFY_MODE que no se reconoce cae a relevo: el interruptor falla cerrado', async (t) => {
  const sg = await fakeSendgrid();
  process.env.NOTIFY_MODE = 'directo'; // errata verosímil
  process.env.AVISO_EMAIL = BUZON;
  const app = await startApp();
  t.after(() => {
    sg.stop();
    app.server.close();
    delete process.env.NOTIFY_MODE;
    delete process.env.AVISO_EMAIL;
  });

  const { person } = await app.store.findOrCreatePerson('Aurora Prueba Ríos');
  const { sub } = await app.store.subscribe(person.id, 'email', 'vecina@ejemplo.com');
  await app.store.verifySubscription(sub.verify_token);
  sg.received.length = 0;

  await fetch(`${app.base}/api/updates`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: 'Aurora Prueba Ríos', status: 'safe' })
  });

  assert.equal(sg.received.length, 1);
  assert.match(to(sg.received[0]), new RegExp(BUZON));
  assert.doesNotMatch(to(sg.received[0]), /vecina@ejemplo\.com/);

  const diag = await (await fetch(`${app.base}/api/diag`)).json();
  assert.equal(diag.notifications.mode, 'relay');
});

test('relevo activo sin AVISO_EMAIL: no sale nada, y /api/diag lo dice', async (t) => {
  const sg = await fakeSendgrid();
  delete process.env.AVISO_EMAIL;
  const app = await startApp();
  t.after(() => {
    sg.stop();
    app.server.close();
  });

  const { person } = await app.store.findOrCreatePerson('Ismael Prueba Ávila');
  const { sub } = await app.store.subscribe(person.id, 'email', 'primo@ejemplo.com');
  await app.store.verifySubscription(sub.verify_token);
  sg.received.length = 0;

  const res = await fetch(`${app.base}/api/updates`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: 'Ismael Prueba Ávila', status: 'safe' })
  });
  // El reporte se guarda igual: una falla de nuestra configuración no puede
  // tumbar lo que alguien vino a hacer.
  assert.equal(res.status, 201);
  // Y no se cae a envío directo: eso reabriría el riesgo justo cuando la
  // configuración ya está rota. El aviso queda entero en el log, ruidoso.
  assert.equal(sg.received.length, 0, 'sin buzón no sale nada, tampoco al tercero');

  const diag = await (await fetch(`${app.base}/api/diag`)).json();
  assert.equal(diag.notifications.mode, 'relay');
  assert.equal(diag.notifications.relay_mailbox_present, false);
  assert.equal(diag.notifications.relay_without_mailbox, true, 'la combinación fatal tiene que verse desde afuera');
});

test('/api/diag reporta el modo vigente y el buzón, sin exponer la dirección', async (t) => {
  process.env.AVISO_EMAIL = BUZON;
  const app = await startApp();
  t.after(() => {
    app.server.close();
    delete process.env.AVISO_EMAIL;
  });

  const diag = await (await fetch(`${app.base}/api/diag`)).json();
  assert.equal(diag.notifications.mode, 'relay', 'el relevo es el modo por omisión');
  assert.equal(diag.notifications.relay_mailbox_present, true);
  assert.equal(diag.notifications.relay_without_mailbox, false);
  assert.doesNotMatch(JSON.stringify(diag), new RegExp(BUZON), 'presencia sí, la dirección no');
});
