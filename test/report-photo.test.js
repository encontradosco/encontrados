const test = require('node:test');
const assert = require('node:assert');
const {
  isReadyToShow,
  hasThumbnail,
  hasGeometry,
  isMarkedNoFace,
  derivativeAction,
  toCropSpace
} = require('../src/report-photo');

// #91: this was previously answered separately by facePlate's own gate and a
// hand-copied twin in web.js's duplicateNotice (`showsFace`). The copy is what
// drifted — see test/duplicates.test.js's "a candidate whose photo cannot be
// rendered is not asked to be compared" for the end-to-end regression.
test('isReadyToShow: only a thumbnail makes a report photo renderable', () => {
  assert.equal(isReadyToShow(null), false);
  assert.equal(isReadyToShow({}), false);
  assert.equal(isReadyToShow({ thumb_type: null }), false);
  assert.equal(isReadyToShow({ thumb_type: 'image/jpeg' }), true, 'geometry is a bonus, not a requirement');
});

test('hasThumbnail / hasGeometry / isMarkedNoFace read the row, not derived state', () => {
  assert.equal(hasThumbnail({ thumb: Buffer.from('x') }), true);
  assert.equal(hasThumbnail({ thumb: Buffer.alloc(0) }), false);
  assert.equal(hasThumbnail({}), false);

  assert.equal(hasGeometry({ face_detail: { box: { l: 0 } } }), true);
  assert.equal(hasGeometry({ face_detail: { crop: { l: 0 } } }), false, 'a crop alone is not detection geometry');
  assert.equal(hasGeometry({ face_detail: null }), false);

  assert.equal(isMarkedNoFace({ face_detail: { no_face: true } }), true);
  assert.equal(isMarkedNoFace({ face_detail: { box: {} } }), false);
});

test('derivativeAction: waits on Rekognition only when nothing else is missing', () => {
  const thumbedNoBox = { thumb: Buffer.from('x'), face_detail: null };
  const thumbedWithBox = { thumb: Buffer.from('x'), face_detail: { box: {} } };
  const unthumbed = { thumb: null, face_detail: null };

  assert.equal(
    derivativeAction(thumbedNoBox, false),
    'skip',
    'already has a thumbnail; only the matcher could add geometry, and it is down'
  );
  assert.equal(derivativeAction(thumbedNoBox, true), 'detect', 'matcher is up — worth trying DetectFaces');
  assert.equal(derivativeAction(thumbedWithBox, false), 'detect', 'still needs a thumbnail regardless of the matcher');
  assert.equal(derivativeAction(unthumbed, false), 'detect', 'still needs a thumbnail regardless of the matcher');
});

test('toCropSpace remaps geometry into the thumbnail crop, dropping landmarks that fall outside it', () => {
  const detail = {
    box: { l: 0.4, t: 0.2, w: 0.2, h: 0.3 },
    points: [
      { t: 'nose', x: 0.5, y: 0.35 }, // inside the crop
      { t: 'eyeLeft', x: 0.05, y: 0.05 } // outside the crop
    ],
    crop: { l: 0.25, t: 0.1, w: 0.5, h: 0.6 }
  };

  const mapped = toCropSpace(detail);

  assert.equal(mapped.points.length, 1, 'the landmark outside the crop is dropped');
  assert.equal(mapped.points[0].t, 'nose');
  assert.ok(Math.abs(mapped.box.l - 0.3) < 1e-9);
  assert.ok(Math.abs(mapped.box.t - 0.1666666667) < 1e-6);
});

test('toCropSpace is a no-op without a crop (nothing to remap yet)', () => {
  const detail = { box: { l: 0.1, t: 0.1, w: 0.2, h: 0.2 }, points: [] };
  assert.deepEqual(toCropSpace(detail), detail);
});
