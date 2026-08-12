// Owns the answer to "is this report photo ready to show, and what's left to
// do with it?" — a question that used to be answered separately in the
// pending-rows SQL predicate (src/store/{sqlite,postgres}.js, one dialect
// each), the hasBox/hasThumb re-derivation in facematch.js, the render gate in
// html.js's facePlate, and a hand-copied twin of that same gate in web.js's
// duplicateNotice. That last copy is exactly the kind of drift the issue this
// module answers is about: branching on the row alone (instead of the same
// condition facePlate draws on) once printed "compare the photos" over a
// blank card — see test/duplicates.test.js.
//
// The two SQL predicates still decide which rows come back from the database
// at all; moving that into JS would mean loading every report photo just to
// filter it client-side. What lives here is everything downstream of a row
// already in hand: whether it renders, and — for the backfill loop — what
// work is still owed to it.

// The public face plate needs a thumbnail; the detection geometry is a bonus
// (it draws the overlay) and its absence never blocks the plate itself.
function isReadyToShow(photo) {
  return !!(photo && photo.thumb_type);
}

function hasThumbnail(photo) {
  return !!(photo && photo.thumb && photo.thumb.length);
}

function hasGeometry(photo) {
  return !!(photo && photo.face_detail && photo.face_detail.box);
}

// Set once Rekognition has looked at a photo and found no usable face, so the
// backfill loop stops retrying it forever.
function isMarkedNoFace(photo) {
  return !!(photo && photo.face_detail && photo.face_detail.no_face);
}

// What backfillPhotoDerivatives should do with one photo that photosMissingDerivatives
// already decided is pending. 'skip' means: already thumbnailed, only
// Rekognition could add the missing geometry, and it is not reachable right
// now — leave it for a later run instead of redoing an identical centred crop.
// Anything else means there is real work to attempt this pass.
function derivativeAction(photo, matcherEnabled) {
  if (hasThumbnail(photo) && !hasGeometry(photo) && !matcherEnabled) return 'skip';
  return 'detect';
}

// The overlay's coordinates are ratios of the ORIGINAL photo; the thumbnail is
// a crop of it, so they must be remapped into the crop's own coordinate space
// before they land anywhere near the right pixel.
function toCropSpace(detail) {
  const c = detail.crop;
  if (!c || !c.w || !c.h) return detail;
  const mapX = (x) => (x - c.l) / c.w;
  const mapY = (y) => (y - c.t) / c.h;
  return {
    ...detail,
    box: detail.box
      ? { l: mapX(detail.box.l), t: mapY(detail.box.t), w: detail.box.w / c.w, h: detail.box.h / c.h }
      : null,
    // A landmark can fall outside the crop on an off-centre face; pinning it
    // to the edge would be a lie, so drop it.
    points: (detail.points || [])
      .map((p) => ({ ...p, x: mapX(p.x), y: mapY(p.y) }))
      .filter((p) => p.x >= 0 && p.x <= 1 && p.y >= 0 && p.y <= 1)
  };
}

module.exports = {
  isReadyToShow,
  hasThumbnail,
  hasGeometry,
  isMarkedNoFace,
  derivativeAction,
  toCropSpace
};
