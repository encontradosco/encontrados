const test = require('node:test');
const assert = require('node:assert');
const { looksLikeContact, maskReporter, publicUpdate } = require('../src/privacy');

test('looksLikeContact: phone numbers and emails are contact info', () => {
  assert.equal(looksLikeContact('573001234567'), true); // WhatsApp "from" number
  assert.equal(looksLikeContact('300 123 4567'), true); // spaced phone
  assert.equal(looksLikeContact('familia@ejemplo.com'), true);
  assert.equal(looksLikeContact('Hermana'), false);
  assert.equal(looksLikeContact('María Gómez, Cruz Roja'), false);
  assert.equal(looksLikeContact('Casa 12'), false); // < 7 digits
});

test('maskReporter: empty/undefined reporter has nothing to show', () => {
  assert.equal(maskReporter(undefined), null);
  assert.equal(maskReporter(null), null);
  assert.equal(maskReporter(''), null);
  assert.equal(maskReporter('   '), null);
});

test('maskReporter: a raw phone number (WhatsApp) is never returned verbatim', () => {
  const label = maskReporter('573001234567');
  assert.equal(label, 'Reporte ciudadano');
  assert.ok(!label.includes('573001234567'));
});

test('maskReporter: an email is never returned verbatim', () => {
  const label = maskReporter('familia@ejemplo.com');
  assert.equal(label, 'Reporte ciudadano');
  assert.ok(!label.includes('@'));
});

test('maskReporter: a single-word name passes through as-is', () => {
  assert.equal(maskReporter('Hermana'), 'Hermana');
});

test('maskReporter: a multi-word name is reduced to first name + initial', () => {
  assert.equal(maskReporter('María Gómez, Cruz Roja'), 'María G.');
  assert.equal(maskReporter('Juan Carlos Pérez'), 'Juan C.');
});

test('maskReporter: self-report marker is preserved without leaking contact info', () => {
  assert.equal(maskReporter('la propia persona'), 'Reporte propio');
  assert.equal(maskReporter('3001234567 · la propia persona'), 'Reporte ciudadano (reporte propio)');
  assert.equal(maskReporter('Juan · la propia persona'), 'Juan (reporte propio)');
});

test('publicUpdate: strips the raw reporter field by construction', () => {
  const row = {
    id: 1,
    person_id: 2,
    status: 'safe',
    message: 'ok',
    location: 'Cali',
    lat: 3.4,
    lng: -76.5,
    source: 'whatsapp',
    reporter: '573001234567',
    created_at: '2026-08-10T00:00:00Z'
  };
  const pub = publicUpdate(row);
  assert.equal(pub.reporter, undefined);
  assert.equal(pub.reporter_label, 'Reporte ciudadano');
  assert.equal(pub.location, 'Cali');
  assert.equal(pub.status, 'safe');
  assert.equal(JSON.stringify(pub).includes('573001234567'), false);
});

test('publicUpdate: null-safe', () => {
  assert.equal(publicUpdate(null), null);
  assert.equal(publicUpdate(undefined), null);
});
