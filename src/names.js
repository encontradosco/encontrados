// Fuzzy person-name matching: normalization + token subset + phonetic keys + edit distance.
// Designed for Spanish and English names under emergency conditions (typos, missing
// middle names, surname order swaps, phonetic spellings).

function normalize(name) {
  return String(name || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '') // strip accents: José -> Jose, Ñ -> N
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

const STOP_TOKENS = new Set(['de', 'del', 'la', 'las', 'los', 'y', 'da', 'do', 'dos', 'van', 'von', 'el']);

function tokenize(name) {
  return normalize(name)
    .split(' ')
    .filter((t) => t && !STOP_TOKENS.has(t));
}

// Phonetic key tuned for Spanish/English confusions. One key per token.
function phoneticToken(token) {
  let t = token;
  t = t.replace(/^h/, ''); // silent h
  t = t
    .replace(/ph/g, 'f')
    .replace(/ll/g, 'y')
    .replace(/qu/g, 'k')
    .replace(/ch/g, 'x')
    .replace(/sh/g, 'x')
    .replace(/ge/g, 'je')
    .replace(/gi/g, 'ji')
    .replace(/gue/g, 'ge')
    .replace(/gui/g, 'gi')
    .replace(/ce/g, 'se')
    .replace(/ci/g, 'si')
    .replace(/v/g, 'b')
    .replace(/z/g, 's')
    .replace(/w/g, 'u')
    .replace(/k/g, 'c')
    .replace(/q/g, 'c')
    .replace(/x/g, 's')
    .replace(/h/g, '');
  t = t.replace(/(.)\1+/g, '$1'); // collapse doubles
  t = t.replace(/[aeiou]/g, (v, i) => (i === 0 ? v : '')); // keep leading vowel only
  return t;
}

function phoneticKey(name) {
  return tokenize(name).map(phoneticToken).join(' ');
}

// Names arrive from panicked people typing on phones: "MARIA JOSE GOMEZ",
// "lilianny maybeth mora hurtado". Store them the way a name is written, so the
// public listing is readable. Only the display form changes — normalize() and
// phoneticKey() strip case anyway, so matching is untouched.
//
// Spanish connectors stay lowercase ("María de los Ángeles"), except as the
// first word. Hyphens and apostrophes start a new word ("Jean-Pierre",
// "O'Brien"). A token with no letters (a hex suffix, a number) is left alone.
const LOWERCASE_PARTICLES = new Set([
  'de', 'del', 'la', 'las', 'lo', 'los', 'y', 'e', 'da', 'das', 'do', 'dos',
  'di', 'du', 'van', 'von', 'der', 'den', 'bin', 'al', 'el'
]);

// A capital letter in the middle of a word is almost always deliberate
// ("McDonald", "DiCaprio"). Only rewrite what carries no such signal: all
// caps ("EMMANUEL"), all lowercase ("hurtado"), or already title case.
function looksDeliberate(part) {
  if (part.length < 2) return false;
  const rest = part.slice(1);
  if (rest === rest.toLocaleLowerCase('es')) return false; // no inner capital
  return part !== part.toLocaleUpperCase('es'); // ALL CAPS is not a choice
}

function capitalizeWord(word) {
  if (!word) return word;
  // Split on hyphens/apostrophes, keeping the separators.
  return word
    .split(/([-'’])/)
    .map((part, i) => {
      if (i % 2 === 1) return part; // the separator itself
      if (!part || looksDeliberate(part)) return part;
      return part[0].toLocaleUpperCase('es') + part.slice(1).toLocaleLowerCase('es');
    })
    .join('');
}

function titleCaseName(name) {
  const words = String(name || '').trim().split(/\s+/).filter(Boolean);
  return words
    .map((word, i) => {
      const lower = word.toLocaleLowerCase('es');
      if (i > 0 && LOWERCASE_PARTICLES.has(lower)) return lower;
      return capitalizeWord(word);
    })
    .join(' ');
}

function levenshtein(a, b) {
  if (a === b) return 0;
  const m = a.length;
  const n = b.length;
  if (!m) return n;
  if (!n) return m;
  let prev = Array.from({ length: n + 1 }, (_, j) => j);
  for (let i = 1; i <= m; i++) {
    const cur = [i];
    for (let j = 1; j <= n; j++) {
      cur[j] = Math.min(
        prev[j] + 1,
        cur[j - 1] + 1,
        prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1)
      );
    }
    prev = cur;
  }
  return prev[n];
}

// How well do two single tokens match? 1 = exact, 0 = unrelated.
function tokenScore(qt, ct) {
  if (qt === ct) return 1;
  if (phoneticToken(qt) === phoneticToken(ct)) return 0.9;
  if (ct.startsWith(qt) || qt.startsWith(ct)) return 0.8; // initials / truncation
  const dist = levenshtein(qt, ct);
  const maxLen = Math.max(qt.length, ct.length);
  if (maxLen >= 4 && dist <= 2) return 0.85 - 0.15 * dist;
  if (maxLen === 3 && dist === 1) return 0.6;
  return 0;
}

// Score a query name against a candidate name, 0..1.
// Every query token must find a home in the candidate (order-independent),
// so "Juan Perez" matches "Juan Carlos Perez Gomez" but not "Juan Rodriguez".
function matchScore(query, candidate) {
  const qTokens = tokenize(query);
  const cTokens = tokenize(candidate);
  if (!qTokens.length || !cTokens.length) return 0;

  const used = new Set();
  let total = 0;
  for (const qt of qTokens) {
    let best = 0;
    let bestIdx = -1;
    cTokens.forEach((ct, i) => {
      if (used.has(i)) return;
      const s = tokenScore(qt, ct);
      if (s > best) {
        best = s;
        bestIdx = i;
      }
    });
    if (best < 0.5) return 0; // an unmatched query token kills the match
    used.add(bestIdx);
    total += best;
  }
  const coverage = qTokens.length / cTokens.length; // prefer fuller matches
  return (total / qTokens.length) * (0.7 + 0.3 * Math.min(1, coverage));
}

module.exports = { normalize, tokenize, phoneticKey, titleCaseName, matchScore, levenshtein };
