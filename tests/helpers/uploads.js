import { vi } from 'vitest';
export function withUploads(delegate) {
  return vi.fn(async (url, opts = {}) => {
    if (String(url).includes('/intake-files?') && opts.method === 'PUT') {
      const query = new URL(String(url).replace('undefined/', 'https://agent.test/')).searchParams;
      const bytes = await new Response(opts.body).arrayBuffer();
      return Response.json({ id: query.get('id'), name: query.get('name'), mime: opts.headers['Content-Type'], size: bytes.byteLength });
    }
    return delegate(url, opts);
  });
}
