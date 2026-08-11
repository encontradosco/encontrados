// Face matching provider. Production: AWS Rekognition (a collection of indexed
// faces; each new photo is searched against it). Without AWS credentials the
// null matcher is used: photos are stored but no matching happens.
//
// PRIVACY: a RESCUER's photo is only ever sent to the face-matching provider
// for comparison and is dropped immediately — it is never stored or shown.
// A REPORT photo is stored and is shown publicly alongside the detection
// geometry (see GET /photo/:id and src/html.js facePlate).

// Keeps the pre-rename name ON PURPOSE. This is not branding: it identifies the
// Rekognition collection holding every face indexed so far. Changing the
// default would point production at a new, empty collection and silently break
// matching for everyone already in it. Renaming it means migrating the
// collection and re-indexing — set FACE_COLLECTION_ID if you ever do.
const COLLECTION_ID = process.env.FACE_COLLECTION_ID || 'aqui-faces';
const THRESHOLD = parseFloat(process.env.FACE_MATCH_THRESHOLD || '90');

// Rekognition reports every coordinate as a ratio of the image (0..1), which is
// exactly what the overlay needs: it stays correct at any rendered size, so no
// image dimensions have to be stored. Only geometry is kept — never the
// demographic guesses ('ALL' also returns age/gender/emotions, which this
// service has no business recording.)
function faceGeometry(detail) {
  if (!detail || !detail.BoundingBox) return null;
  const b = detail.BoundingBox;
  return {
    box: { l: b.Left, t: b.Top, w: b.Width, h: b.Height },
    points: (detail.Landmarks || []).map((m) => ({ t: m.Type, x: m.X, y: m.Y })),
    pose: detail.Pose ? { roll: detail.Pose.Roll, yaw: detail.Pose.Yaw, pitch: detail.Pose.Pitch } : null,
    confidence: detail.Confidence ?? null
  };
}

const nullMatcher = {
  enabled: false,
  status: 'deshabilitado (sin credenciales de AWS o error de inicialización)',
  async indexFace() {
    return { faceId: null, geometry: null };
  },
  async detectFace() {
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
    SearchFacesByImageCommand,
    DetectFacesCommand
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
    // Returns { faceId, geometry }. faceId is null when no face is detected;
    // geometry (bounding box + landmarks) may be present even then, since
    // Rekognition reports the detail of faces it declined to index.
    async indexFace(bytes, externalId) {
      const res = await client.send(
        new IndexFacesCommand({
          CollectionId: COLLECTION_ID,
          Image: { Bytes: bytes },
          ExternalImageId: String(externalId),
          MaxFaces: 1,
          QualityFilter: 'AUTO',
          // The default returns 5 landmarks; 'ALL' returns the full ~30-point
          // set that the public overlay draws.
          DetectionAttributes: ['ALL']
        })
      );
      const record = res.FaceRecords?.[0];
      const faceId = record?.Face?.FaceId || null;
      const geometry = faceGeometry(record?.FaceDetail || res.UnindexedFaces?.[0]?.FaceDetail);
      if (!faceId) {
        console.warn(
          `[faces] no face detected in photo ${externalId} (unindexed:`,
          JSON.stringify(res.UnindexedFaces || []),
          ')'
        );
      } else {
        console.log(
          `[faces] indexed photo ${externalId} as ${faceId} (${geometry?.points.length || 0} landmarks)`
        );
      }
      return { faceId, geometry };
    },
    // Geometry only, for photos already indexed: re-running IndexFaces on them
    // would add a duplicate face to the collection.
    async detectFace(bytes) {
      try {
        const res = await client.send(
          new DetectFacesCommand({ Image: { Bytes: bytes }, Attributes: ['ALL'] })
        );
        return faceGeometry(res.FaceDetails?.[0]);
      } catch (e) {
        if (e.name === 'InvalidParameterException') return null;
        throw e;
      }
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
    async detectFace(bytes) {
      return (await get(Date.now())).detectFace(bytes);
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
