import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

// CLASS FIX for the live "Buffer is not defined" photo-upload crash.
//
// Root cause: message.js used the bare `Buffer` global, relying on
// compatibility_flags = ["nodejs_compat"] in wrangler.toml to provide it.
// It doesn't — Cloudflare Workers only expose Buffer via an explicit
// `import { Buffer } from 'node:buffer'`, never as an ambient global. Node
// (where these tests run) DOES have a global Buffer, so a vitest test can't
// reproduce the crash behaviourally: deleting globalThis.Buffer to simulate
// the Workers runtime also breaks Node's own fetch (undici lazily requires
// the global Buffer on first call), producing an unrelated false failure.
//
// So the regression guard is static: any file under src/ that references
// `Buffer.` must import it explicitly from 'node:buffer'. This also catches
// the same class of bug in any future file, not just this one call site.
const SRC_DIR = path.join(import.meta.dirname, '..', 'src');

function listJsFiles(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return listJsFiles(full);
    return entry.name.endsWith('.js') ? [full] : [];
  });
}

describe('no bare Buffer global usage', () => {
  it('every file that uses Buffer.* imports it from node:buffer', () => {
    const offenders = listJsFiles(SRC_DIR)
      .filter((file) => /\bBuffer\./.test(fs.readFileSync(file, 'utf8')))
      .filter((file) => !/from ['"]node:buffer['"]/.test(fs.readFileSync(file, 'utf8')))
      .map((file) => path.relative(SRC_DIR, file));

    expect(offenders).toEqual([]);
  });
});
