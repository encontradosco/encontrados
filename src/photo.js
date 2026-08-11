// Turns whatever the phone actually produced into something the face matcher
// can read.
//
// Rekognition accepts JPEG and PNG only, and nothing over 5 MB of raw bytes. A
// phone in a disaster zone reliably produces neither: iPhones shoot HEIC by
// default and a current camera JPEG clears 5 MB without trying. The browser
// normally converts both before uploading (RESIZE_SCRIPT in src/html.js), but
// that is best effort and gives up silently whenever `createImageBitmap`
// cannot decode the file — which is exactly what a HEIC does in Chrome and in
// Firefox. When it gives up, the original bytes arrive here untouched.
//
// Before this existed those bytes went straight to Rekognition, which threw
// InvalidImageFormatException. On /rescate that escaped the handler and the
// rescuer got a bare "Error interno del servidor". On /report it was swallowed
// by the catch around matching, which left the worst outcome of the two: a
// report saved and public, whose photo was stored but never indexed and never
// thumbnailed. The family saw a filed report while no rescuer could ever match
// that face — the photo is the one thing that report existed to carry.
//
// So the conversion happens on the server too, and it happens BEFORE the photo
// is stored: what lands in the database is what the browser will later be
// asked to render and what the matcher will be asked to read, and a HEIC
// satisfies neither.
const sharp = require('sharp');

// Rekognition's limit, not ours.
const MAX_BYTES = 5 * 1024 * 1024;
// Face matching gains nothing beyond this, and it bounds what one report can
// put into the database.
const MAX_EDGE = 2048;
const QUALITY = 90;

// Read the format from the bytes, never from the declared content type: the
// declared type is precisely the thing that is unreliable here (see the
// fileFilter note in src/routes/web.js).
function sniffFormat(bytes) {
  if (bytes.length > 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'jpeg';
  if (
    bytes.length > 8 &&
    bytes[0] === 0x89 &&
    bytes[1] === 0x50 &&
    bytes[2] === 0x4e &&
    bytes[3] === 0x47
  ) {
    return 'png';
  }
  return null;
}

// Returns { bytes, contentType, converted } — or null when the bytes cannot be
// decoded as an image at all, which is the caller's cue to tell the person so
// instead of pretending the upload worked.
async function toMatchable(bytes, declaredType) {
  if (!bytes || !bytes.length) return null;

  // Fast path: already what Rekognition wants, upright, and small enough that
  // re-encoding would cost quality and CPU for nothing. This is the common
  // case — the browser script already produced a 1024px JPEG.
  const format = sniffFormat(bytes);
  if (format && bytes.length <= MAX_BYTES) {
    try {
      const meta = await sharp(bytes).metadata();
      const upright = !meta.orientation || meta.orientation === 1;
      if (upright && Math.max(meta.width || 0, meta.height || 0) <= MAX_EDGE) {
        return { bytes, contentType: `image/${format}`, converted: false };
      }
    } catch {
      // A JPEG/PNG header on something sharp cannot parse. Fall through and
      // let the full decode below reach a verdict.
    }
  }

  try {
    const out = await sharp(bytes, { failOn: 'none' })
      // Bake in EXIF orientation. A photo the phone tagged as rotated reaches
      // Rekognition sideways, and a sideways face is one it often does not
      // find at all — which reads to the user as "the upload did nothing".
      .rotate()
      .resize(MAX_EDGE, MAX_EDGE, { fit: 'inside', withoutEnlargement: true })
      .jpeg({ quality: QUALITY })
      .toBuffer();
    return { bytes: out, contentType: 'image/jpeg', converted: true };
  } catch (e) {
    console.warn(`[photo] imagen ilegible (${declaredType || 'sin tipo'}): ${e.message}`);
    return null;
  }
}

module.exports = { toMatchable, sniffFormat, MAX_EDGE, MAX_BYTES };
