import { afterEach, describe, expect, it, vi } from 'vitest';
import { formatLogLine, logError, logWarn } from '../src/log.js';
import {
  activeErrorPublisher,
  buildErrorEvent,
  createErrorPublisher,
  getDroppedCount,
  getSpool,
  initErrorPublisher,
  resolveErrorPublisher,
} from '../src/error-publisher.js';

const WATCHER = { watcherUrl: 'https://watcher.test', watcherKey: 'wk-1', environment: 'production' };

const lastCall = fetchMock => fetchMock.mock.calls.at(-1);

afterEach(() => {
  vi.unstubAllGlobals();
  initErrorPublisher({});
});

describe('log: formatLogLine produces a valid, redacted JSON line', () => {
  it('carries ts, source and level alongside the fields', () => {
    const line = formatLogLine({ code: 'DELIVERY_FAILED', message: 'boom', chatId: 7 });
    expect(() => JSON.parse(line)).not.toThrow();
    const parsed = JSON.parse(line);
    expect(parsed.ts).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(parsed.service).toBe('trained-assist-tg-bot');
    expect(parsed.environment).toBe('production');
    expect(parsed.level).toBe('error');
    expect(parsed.code).toBe('DELIVERY_FAILED');
    expect(parsed.message).toBe('boom');
    expect(parsed.chatId).toBe(7);
  });

  it('redacts sensitive fields case-insensitively and keeps the rest', () => {
    const line = formatLogLine({
      token: 't-1',
      secret: 's-1',
      password: 'p-1',
      Authorization: 'Bearer abc',
      apikey: 'k-1',
      text: 'user said hi',
      answer: 'model reply',
      payload: 'blob',
      transcript: 'voice words',
      voice: 'ogg',
      document: 'file',
      filebytes: 'base64',
      bodybase64: 'base64',
      requestId: 'req-1',
    });
    const parsed = JSON.parse(line);
    for (const key of ['token', 'secret', 'password', 'Authorization', 'apikey', 'text', 'answer', 'payload', 'transcript', 'voice', 'document', 'filebytes', 'bodybase64']) {
      expect(parsed[key]).toBe('[redacted]');
    }
    expect(parsed.requestId).toBe('req-1');
  });

  it('logError writes level error, logWarn writes level warn to their sinks', () => {
    const lines = [];
    expect(logError({ code: 'A' }, line => lines.push(line))).toBe(lines[0]);
    logWarn({ code: 'B' }, line => lines.push(line));
    expect(lines).toHaveLength(2);
    expect(JSON.parse(lines[0])).toMatchObject({ level: 'error', code: 'A', service: 'trained-assist-tg-bot' });
    expect(JSON.parse(lines[1])).toMatchObject({ level: 'warn', code: 'B' });
  });
});

