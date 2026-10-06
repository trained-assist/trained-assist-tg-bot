import { describe, expect, it } from 'vitest';
import worker, { MAX_ARTIFACT_BYTES } from '../src/ingress-buffer/worker.js';

class MemoryR2 {
  objects = new Map();

  async head(key) {
    const object = this.objects.get(key);
    return object ? { size: object.bytes.byteLength, customMetadata: object.customMetadata, httpMetadata: object.httpMetadata } : null;
  }

  async put(key, value, options) {
    const bytes = new Uint8Array(value);
    const object = { bytes, customMetadata: options.customMetadata, httpMetadata: options.httpMetadata };
    this.objects.set(key, object);
    return { size: bytes.byteLength };
  }

  async get(key) {
    const object = this.objects.get(key);
    return object ? { ...object, size: object.bytes.byteLength, body: object.bytes } : null;
  }
}

const token = 'fixture-buffer-token';
const profileId = 'profile-1';
const ref = 'a'.repeat(64);
const auth = { authorization: `Bearer ${token}` };

describe('passive ingress buffer', () => {
  const call = (path, init = {}, bucket = new MemoryR2(), headers = auth) => worker.fetch(
    new Request(`https://buffer.test${path}`, { ...init, headers: { ...headers, ...init.headers } }),
    { INGRESS_BUFFER_TOKEN: token, INGRESS_MEDIA_BUCKET: bucket },
  );

  it('requires the private bearer credential before touching storage', async () => {
    const bucket = new MemoryR2();
    const response = await call('/v1/artifacts', { method: 'POST', body: 'x' }, bucket, {});
    expect(response.status).toBe(401);
    expect(bucket.objects.size).toBe(0);
  });

  it('stores, verifies, and serves immutable bytes with manifest-bound metadata', async () => {
    const bucket = new MemoryR2();
    const bytes = new TextEncoder().encode('audio fixture');
    const stored = await call('/v1/artifacts', { method: 'POST', body: bytes, headers: {
      'content-type': 'audio/ogg', 'content-length': String(bytes.byteLength),
      'x-artifact-owner-profile-id': profileId, 'x-artifact-ref': ref,
      'x-artifact-name': encodeURIComponent('voice.ogg'),
    } }, bucket);
    expect(stored.status).toBe(201);
    const { manifest } = await stored.json();
    expect(manifest).toMatchObject({ contractVersion: 1, ref, ownerProfileId: profileId, mediaType: 'audio/ogg', name: 'voice.ogg', sizeBytes: bytes.byteLength, version: manifest.sha256 });

    const verified = await call('/v1/manifests/verify', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ profileId, manifest }) }, bucket);
    expect(verified.status).toBe(200);
    expect(await verified.json()).toMatchObject({ verified: true, manifest });

    const content = await call(`/v1/artifacts/content?profileId=${profileId}&ref=${ref}&version=${manifest.version}`, {}, bucket);
    expect(content.status).toBe(200);
    expect(new Uint8Array(await content.arrayBuffer())).toEqual(bytes);
    expect(content.headers.get('x-artifact-sha256')).toBe(manifest.sha256);
  });

  it('rejects owner mismatch, corrupt metadata, and over-limit bodies', async () => {
    const bucket = new MemoryR2();
    const bytes = new TextEncoder().encode('fixture');
    const uploaded = await call('/v1/artifacts', { method: 'POST', body: bytes, headers: {
      'content-type': 'application/pdf', 'content-length': String(bytes.byteLength),
      'x-artifact-owner-profile-id': profileId, 'x-artifact-ref': ref,
      'x-artifact-name': encodeURIComponent('report.pdf'),
    } }, bucket);
    const { manifest } = await uploaded.json();
    const mismatch = await call('/v1/manifests/verify', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ profileId: 'profile-other', manifest }) }, bucket);
    expect(mismatch.status).toBe(400);

    const key = `ingress/v1/${profileId}/${ref}/${manifest.version}`;
    bucket.objects.get(key).customMetadata.sha256 = 'f'.repeat(64);
    const corrupt = await call(`/v1/artifacts/content?profileId=${profileId}&ref=${ref}&version=${manifest.version}`, {}, bucket);
    expect(corrupt.status).toBe(409);

    const oversized = await call('/v1/artifacts', { method: 'POST', headers: {
      'content-length': String(MAX_ARTIFACT_BYTES + 1), 'content-type': 'application/pdf',
      'x-artifact-owner-profile-id': profileId, 'x-artifact-ref': 'b'.repeat(64), 'x-artifact-name': 'large.pdf',
    }, body: 'x' }, bucket);
    expect(oversized.status).toBe(413);
  });
});
