// Face matching provider. Production: AWS Rekognition (a collection of indexed
// faces; each new photo is searched against it). Without AWS credentials the
// null matcher is used: photos are stored but no matching happens.
//
// PRIVACY: photos are only ever sent to the face-matching provider for
// comparison. They are never shown to any user — the app has no route that
// serves photo bytes.

const COLLECTION_ID = process.env.FACE_COLLECTION_ID || 'aqui-faces';
const THRESHOLD = parseFloat(process.env.FACE_MATCH_THRESHOLD || '90');

const nullMatcher = {
  enabled: false,
  status: 'deshabilitado (sin credenciales de AWS o error de inicialización)',
  async indexFace() {
    return null;
  },
  async searchByImage() {
    return [];
  }
};

async function createMatcher() {
  if (!process.env.AWS_ACCESS_KEY_ID || !process.env.AWS_SECRET_ACCESS_KEY) {
    console.warn('[faces] AWS credentials not set — face matching disabled (photos still stored).');
    return nullMatcher;
  }
  const {
    RekognitionClient,
    CreateCollectionCommand,
    IndexFacesCommand,
    SearchFacesByImageCommand
  } = require('@aws-sdk/client-rekognition');

  const client = new RekognitionClient({ region: process.env.AWS_REGION || 'us-east-1' });
  try {
    await client.send(new CreateCollectionCommand({ CollectionId: COLLECTION_ID }));
  } catch (e) {
    if (e.name !== 'ResourceAlreadyExistsException') {
      // Bad/expired credentials must NEVER take the app down — an emergency
      // service degrades to "photos stored, matching off", not to a crash.
      console.error('[faces] Rekognition unavailable — face matching disabled:', e.message);
      return nullMatcher;
    }
  }

  console.log(`[faces] Rekognition ready (collection ${COLLECTION_ID}, region ${process.env.AWS_REGION || 'us-east-1'})`);
  return {
    enabled: true,
    status: `activo (colección ${COLLECTION_ID})`,
    // Returns the provider face id, or null when no face is detected.
    async indexFace(bytes, externalId) {
      const res = await client.send(
        new IndexFacesCommand({
          CollectionId: COLLECTION_ID,
          Image: { Bytes: bytes },
          ExternalImageId: String(externalId),
          MaxFaces: 1,
          QualityFilter: 'AUTO'
        })
      );
      const faceId = res.FaceRecords?.[0]?.Face?.FaceId || null;
      if (!faceId) {
        console.warn(
          `[faces] no face detected in photo ${externalId} (unindexed:`,
          JSON.stringify(res.UnindexedFaces || []),
          ')'
        );
      } else {
        console.log(`[faces] indexed photo ${externalId} as ${faceId}`);
      }
      return faceId;
    },
    // Returns [{ faceId, similarity }] above the threshold.
    async searchByImage(bytes) {
      try {
        const res = await client.send(
          new SearchFacesByImageCommand({
            CollectionId: COLLECTION_ID,
            Image: { Bytes: bytes },
            FaceMatchThreshold: THRESHOLD,
            MaxFaces: 10
          })
        );
        const matches = (res.FaceMatches || []).map((m) => ({
          faceId: m.Face.FaceId,
          similarity: m.Similarity
        }));
        console.log(`[faces] search returned ${matches.length} match(es)`);
        return matches;
      } catch (e) {
        // "no face in the image" is a normal outcome, not an error
        if (e.name === 'InvalidParameterException') {
          console.warn('[faces] search: no face detected in the uploaded photo');
          return [];
        }
        console.error('[faces] search failed:', e.name, e.message);
        throw e;
      }
    }
  };
}

// Serverless instances are long-lived: if Rekognition failed to initialize at
// boot (transient error, credentials added moments later), a permanently
// disabled matcher would silently break matching for that whole instance.
// This wrapper retries initialization on demand, at most once a minute.
function createLazyMatcher() {
  let real = null;
  let lastTry = 0;
  const RETRY_MS = 60000;

  async function get(now) {
    if (real && real.enabled) return real;
    if (now - lastTry < RETRY_MS) return real || nullMatcher;
    lastTry = now;
    try {
      real = await createMatcher();
    } catch (e) {
      console.error('[faces] init failed:', e.message);
      real = nullMatcher;
    }
    return real;
  }

  return {
    get enabled() {
      return !!(real && real.enabled);
    },
    get status() {
      return (real && real.status) || 'sin inicializar';
    },
    async indexFace(bytes, externalId) {
      return (await get(Date.now())).indexFace(bytes, externalId);
    },
    async searchByImage(bytes) {
      return (await get(Date.now())).searchByImage(bytes);
    },
    async ensureReady() {
      return get(Date.now());
    }
  };
}

module.exports = { createMatcher, createLazyMatcher, nullMatcher };