describe('buildErrorEvent: C12 ErrorEvent for gateway failures', () => {
  it('profile scope with a known chat, telegram reply context', () => {
    const event = buildErrorEvent({ code: 'DISPATCH_ERROR', operation: 'dispatch', message: 'boom', chatId: -100123, traceId: 'req-9' });
    expect(event.schemaVersion).toBe(1);
    expect(event.eventId).toMatch(/^[0-9a-f-]{36}$/);
    expect(event.occurredAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(event.source).toEqual({ service: 'trained-assist-tg-bot', release: 'unknown', environment: 'production' });
    expect(event.scope).toEqual({ kind: 'profile', tenantId: null, profileId: '-100123' });
    expect(event.correlation).toEqual({ userTaskId: null, runId: null, traceId: 'req-9' });
    expect(event.replyContext).toEqual({ channel: 'telegram', destinationRef: '-100123', status: 'known' });
    expect(event.error).toEqual({
      code: 'DISPATCH_ERROR',
      operation: 'dispatch',
      severity: 'error',
      retryable: true,
      outcome: 'failed',
      safeSummary: 'boom',
      privateDetailsRef: null,
    });
    expect(event.origin).toEqual({ kind: 'application', incidentId: null, diagnosticDepth: 0 });
  });

  it('profile scope from userTaskId alone, platform scope without either', () => {
    const withTask = buildErrorEvent({ code: 'X', message: 'm', userTaskId: 'ut-1' });
    expect(withTask.scope).toEqual({ kind: 'profile', tenantId: null, profileId: 'ut-1' });
    const platform = buildErrorEvent({ code: 'OUTBOX_REJECTED', message: 'm' });
    expect(platform.scope).toEqual({ kind: 'platform', tenantId: null, profileId: null });
    expect(platform.replyContext).toEqual({ channel: 'telegram', destinationRef: null, status: 'not_applicable' });
  });

  it('truncates safeSummary to 240 chars', () => {
    const event = buildErrorEvent({ code: 'X', message: 'x'.repeat(500) });
    expect(event.error.safeSummary).toHaveLength(240);
    expect(buildErrorEvent({ code: 'X', message: 'short' }).error.safeSummary).toBe('short');
  });
});

describe('error-publisher: publishError POSTs to the watcher', () => {
  it('sends the correct C12 ErrorEvent with key and scope headers', async () => {
    const fetchMock = vi.fn(async () => new Response('{"reasonCode":"EVENT_ACCEPTED"}', { status: 202 }));
    vi.stubGlobal('fetch', fetchMock);
    const publish = createErrorPublisher(WATCHER);
    const event = buildErrorEvent({ code: 'DISPATCH_ERROR', operation: 'dispatch', message: 'boom', chatId: -100123, traceId: 'req-1' });

    await publish(event);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = lastCall(fetchMock);
    expect(url).toBe('https://watcher.test/errors');
    expect(init.method).toBe('POST');
    expect(init.signal).toBeTruthy();
    const headers = init.headers;
    expect(headers['content-type']).toBe('application/json');
    expect(headers['x-watcher-key']).toBe('wk-1');
    expect(headers['x-watcher-scopes']).toBe('error:write');
    const body = JSON.parse(String(init.body));
    expect(body).toEqual(event);
    expect(body.source).toEqual({ service: 'trained-assist-tg-bot', release: 'unknown', environment: 'production' });
    expect(body.scope).toEqual({ kind: 'profile', tenantId: null, profileId: '-100123' });
    expect(body.correlation).toEqual({ userTaskId: null, runId: null, traceId: 'req-1' });
    expect(body.replyContext).toEqual({ channel: 'telegram', destinationRef: '-100123', status: 'known' });
    expect(body.error.severity).toBe('error');
    expect(body.error.outcome).toBe('failed');
    expect(body.error.retryable).toBe(true);
    expect(body.origin).toEqual({ kind: 'application', incidentId: null, diagnosticDepth: 0 });
  });

  it('keeps /errors URLs single and honours the configured environment', async () => {
    const fetchMock = vi.fn(async () => new Response('{}', { status: 202 }));
    vi.stubGlobal('fetch', fetchMock);
    const event = buildErrorEvent({ code: 'X', message: 'm' });

    await createErrorPublisher({ ...WATCHER, watcherUrl: 'https://watcher.test/errors' })(event);
    expect(lastCall(fetchMock)[0]).toBe('https://watcher.test/errors');

    await createErrorPublisher({ ...WATCHER, watcherUrl: 'https://watcher.test/' })(event);
    expect(lastCall(fetchMock)[0]).toBe('https://watcher.test/errors');

    await createErrorPublisher({ ...WATCHER, environment: 'staging' })(event);
    expect(JSON.parse(String(lastCall(fetchMock)[1].body)).source.environment).toBe('staging');
  });

  it('redacts secrets in fields and safeSummary before sending', async () => {
    const fetchMock = vi.fn(async () => new Response('{}', { status: 202 }));
    vi.stubGlobal('fetch', fetchMock);
    const publish = createErrorPublisher(WATCHER);
    const event = {
      ...buildErrorEvent({ code: 'UPSTREAM_AUTH', message: 'upstream 401, Bearer eyJhbGciOiJIUzI1Ni.abc123 token=supersecretvalue', chatId: 1 }),
      token: 'raw-secret-token',
    };

    await publish(event);

    const body = JSON.parse(String(lastCall(fetchMock)[1].body));
    expect(body.token).toBe('[redacted]');
    expect(body.error.safeSummary).toContain('Bearer [redacted]');
    expect(body.error.safeSummary).not.toContain('eyJhbGciOiJIUzI1Ni');
    expect(body.error.safeSummary).not.toContain('supersecretvalue');
    expect(body.error.code).toBe('UPSTREAM_AUTH');
  });

  it('on fetch failure the dropped count increments, the event is spooled and nothing throws', async () => {
    const publish = createErrorPublisher(WATCHER);
    const droppedBefore = getDroppedCount();
    const spoolBefore = getSpool().length;

    vi.stubGlobal('fetch', vi.fn(async () => {
      throw new Error('network down');
    }));
    await expect(publish(buildErrorEvent({ code: 'NET_DOWN', message: 'm' }))).resolves.toBeUndefined();
    expect(getDroppedCount()).toBe(droppedBefore + 1);
    expect(getSpool().length).toBe(spoolBefore + 1);
    expect(getSpool().at(-1).error.code).toBe('NET_DOWN');

    vi.stubGlobal('fetch', vi.fn(async () => new Response('unavailable', { status: 500 })));
    await expect(publish(buildErrorEvent({ code: 'HTTP_500', message: 'm' }))).resolves.toBeUndefined();
    expect(getDroppedCount()).toBe(droppedBefore + 2);
    expect(getSpool().at(-1).error.code).toBe('HTTP_500');
    expect(publish.getDroppedCount()).toBe(getDroppedCount());
  });

  it('spool stays capped at 100 events', async () => {
    const publish = createErrorPublisher(WATCHER);
    vi.stubGlobal('fetch', vi.fn(async () => {
      throw new Error('down');
    }));
    for (let i = 0; i < 105; i++) await publish(buildErrorEvent({ code: 'SPOOL', message: String(i) }));
    expect(getSpool().length).toBe(100);
  });
});

describe('resolveErrorPublisher', () => {
  it('returns null unless both ERROR_WATCHER_URL and ERROR_WATCHER_KEY are set', () => {
    expect(resolveErrorPublisher({})).toBeNull();
    expect(resolveErrorPublisher(undefined)).toBeNull();
    expect(resolveErrorPublisher({ ERROR_WATCHER_URL: 'https://watcher.test' })).toBeNull();
    expect(resolveErrorPublisher({ ERROR_WATCHER_KEY: 'wk-1' })).toBeNull();
    expect(resolveErrorPublisher({ ERROR_WATCHER_URL: '   ', ERROR_WATCHER_KEY: 'wk-1' })).toBeNull();
    expect(resolveErrorPublisher({ ERROR_WATCHER_URL: 'https://watcher.test', ERROR_WATCHER_KEY: 'wk-1' })).toBeTypeOf('function');
  });

  it('initErrorPublisher publishes through the active publisher for token-only callers', async () => {
    const fetchMock = vi.fn(async () => new Response('{}', { status: 202 }));
    vi.stubGlobal('fetch', fetchMock);
    expect(activeErrorPublisher()).toBeNull();

    initErrorPublisher({ ERROR_WATCHER_URL: 'https://watcher.test', ERROR_WATCHER_KEY: 'wk-1' });
    expect(activeErrorPublisher()).toBeTypeOf('function');
    await activeErrorPublisher()(buildErrorEvent({ code: 'TELEGRAM_SEND_FAILED', message: 'm', chatId: 5 }));
    expect(lastCall(fetchMock)[0]).toBe('https://watcher.test/errors');

    initErrorPublisher({});
    expect(activeErrorPublisher()).toBeNull();
  });
});
