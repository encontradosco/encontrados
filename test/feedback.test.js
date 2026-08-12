const test = require('node:test');
const assert = require('node:assert');
const { createSqliteAdapter } = require('../src/store/sqlite');
const { createApp } = require('../src/server');
const { nullMatcher } = require('../src/faces');
const { fakeSendgrid, fakeGithub } = require('./helpers');

// A developer with GITHUB_TOKEN exported in their shell must not have this
// file open real issues on the real repo. Drop it before anything runs; every
// test that needs a configured client goes through fakeGithub, which points
// the client at a local server.
delete process.env.GITHUB_TOKEN;
delete process.env.GITHUB_API_BASE;

async function startApp() {
  const app = await createApp(await createSqliteAdapter(':memory:'), nullMatcher);
  const server = await new Promise((resolve) => {
    const s = app.listen(0, () => resolve(s));
  });
  return { server, base: `http://127.0.0.1:${server.address().port}` };
}

const send = (base, kind, fields) =>
  fetch(`${base}/${kind}`, { method: 'POST', body: new URLSearchParams(fields) });

test('both links live in the footer of every page, to the left of Github', async (t) => {
  const { server, base } = await startApp();
  t.after(() => server.close());

  for (const path of ['/', '/report', '/rescate', '/terminos']) {
    const html = await (await fetch(`${base}${path}`)).text();
    const ideas = html.indexOf('href="/ideas"');
    const bug = html.indexOf('href="/bug"');
    const github = html.indexOf('https://github.com/encontradosco/encontrados"');
    assert.ok(ideas > 0 && bug > 0, `faltan los enlaces en ${path}`);
    assert.ok(ideas < bug && bug < github, `van a la izquierda de Github en ${path}`);
    assert.match(html.slice(ideas, github), /💡 Ideas/);
    assert.match(html.slice(ideas, github), /🐛 Reporta bug/);
  }
});

test('an idea and a bug each become a labelled GitHub issue', async (t) => {
  const gh = await fakeGithub();
  const { server, base } = await startApp();
  t.after(() => {
    gh.stop();
    server.close();
  });

  const idea = await send(base, 'ideas', {
    summary: 'Un mapa con los albergues',
    details: 'Para saber a dónde llevar a alguien.'
  });
  assert.equal(idea.status, 200);
  const ideaHtml = await idea.text();
  assert.match(ideaHtml, /quedó registrada/i);
  assert.match(ideaHtml, /issues\/1/, 'debe enlazar el issue creado');

  const bug = await send(base, 'bug', { summary: 'La foto no carga en 3G' });
  assert.equal(bug.status, 200);
  assert.match(await bug.text(), /issues\/2/);

  assert.equal(gh.received.length, 2);
  assert.equal(gh.received[0].url, '/repos/encontradosco/encontrados/issues');
  assert.equal(gh.received[0].auth, 'Bearer ghp_test');
  assert.deepEqual(gh.received[0].body.labels, ['idea']);
  assert.equal(gh.received[0].body.title, 'Un mapa con los albergues');
  assert.match(gh.received[0].body.body, /a dónde llevar a alguien/);
  assert.deepEqual(gh.received[1].body.labels, ['bug']);
  assert.equal(gh.received[1].body.title, 'La foto no carga en 3G');
});

// A label the repo doesn't have comes back 422. The label is a nicety; the
// report is not.
test('a rejected label does not cost us the report', async (t) => {
  const gh = await fakeGithub();
  const { server, base } = await startApp();
  t.after(() => {
    gh.stop();
    server.close();
  });

  gh.failNext(422);
  const res = await send(base, 'ideas', { summary: 'Traducir el sitio a wayuunaiki' });
  assert.equal(res.status, 200);
  assert.equal(gh.received.length, 2, 'reintenta una vez, sin etiquetas');
  assert.deepEqual(gh.received[0].body.labels, ['idea']);
  assert.equal(gh.received[1].body.labels, undefined, 'el reintento va sin etiquetas');
  assert.match(await res.text(), /issues\/2/);
});

// Nothing anyone takes the trouble to write should evaporate because a token
// is missing or GitHub is having a bad day.
test('with GitHub unreachable the report is emailed to the operators instead', async (t) => {
  const sg = await fakeSendgrid();
  process.env.AVISO_EMAIL = 'avisos@example.com';
  delete process.env.GITHUB_TOKEN;
  const { server, base } = await startApp();
  t.after(() => {
    sg.stop();
    delete process.env.AVISO_EMAIL;
    server.close();
  });

  const res = await send(base, 'bug', {
    summary: 'El botón de rescate no hace nada',
    details: 'Android, Chrome'
  });
  assert.equal(res.status, 200);
  const html = await res.text();
  assert.match(html, /Gracias/, 'quien lo envió no carga con nuestro problema de configuración');
  assert.doesNotMatch(html, /issues\/\d/, 'no puede prometer un issue que no existe');

  const mail = sg.received.map((r) => r.body).find((b) => JSON.stringify(b).includes('avisos@'));
  assert.ok(mail, 'los operadores deben recibirlo para abrirlo a mano');
  assert.match(mail.subject, /El botón de rescate no hace nada/);
  assert.match(mail.content[0].value, /Android, Chrome/);
});

test('an empty summary is rejected without losing what was already typed', async (t) => {
  const gh = await fakeGithub();
  const { server, base } = await startApp();
  t.after(() => {
    gh.stop();
    server.close();
  });

  const res = await send(base, 'ideas', { summary: '   ', details: 'Un texto largo y valioso' });
  assert.equal(res.status, 400);
  const html = await res.text();
  assert.match(html, /Escribe al menos una línea/);
  assert.match(html, /Un texto largo y valioso/, 'el texto ya escrito se devuelve en el formulario');
  assert.equal(gh.received.length, 0);
});

// Caught bots get the success page: telling one it was caught only teaches it
// to try again without the field.
test('the honeypot swallows the submission without opening an issue', async (t) => {
  const gh = await fakeGithub();
  const { server, base } = await startApp();
  t.after(() => {
    gh.stop();
    server.close();
  });

  const res = await send(base, 'ideas', { summary: 'compra seguidores', website: 'http://spam' });
  assert.equal(res.status, 200);
  assert.match(await res.text(), /Gracias/);
  assert.equal(gh.received.length, 0);
});

test('one instance cannot flood the issue tracker', async (t) => {
  const gh = await fakeGithub();
  const { server, base } = await startApp();
  t.after(() => {
    gh.stop();
    server.close();
  });

  for (let i = 0; i < 10; i++) {
    assert.equal((await send(base, 'ideas', { summary: `idea ${i}` })).status, 200);
  }
  const blocked = await send(base, 'ideas', { summary: 'idea 11' });
  assert.equal(blocked.status, 429);
  assert.match(await blocked.text(), /muchos mensajes/);
  assert.equal(gh.received.length, 10, 'el número 11 nunca llega a GitHub');
});

// A GitHub issue is public, permanent and indexed. On a site whose front door
// says "reporta desaparecido", somebody will land here and start typing a
// name and a phone number.
test('both forms warn that this is public and point families to /report', async (t) => {
  const { server, base } = await startApp();
  t.after(() => server.close());

  for (const kind of ['ideas', 'bug']) {
    const html = await (await fetch(`${base}/${kind}`)).text();
    assert.match(html, /Lo que escribas aquí es público/);
    assert.match(html, /href="\/report"/);
    assert.match(html, /name="website"/, 'el honeypot va en el formulario');
  }
});
