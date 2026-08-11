const test = require('node:test');
const assert = require('node:assert');
const sharp = require('sharp');
const { createSqliteAdapter } = require('../src/store/sqlite');
const { createApp } = require('../src/server');
const { nullMatcher } = require('../src/faces');
const { fakeSendgrid } = require('./helpers');

async function startApp() {
  const app = await createApp(await createSqliteAdapter(':memory:'), nullMatcher);
  const server = await new Promise((resolve) => {
    const s = app.listen(0, () => resolve(s));
  });
  return { server, base: `http://127.0.0.1:${server.address().port}` };
}

// A real JPEG: the report path decodes it to build the thumbnail.
async function photoBytes() {
  return sharp({
    create: { width: 400, height: 500, channels: 3, background: { r: 120, g: 90, b: 60 } }
  })
    .jpeg()
    .toBuffer();
}

async function report(base, extra = {}) {
  const fd = new FormData();
  fd.set('name', 'Marta Isabel Quintero');
  fd.set('location', 'Barrio San José, Quibdó');
  fd.set('contact', 'hermana@ejemplo.com');
  fd.set('message', 'Lleva una chaqueta roja');
  for (const [k, v] of Object.entries(extra)) fd.set(k, v);
  fd.append('photos', new File([await photoBytes()], 'f.jpg', { type: 'image/jpeg' }));
  return fetch(`${base}/report`, { method: 'POST', body: fd, redirect: 'manual' });
}

// The checkbox is the family's consent to be published on a third-party
// registry, so it must be theirs to give: present, but never pre-ticked.
test('the report form offers Colombia Te Busca, unticked, right above the submit button', async (t) => {
  const { server, base } = await startApp();
  t.after(() => server.close());

  const html = await (await fetch(`${base}/report`)).text();
  assert.match(html, /Reportar también en ColombiaTeBusca\.com/);
  assert.match(html, /name="colombiatebusca"/);
  assert.doesNotMatch(html, /name="colombiatebusca"[^>]*checked/, 'no puede venir marcada por defecto');

  // Above the submit button, which is what "al final del formulario" means to
  // someone filling it: the last decision before sending.
  assert.ok(
    html.indexOf('name="colombiatebusca"') < html.indexOf('<button>Reporta desaparecido</button>'),
    'la casilla va encima del botón de enviar'
  );
});

test('ticking it emails the operators everything needed to file the report there', async (t) => {
  const sg = await fakeSendgrid();
  process.env.AVISO_EMAIL = 'avisos@example.com';
  const { server, base } = await startApp();
  t.after(() => {
    sg.stop();
    delete process.env.AVISO_EMAIL;
    server.close();
  });

  const res = await report(base, { colombiatebusca: '1' });
  assert.equal(res.status, 303, 'el reporte se guarda igual');

  const mail = sg.received
    .map((r) => r.body)
    .find((b) => JSON.stringify(b.personalizations).includes('avisos@example.com'));
  assert.ok(mail, 'los operadores deben recibir la solicitud');
  assert.match(mail.subject, /Colombia Te Busca/);
  assert.match(mail.subject, /Marta Isabel Quintero/);

  const text = mail.content[0].value;
  assert.match(text, /Marta Isabel Quintero/);
  assert.match(text, /Barrio San José, Quibdó/);
  assert.match(text, /hermana@ejemplo\.com/, 'sin el contacto no pueden llenar el formulario');
  assert.match(text, /chaqueta roja/);
  assert.match(text, /\/person\/\d+/);
  assert.match(text, /\/photo\/\d+/, 'la foto es lo que permite reconocerla');
  assert.match(text, /colombiatebusca\.com/);
});

// The default path must stay exactly as it was: nothing about this report
// leaves encontrados.co unless the family asked for it.
test('leaving it unticked sends nothing to the operators', async (t) => {
  const sg = await fakeSendgrid();
  process.env.AVISO_EMAIL = 'avisos@example.com';
  const { server, base } = await startApp();
  t.after(() => {
    sg.stop();
    delete process.env.AVISO_EMAIL;
    server.close();
  });

  const res = await report(base);
  assert.equal(res.status, 303);
  assert.equal(
    sg.received.filter((r) => JSON.stringify(r.body).includes('avisos@example.com')).length,
    0
  );
});

// Without AVISO_EMAIL there is nowhere to relay to — but the report itself is
// the thing that must survive, so it is stored and the visitor never sees an
// error about our own missing configuration.
test('a report still goes through when AVISO_EMAIL is not configured', async (t) => {
  delete process.env.AVISO_EMAIL;
  const { server, base } = await startApp();
  t.after(() => server.close());

  const res = await report(base, { colombiatebusca: '1' });
  assert.equal(res.status, 303);
});

test('every page ends with the two asks, contributors above the ColombiaTeBusca team', async (t) => {
  const { server, base } = await startApp();
  t.after(() => server.close());

  for (const path of ['/', '/report', '/rescate', '/privacidad']) {
    const html = await (await fetch(`${base}${path}`)).text();
    const contribute = html.indexOf('¿Deseas contribuir?');
    const team = html.indexOf('¿Eres parte del equipo de ColombiaTeBusca?');
    assert.ok(contribute > 0, `falta la invitación a contribuir en ${path}`);
    assert.ok(team > contribute, `el mensaje al equipo de ColombiaTeBusca va de último en ${path}`);
    assert.match(html.slice(contribute), /crawling de redes sociales/);
    assert.match(html.slice(team), /integrar nuestra tech/);
    // Both asks lead to the same place.
    assert.equal(html.slice(contribute).match(/https:\/\/x\.com\/ni500/g).length, 2);
  }
});
