// Face thumbnails for the public listing.
//
// The full report photo is often a few hundred KB — too much to push at
// somebody refreshing this page on a phone with one bar of signal in a
// disaster zone. So every report photo also gets a small square crop centred
// on the detected face, which is what the listing actually loads (and only
// when the connection can afford it — see PHOTO_SCRIPT in src/html.js).
const sharp = require('sharp');

// Two sizes from the same crop, because the two pages want opposite things:
// the listing shows 30 faces at 80px and must stay light, while the person
// page shows one at 240px and should be sharp on a phone's 2-3x screen.
const THUMB_SIZE = 240;
const FACE_SIZE = 480;
const THUMB_QUALITY = 70;

// How much wider than the detected face box the crop is. Rekognition's box is
// tight — roughly forehead to chin — so it needs real padding to read as a
// portrait rather than a close-up of a nose.
const ZOOM = 1.8;
// The box is centred near the nose; nudging up fits the hair in.
const HEADROOM = 0.06;

// Square crop, in pixels, of the image the thumbnail comes from.
function cropRect(geometry, width, height) {
  const limit = Math.min(width, height);
  let cx;
  let cy;
  let size;

  if (geometry && geometry.box) {
    const { l, t, w, h } = geometry.box;
    cx = (l + w / 2) * width;
    cy = (t + h / 2) * height;
    size = Math.round(Math.min(Math.max(w * width, h * height) * ZOOM, limit));
    cy -= size * HEADROOM;
  } else {
    // No detection: a centred square is the least-bad framing.
    cx = width / 2;
    cy = height / 2;
    size = limit;
  }

  // Keep the square inside the image by sliding it, not by shrinking it.
  const left = Math.max(0, Math.min(Math.round(cx - size / 2), width - size));
  const top = Math.max(0, Math.min(Math.round(cy - size / 2), height - size));
  return { left, top, width: size, height: size };
}

// Returns { bytes, contentType, crop } — crop being the same rect expressed as
// ratios, so the overlay coordinates (also ratios of the original) can be
// remapped onto the thumbnail. Returns null if the bytes aren't a usable image.
async function makeThumbnail(bytes, geometry) {
  if (!bytes || !bytes.length) return null;
  try {
    // Bake in EXIF orientation first, so the crop math and the thumbnail agree
    // on which way is up.
    const upright = await sharp(bytes, { failOn: 'none' })
      .rotate()
      .toBuffer({ resolveWithObject: true });
    const { width, height } = upright.info;
    if (!width || !height) return null;

    const rect = cropRect(geometry, width, height);
    const render = (size) =>
      sharp(upright.data)
        .extract(rect)
        .resize(size, size, { fit: 'cover' })
        .jpeg({ quality: THUMB_QUALITY, progressive: true })
        .toBuffer();
    // Never upscale: a small source photo would only gain bytes, not detail.
    const faceSize = Math.min(FACE_SIZE, Math.max(THUMB_SIZE, rect.width));
    const [small, large] = await Promise.all([render(THUMB_SIZE), render(faceSize)]);

    return {
      bytes: small,
      largeBytes: large,
      contentType: 'image/jpeg',
      crop: {
        l: rect.left / width,
        t: rect.top / height,
        w: rect.width / width,
        h: rect.height / height
      }
    };
  } catch (e) {
    console.error('[thumbs] could not build a thumbnail:', e.message);
    return null;
  }
}

// Build the thumbnail and persist it together with the geometry it was framed
// from. The crop rides along inside face_detail because the overlay is useless
// without it: its coordinates are ratios of the ORIGINAL image.
async function storeThumbnail(store, photoId, bytes, geometry) {
  const thumb = await makeThumbnail(bytes, geometry);
  if (!thumb) return null;
  await store.setPhotoThumbnails(photoId, {
    small: thumb.bytes,
    large: thumb.largeBytes,
    contentType: thumb.contentType
  });
  await store.setPhotoFaceDetail(photoId, { ...(geometry || {}), crop: thumb.crop });
  return thumb;
}

module.exports = { makeThumbnail, storeThumbnail, cropRect, THUMB_SIZE, FACE_SIZE };
