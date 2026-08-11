const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
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

// The failure above is silent by design — the family must never be shown an
// error about our own configuration — so it needs a way to be seen from
// outside. Presence only: the mailbox itself stays out of a public endpoint.
test('/api/diag reports whether the relay mailbox is configured', async (t) => {
  const { server, base } = await startApp();
  t.after(() => {
    delete process.env.AVISO_EMAIL;
    server.close();
  });

  delete process.env.AVISO_EMAIL;
  const off = await (await fetch(`${base}/api/diag`)).json();
  assert.equal(off.email.aviso_email_present, false);

  process.env.AVISO_EMAIL = 'avisos@example.com';
  const on = await (await fetch(`${base}/api/diag`)).json();
  assert.equal(on.email.aviso_email_present, true);
  assert.doesNotMatch(JSON.stringify(on), /avisos@example\.com/, 'la dirección no se publica');
});

// --------------------------------------------------------------------------
// The fields their form needs and ours did not ask for. Every one of them is
// optional, and the whole point of the group is that it cannot make a report
// harder to send: someone reporting a missing relative after an earthquake,
// on a phone with one bar, must never be stopped by a box they left empty.

test('the relay fields are optional and stay out of the way until the box is ticked', async (t) => {
  const { server, base } = await startApp();
  t.after(() => server.close());

  const html = await (await fetch(`${base}/report`)).text();
  const fields = ['reporter_name', 'department', 'municipality', 'place'];
  for (const field of fields) {
    const tag = html.match(new RegExp(`<input[^>]*name="${field}"[^>]*>`));
    assert.ok(tag, `falta la casilla ${field}`);
    assert.doesNotMatch(tag[0], /required/, `${field} no puede ser obligatoria`);
  }

  // They live inside the group that the checkbox reveals, and that group is
  // hidden by CSS alone — no JavaScript stands between a family and a report.
  assert.match(html, /<div class="ctb-fields">/);
  const css = fs.readFileSync(path.join(__dirname, '..', 'public', 'styles.css'), 'utf8');
  assert.match(css, /\.ctb-fields\s*\{\s*display:\s*none;\s*\}/);
  assert.match(css, /\.share-check:has\(input:checked\)\s*~\s*\.ctb-fields/);
});

// The regression that matters most: everything above is additive. A report
// filed exactly the way it was filed yesterday has to land exactly the same.
test('a report with none of the new fields behaves just like before', async (t) => {
  const sg = await fakeSendgrid();
  process.env.AVISO_EMAIL = 'avisos@example.com';
  const { server, base } = await startApp();
  t.after(() => {
    sg.stop();
    delete process.env.AVISO_EMAIL;
    server.close();
  });

  const res = await report(base, { colombiatebusca: '1' });
  assert.equal(res.status, 303);
  const personUrl = res.headers.get('location');
  assert.match(personUrl, /^\/person\/\d+\?reported=1$/);
  assert.equal((await fetch(`${base}${personUrl}`)).status, 200);

  const text = sg.received
    .map((r) => r.body)
    .find((b) => JSON.stringify(b.personalizations).includes('avisos@example.com'))
    .content[0].value;

  // The single free-text contact still travels as it always did...
  assert.match(text, /Contacto de quien reporta: hermana@ejemplo\.com/);
  // ...and every box of their form is listed as empty. Nothing is guessed:
  // an invented datum in a missing-persons registry is worse than a blank.
  for (const label of [
    'Nombre de quien reporta (reporter_name)',
    'Teléfono de quien reporta (reporter_phone)',
    'Correo de quien reporta (reporter_email)',
    'Departamento',
    'Municipio',
    'Lugar'
  ]) {
    assert.match(text, new RegExp(`${label.replace(/[()]/g, '\\$&')}: \\(sin dato`));
  }
});

test('the new fields reach the relay email under the labels their form uses', async (t) => {
  const sg = await fakeSendgrid();
  process.env.AVISO_EMAIL = 'avisos@example.com';
  const { server, base } = await startApp();
  t.after(() => {
    sg.stop();
    delete process.env.AVISO_EMAIL;
    server.close();
  });

  const res = await report(base, {
    colombiatebusca: '1',
    contact: '',
    contact_phone: '300 111 2233',
    contact_email: 'tia@ejemplo.com',
    reporter_name: 'Ana Carolina Restrepo',
    department: 'Risaralda',
    municipality: 'Pereira',
    place: 'Barrio Cuba, cerca del parque'
  });
  assert.equal(res.status, 303);

  const text = sg.received
    .map((r) => r.body)
    .find((b) => JSON.stringify(b.personalizations).includes('avisos@example.com'))
    .content[0].value;

  assert.match(text, /Nombre de quien reporta \(reporter_name\): Ana Carolina Restrepo/);
  assert.match(text, /Teléfono de quien reporta \(reporter_phone\): 300 111 2233/);
  assert.match(text, /Correo de quien reporta \(reporter_email\): tia@ejemplo\.com/);
  assert.match(text, /Departamento: Risaralda/);
  assert.match(text, /Municipio: Pereira/);
  assert.match(text, /Lugar: Barrio Cuba, cerca del parque/);

  // Phone and email are two boxes on the form and ONE `contact` downstream —
  // the string a rescuer is shown after a facial match, which nothing parses.
  assert.match(text, /Contacto de quien reporta: 300 111 2233 · tia@ejemplo\.com/);

  // The reporter's name is the one new datum that gets stored, in the column
  // that already existed for it — so it comes back out reduced, never whole.
  const html = await (await fetch(`${base}${res.headers.get('location')}`)).text();
  assert.match(html, /Reportado por: Ana C\./);
  assert.doesNotMatch(html, /Restrepo/, 'el apellido de quien reporta no es público');
  assert.doesNotMatch(html, /tia@ejemplo\.com/, 'el contacto nunca sale en una página pública');
  assert.doesNotMatch(html, /300 111 2233/);
});

// One obligation, two boxes: exactly the rule the single field enforced.
test('either contact box on its own is enough, and neither is still an error', async (t) => {
  const { server, base } = await startApp();
  t.after(() => server.close());

  const onlyPhone = await report(base, { contact: '', contact_phone: '310 444 5566' });
  assert.equal(onlyPhone.status, 303, 'con teléfono basta');

  const onlyEmail = await report(base, { contact: '', contact_email: 'primo@ejemplo.com' });
  assert.equal(onlyEmail.status, 303, 'con correo basta');

  const neither = await report(base, { contact: '' });
  assert.equal(neither.status, 400, 'sin ninguna forma de contactar no hay a quién avisar');
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
