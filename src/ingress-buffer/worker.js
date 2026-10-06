export const MAX_ARTIFACT_BYTES = 20 * 1024 * 1024;

const PROFILE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/;
const OPAQUE_REF = /^[a-f0-9]{64}$/;
const SHA256 = /^[a-f0-9]{64}$/;
const MEDIA_TYPE = /^[a-z0-9!#$&^_.+-]+\/[a-z0-9!#$&^_.+-]+$/;

const json = (value, status = 200) => new Response(JSON.stringify(value), {
  status,
  headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
});

export const sha256Hex = async bytes => [...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))]
  .map(byte => byte.toString(16).padStart(2, '0')).join('');

export function inputObjectKey(profileId, ref, version) {
  if (!PROFILE_ID.test(profileId) || !OPAQUE_REF.test(ref) || !SHA256.test(version)) throw new Error('invalid artifact identity');
  return `ingress/v1/${encodeURIComponent(profileId)}/${ref}/${version}`;
}

function manifestIsValid(manifest, profileId) {
  return Boolean(manifest && typeof manifest === 'object'
    && manifest.contractVersion === 1
    && PROFILE_ID.test(profileId)
    && manifest.ownerProfileId === profileId
    && OPAQUE_REF.test(manifest.ref)
    && SHA256.test(manifest.version)
    && manifest.sha256 === manifest.version
    && MEDIA_TYPE.test(manifest.mediaType)
    && manifest.mediaType.length <= 127
    && typeof manifest.name === 'string'
    && manifest.name.length > 0
    && manifest.name.length <= 200
    && !/[\/\\\u0000-\u001f\u007f]/.test(manifest.name)
    && Number.isSafeInteger(manifest.sizeBytes)
    && manifest.sizeBytes > 0
    && manifest.sizeBytes <= MAX_ARTIFACT_BYTES);
}

async function boundedBytes(request) {
  const declared = request.headers.get('content-length');
  if (declared && (!/^\d+$/.test(declared) || Number(declared) > MAX_ARTIFACT_BYTES)) {
    await request.body?.cancel();
    throw Object.assign(new Error('artifact too large'), { status: 413 });
  }
  if (!request.body) throw Object.assign(new Error('artifact body required'), { status: 400 });
  const reader = request.body.getReader();
  const chunks = [];
  let size = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > MAX_ARTIFACT_BYTES) {
      await reader.cancel();
      throw Object.assign(new Error('artifact too large'), { status: 413 });
    }
    chunks.push(value);
  }
  if (size === 0) throw Object.assign(new Error('artifact body required'), { status: 400 });
  if (declared && Number(declared) !== size) throw Object.assign(new Error('artifact size mismatch'), { status: 400 });
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

function authorized(request, env) {
  const token = String(env.INGRESS_BUFFER_TOKEN ?? '').trim();
  return token.length > 0 && request.headers.get('authorization') === `Bearer ${token}`;
}

function manifestFromHeaders(request) {
  const profileId = request.headers.get('x-artifact-owner-profile-id') ?? '';
  const ref = request.headers.get('x-artifact-ref') ?? '';
  const mediaType = (request.headers.get('content-type') ?? '').split(';', 1)[0].trim().toLowerCase();
  let name = '';
  try {
    name = decodeURIComponent(request.headers.get('x-artifact-name') ?? '');
  } catch {
    return null;
  }
  return { profileId, ref, mediaType, name };
}

