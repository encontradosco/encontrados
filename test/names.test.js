const test = require('node:test');
const assert = require('node:assert');
const { normalize, phoneticKey, matchScore } = require('../src/names');

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
