// In-memory KV shim for tests. Implements the minimal
// `get/put/delete/list` surface the slice uses.
import { TgDeliveryOwner } from '../../src/sandbox-tg/delivery-owner.js';

export class OwnerStorage {
  constructor() { this.data = new Map(); this.transactions = Promise.resolve(); }
  async get(name) { return structuredClone(this.data.get(name)); }
  async put(name, value) { this.data.set(name, structuredClone(value)); }
  async list({ prefix = '' } = {}) { return new Map([...this.data].filter(([name]) => name.startsWith(prefix)).map(([name, value]) => [name, structuredClone(value)])); }
  async transaction(callback) {
    const operation = this.transactions.then(async () => {
      const transaction = new OwnerStorage();
      transaction.data = structuredClone(this.data);
      const result = await callback(transaction);
      this.data = transaction.data;
      return result;
    });
    this.transactions = operation.catch(() => {});
    return operation;
  }
}

export function ownerState(storage = new OwnerStorage()) {
  let queue = Promise.resolve();
  return { storage, blockConcurrencyWhile(callback) {
    const result = queue.then(callback);
    queue = result.catch(() => {});
    return result;
  } };
}

export function ownerNamespace(env) {
  const owners = new Map();
  return { owners, idFromName: name => name, get(name) {
    if (!owners.has(name)) owners.set(name, new TgDeliveryOwner(ownerState(), env));
    return { fetch: request => owners.get(name).fetch(request) };
  } };
}

export class MemKV {
  constructor(options = {}) {
    this.data = new Map();
    this.pageSize = options.pageSize ?? 1000;
  }

  async get(key) {
    return this.data.has(key) ? this.data.get(key) : null;
  }

  async put(key, value) {
    this.data.set(key, typeof value === 'string' ? value : JSON.stringify(value));
  }

  async delete(key) {
    this.data.delete(key);
  }

  async list({ prefix = '', cursor = '', limit = 1000 } = {}) {
    const names = [...this.data.keys()].filter(name => name.startsWith(prefix)).sort();
    const offset = Number(cursor || 0);
    const next = offset + Math.min(limit, this.pageSize);
    return {
      keys: names.slice(offset, next).map(name => ({ name })),
      list_complete: next >= names.length,
      cursor: next >= names.length ? '' : String(next),
    };
  }
}

export async function collectLogSink() {
  const lines = [];
  const sink = line => lines.push(line);
  sink.lines = lines;
  sink.entries = () => lines.map(line => JSON.parse(line));
  return sink;
}

export function makeEnv(overrides = {}) {
  const env = {
    TG_SANDBOX_BOT_USERNAME: 'probability_cat_bot',
    TG_SANDBOX_BOT_TOKEN: 'fixture-bot-token',
    CONTROL_PLANE_URL: 'http://127.0.0.1:19789',
    CONTROL_PLANE_PRINCIPAL: 'sandbox-local',
    CONTROL_PLANE_PROFILE: 'profile-1',
    CONTROL_PLANE_API_KEY: '',
    CONTROL_PLANE_SESSION_ID: '',
    TELEGRAM_API_BASE: 'http://127.0.0.1:19790',
    TELEGRAM_WEBHOOK_SECRET: 'fixture-webhook-secret',
    TG_SLICE_ALLOWED_CHATS: '1001,1002',
    TG_SLICE_CHAT_PROFILES: '',
    TG_SLICE_EVENT_TRANSPORT: 'auto',
    TG_SLICE_BATCH_WINDOW_MS: '3000',
    TG_SLICE_MAX_BATCH_ITEMS: '20',
    TG_SLICE_DELIVERY_MAX_ATTEMPTS: '6',
    TG_SLICE_DELIVERY_RETRY_BASE_MS: '1000',
    TG_SLICE_MAX_TURNS: '32',
    TG_SLICE_MODE: 'direct',
    TG_SLICE_DELIVERY_PAUSED: 'false',
    ...overrides,
  };
  if (!Object.hasOwn(overrides, 'TG_SLICE_DELIVERY_CUTOVER_MANIFEST')) env.TG_SLICE_DELIVERY_CUTOVER_MANIFEST = JSON.stringify({
    version: 'tg-delivery-cutover-v1', botUsername: env.TG_SANDBOX_BOT_USERNAME, profileId: env.CONTROL_PLANE_PROFILE,
    cutoverId: 'synthetic-empty-inventory', cutoverAt: Date.now(), oldTaskIds: [], deliveries: [],
  });
  env.TG_DELIVERY_OWNER ??= ownerNamespace(env);
  return env;
}

export default { MemKV, collectLogSink, makeEnv };