function objectMetadataMatches(object, manifest) {
  const metadata = object?.customMetadata ?? {};
  return object.size === manifest.sizeBytes
    && metadata.contractVersion === '1'
    && metadata.ownerProfileId === manifest.ownerProfileId
    && metadata.ref === manifest.ref
    && metadata.version === manifest.version
    && metadata.mediaType === manifest.mediaType
    && metadata.name === manifest.name
    && metadata.sizeBytes === String(manifest.sizeBytes)
    && metadata.sha256 === manifest.sha256
    && (object.httpMetadata?.contentType ?? '').split(';', 1)[0].trim().toLowerCase() === manifest.mediaType;
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (!['/v1/artifacts', '/v1/manifests/verify', '/v1/artifacts/content'].includes(url.pathname)) return json({ error: 'not found' }, 404);
    if (!authorized(request, env)) return json({ error: 'unauthorized' }, 401);
    if (!env.INGRESS_MEDIA_BUCKET) return json({ error: 'buffer storage unavailable' }, 503);

    if (url.pathname === '/v1/artifacts' && request.method === 'POST') {
      const metadata = manifestFromHeaders(request);
      if (!metadata || !PROFILE_ID.test(metadata.profileId) || !OPAQUE_REF.test(metadata.ref)
        || !MEDIA_TYPE.test(metadata.mediaType) || metadata.mediaType.length > 127
        || !metadata.name || metadata.name.length > 200 || /[\/\\\u0000-\u001f\u007f]/.test(metadata.name)) {
        return json({ error: 'invalid artifact metadata' }, 400);
      }
      try {
        const bytes = await boundedBytes(request);
        const sha256 = await sha256Hex(bytes);
        const manifest = {
          contractVersion: 1,
          ref: metadata.ref,
          version: sha256,
          ownerProfileId: metadata.profileId,
          mediaType: metadata.mediaType,
          name: metadata.name,
          sizeBytes: bytes.byteLength,
          sha256,
        };
        const key = inputObjectKey(manifest.ownerProfileId, manifest.ref, manifest.version);
        const existing = await env.INGRESS_MEDIA_BUCKET.head(key);
        if (existing) {
          if (!objectMetadataMatches(existing, manifest)) return json({ error: 'immutable artifact conflict' }, 409);
          return json({ manifest, duplicate: true }, 200);
        }
        const stored = await env.INGRESS_MEDIA_BUCKET.put(key, bytes, {
          httpMetadata: { contentType: manifest.mediaType },
          customMetadata: {
            contractVersion: '1',
            ownerProfileId: manifest.ownerProfileId,
            ref: manifest.ref,
            version: manifest.version,
            mediaType: manifest.mediaType,
            name: manifest.name,
            sizeBytes: String(manifest.sizeBytes),
            sha256: manifest.sha256,
          },
        });
        if (!stored || stored.size !== manifest.sizeBytes) return json({ error: 'buffer did not confirm artifact size' }, 503);
        return json({ manifest, duplicate: false }, 201);
      } catch (error) {
        const status = Number.isInteger(error?.status) ? error.status : 503;
        return json({ error: status === 413 ? 'artifact too large' : status === 400 ? error.message : 'buffer storage unavailable' }, status);
      }
    }

    if (url.pathname === '/v1/manifests/verify' && request.method === 'POST') {
      const body = await request.json().catch(() => null);
      if (!body || typeof body.profileId !== 'string' || !manifestIsValid(body.manifest, body.profileId)) {
        return json({ error: 'invalid manifest' }, 400);
      }
      const manifest = body.manifest;
      const object = await env.INGRESS_MEDIA_BUCKET.head(inputObjectKey(body.profileId, manifest.ref, manifest.version));
      if (!objectMetadataMatches(object, manifest)) return json({ error: 'manifest not verified' }, 404);
      return json({ verified: true, manifest });
    }

    if (url.pathname === '/v1/artifacts/content' && request.method === 'GET') {
      const profileId = url.searchParams.get('profileId') ?? '';
      const ref = url.searchParams.get('ref') ?? '';
      const version = url.searchParams.get('version') ?? '';
      if (!PROFILE_ID.test(profileId) || !OPAQUE_REF.test(ref) || !SHA256.test(version)) return json({ error: 'invalid artifact identity' }, 400);
      const object = await env.INGRESS_MEDIA_BUCKET.get(inputObjectKey(profileId, ref, version));
      if (!object) return json({ error: 'artifact not found' }, 404);
      const manifest = {
        contractVersion: 1,
        ref,
        version,
        ownerProfileId: profileId,
        mediaType: object.customMetadata?.mediaType,
        name: object.customMetadata?.name,
        sizeBytes: object.size,
        sha256: object.customMetadata?.sha256,
      };
      if (!manifestIsValid(manifest, profileId) || !objectMetadataMatches(object, manifest)) return json({ error: 'artifact metadata mismatch' }, 409);
      return new Response(object.body, { headers: {
        'content-type': manifest.mediaType,
        'content-length': String(manifest.sizeBytes),
        'cache-control': 'private, no-store',
        'x-artifact-ref': manifest.ref,
        'x-artifact-version': manifest.version,
        'x-artifact-owner-profile-id': profileId,
        'x-artifact-size-bytes': String(manifest.sizeBytes),
        'x-artifact-sha256': manifest.sha256,
      } });
    }
    return json({ error: 'method not allowed' }, 405);
  },
};
