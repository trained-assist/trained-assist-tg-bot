// Structured error log of the production Telegram gateway, in the same C12
// shape the sandbox slice uses (sandbox-tg/log.js): one JSON line per error or
// warning on stderr — ts, source, level, then identifiers and the reason.
//
// Never logged: bot token, secrets, message text, voice transcripts, file
// payloads. Identifiers and reasons are exactly what an operator needs.

const REDACTED_FIELDS = new Set([
  'token',
  'secret',
  'password',
  'authorization',
  'apikey',
  'text',
  'answer',
  'payload',
  'transcript',
  'voice',
  'document',
  'filebytes',
  'bodybase64',
]);

const REDACTED_PLACEHOLDER = '[redacted]';

export function redactFields(fields) {
  const out = {};
  for (const [key, value] of Object.entries(fields ?? {})) {
    out[key] = REDACTED_FIELDS.has(String(key).toLowerCase()) ? REDACTED_PLACEHOLDER : value;
  }
  return out;
}

export function formatLogLine(fields) {
  return JSON.stringify({
    ts: new Date().toISOString(),
    service: 'trained-assist-tg-bot',
    environment: 'production',
    level: 'error',
    ...redactFields(fields),
  });
}

/**
 * Log sink is injectable so tests assert on structured lines instead of
 * console noise; the default sink writes the JSON line to stderr.
 */
export function logError(fields, sink = line => console.error(line)) {
  const line = formatLogLine({ ...fields, level: 'error' });
  sink(line);
  return line;
}

export function logWarn(fields, sink = line => console.warn(line)) {
  const line = formatLogLine({ ...fields, level: 'warn' });
  sink(line);
  return line;
}

export default { logError, logWarn, formatLogLine, redactFields };
