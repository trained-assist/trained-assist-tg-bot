// Prefix every SESSIONS KV key with the bot's namespace so per-profile bots
// (recruiter, freelance) can share the production KV without inheriting each
// other's login sessions. The main bot omits SESSION_NAMESPACE → raw chatId
// keys (backward-compatible).
//
// Shared by the fetch handler (src/index.js#dispatchInner) and the IntakeBuffer
// Durable Object constructor (src/intake-buffer.js) — the DO gets `env` straight
// from the Workers runtime and can't piggyback on the fetch wrapper, so without
// this a session read inside the DO would ignore the namespace and find another
// bot's session (cross-bot auto-login bug).
//
// Idempotent: wrapping an already-wrapped env is a no-op, and the key prefixer
// never double-prefixes `recruiter:recruiter:…`. `list` is namespaced too — the
// previous inline copies left `list` un-prefixed, a latent leak that let one
// bot enumerate (and, in transient-ui cleanup, delete) another's keys.
export function applySessionNamespace(env) {
  const ns = env?.SESSION_NAMESPACE;
  if (!ns) return env;
  if (env.__sessionNamespace === ns) return env;
  const raw = env.SESSIONS;
  const prefixed = k => (typeof k === 'string' && k.startsWith(`${ns}:`) ? k : `${ns}:${k}`);
  const SESSIONS = {
    get: (k, opts) => raw.get(prefixed(k), opts),
    put: (k, v, opts) => raw.put(prefixed(k), v, opts),
    delete: k => raw.delete(prefixed(k)),
    list: (opts = {}) => raw.list({ ...opts, prefix: prefixed(opts.prefix || '') }),
  };
  return { ...env, __sessionNamespace: ns, SESSIONS };
}
