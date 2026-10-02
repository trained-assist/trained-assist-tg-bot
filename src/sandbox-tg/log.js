// Structured log of the Telegram sandbox slice, in the C12 shape the web slice
// uses (log.ts): event name, profile, correlation of ingress/profile/channel/
// task/run, journal key, and the REASON for every transition or refusal.
//
// Never logged: bot token, control-plane key, message text, voice transcript,
// file contents. Identifiers and reasons are exactly what an operator needs.

const REDACTED_FIELDS = new Set([
  'apikey',
  'authorization',
  'text',
  'answer',
  'payload',
  'transcript',
  'voice',
  'document',
  'filebytes',
  'bodybase64',
  'secret',
  'token',
  'bottoken',
  'botusername',
  'update',
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
    service: 'trained-assist-tg-sandbox-slice',
    environment: 'sandbox',
    ...redactFields(fields),
  });
}

/**
 * Log sink is injectable so tests assert on structured lines instead of
 * console noise, and the e2e harness can collect them into its report.
 */
export function logTg(fields, sink = line => console.log(line)) {
  const line = formatLogLine(fields);
  sink(line);
  return line;
}

/** Collecting sink — used by tests and the e2e report. */
export function createLogCollector() {
  const lines = [];
  const sink = line => {
    lines.push(line);
  };
  sink.lines = lines;
  sink.entries = () => lines.map(line => JSON.parse(line));
  return sink;
}

export default { logTg, formatLogLine, redactFields, createLogCollector };