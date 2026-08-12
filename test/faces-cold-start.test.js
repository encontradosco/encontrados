const test = require('node:test');
const assert = require('node:assert');
const { RekognitionClient } = require('@aws-sdk/client-rekognition');

const facesPath = require.resolve('../src/faces');

// createLazyMatcher() calls createMatcher() internally, which opens a real
// RekognitionClient and awaits CreateCollectionCommand. Stubbing send() lets
// the init path run (and resolve to an ENABLED matcher) without AWS access,
// with a controllable delay to simulate real network latency.
function withStubbedRekognition(delayMs, fn) {
  const realSend = RekognitionClient.prototype.send;
  RekognitionClient.prototype.send = function stubbedSend() {
    return new Promise((resolve) => setTimeout(resolve, delayMs, {}));
  };
  const realKeyId = process.env.AWS_ACCESS_KEY_ID;
  const realSecret = process.env.AWS_SECRET_ACCESS_KEY;
  process.env.AWS_ACCESS_KEY_ID = 'test-key';
  process.env.AWS_SECRET_ACCESS_KEY = 'test-secret';
  delete require.cache[facesPath];
  try {
    return fn(require(facesPath));
  } finally {
    RekognitionClient.prototype.send = realSend;
    if (realKeyId === undefined) delete process.env.AWS_ACCESS_KEY_ID;
    else process.env.AWS_ACCESS_KEY_ID = realKeyId;
    if (realSecret === undefined) delete process.env.AWS_SECRET_ACCESS_KEY;
    else process.env.AWS_SECRET_ACCESS_KEY = realSecret;
    delete require.cache[facesPath];
  }
}

// #89: two requests racing a cold instance both call ensureReady() a moment
// apart. The first kicks off the real init; while it is still in flight, the
// second call's `now - lastTry < RETRY_MS` check is already true (lastTry was
// stamped by the first call before it awaited anything), so it short-circuits
// to nullMatcher instead of joining the in-flight attempt — the very rescuer
// or report that triggered the warmup gets told matching is unavailable, even
// though it comes back seconds later for everyone after.
test('concurrent requests on a cold instance all see the matcher once it finishes waking up', () =>
  withStubbedRekognition(50, async ({ createLazyMatcher }) => {
    const matcher = createLazyMatcher();

    const [first, second] = await Promise.all([matcher.ensureReady(), matcher.ensureReady()]);

    assert.equal(first.enabled, true, 'la petición que despertó al matcher debe verlo activo');
    assert.equal(
      second.enabled,
      true,
      'una petición concurrente no puede quedarse con el matcher dormido mientras la primera ya lo está despertando'
    );
  }));
