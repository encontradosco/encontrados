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

  return {
    enabled: true,
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
      return res.FaceRecords?.[0]?.Face?.FaceId || null;
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
        return (res.FaceMatches || []).map((m) => ({
          faceId: m.Face.FaceId,
          similarity: m.Similarity
        }));
      } catch (e) {
        // "no face in the image" is a normal outcome, not an error
        if (e.name === 'InvalidParameterException') return [];
        throw e;
      }
    }
  };
}

module.exports = { createMatcher, nullMatcher };
