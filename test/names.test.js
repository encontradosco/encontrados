const test = require('node:test');
const assert = require('node:assert');
const { normalize, phoneticKey, titleCaseName, matchScore } = require('../src/names');

test('normalize strips accents, case, and punctuation', () => {
  assert.equal(normalize('José Ñáñez-Pérez'), 'jose nanez perez');
  assert.equal(normalize('  MARÍA   del  Carmen '), 'maria del carmen');
});

test('phonetic key collapses Spanish spelling confusions', () => {
  assert.equal(phoneticKey('Vasques'), phoneticKey('Bazquez'));
  assert.equal(phoneticKey('Yiseth'), phoneticKey('Lliseth'));
  assert.equal(phoneticKey('Hernandez'), phoneticKey('Ernandes'));
});

test('missing middle names still match', () => {
  assert.ok(matchScore('juan perez', 'juan carlos perez gomez') >= 0.55);
});

test('surname order swap still matches', () => {
  assert.ok(matchScore('perez juan', 'juan perez') >= 0.55);
});

test('typos within edit distance match', () => {
  assert.ok(matchScore('jaun peres', 'juan perez') >= 0.55);
});

test('accented vs unaccented match strongly', () => {
  assert.ok(matchScore(normalize('José Pérez'), normalize('Jose Perez')) >= 0.85);
});

test('different people do not match', () => {
  assert.equal(matchScore('juan rodriguez', 'juan perez'), 0);
  assert.equal(matchScore('maria lopez', 'pedro gomez'), 0);
});

test('titleCaseName fixes how a name was typed', () => {
  assert.equal(titleCaseName('Lilianny maybeth Mora hurtado'), 'Lilianny Maybeth Mora Hurtado');
  assert.equal(titleCaseName('EMMANUEL PAUL PRIETO TRAVIESO'), 'Emmanuel Paul Prieto Travieso');
  // Accents survive both directions of case folding.
  assert.equal(titleCaseName('JOSÉ  MARÍA   ÑUÑEZ'), 'José María Ñuñez');
  // Spanish connectors stay lowercase, but never as the first word.
  assert.equal(titleCaseName('maría de los ángeles gómez'), 'María de los Ángeles Gómez');
  assert.equal(titleCaseName('DE LA CRUZ'), 'De la Cruz');
  // Hyphens and apostrophes start a new word.
  assert.equal(titleCaseName("jean-pierre o'brien"), "Jean-Pierre O'Brien");
  assert.equal(titleCaseName('  juan   PÉREZ  '), 'Juan Pérez');
  assert.equal(titleCaseName(''), '');
});

test('re-casing a name never changes how it matches', () => {
  const typed = 'EMMANUEL PAUL PRIETO TRAVIESO';
  assert.equal(normalize(titleCaseName(typed)), normalize(typed));
  assert.equal(phoneticKey(titleCaseName(typed)), phoneticKey(typed));
});
