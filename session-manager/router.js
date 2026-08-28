/**
 * Message routing: decide whether to start a new session or continue an existing one.
 *
 * Rules (in order):
 *   1. No active sessions → NEW
 *   2. Message contains explicit "new session" signals → NEW
 *   3. Exactly one active session → CONTINUE (silent, no question)
 *   4. Multiple sessions → ask Haiku which one fits → ASK user
 */

const Anthropic = require('@anthropic-ai/sdk');

const NEW_SIGNALS = /\b(новая?\s*(сессия|тема|задача|проект|диалог|разговор)|начн[иёе]|другая?\s*(тема|задача)|отдельн|fresh\s*(start|session)|new\s*(topic|session|task)|смени\s*тему|хватит об этом)\b/i;

async function routeMessage({ text, sessions, apiKey }) {
  // Rule 1
  if (!sessions.length) return { action: 'new' };

  // Rule 2
  if (NEW_SIGNALS.test(text)) return { action: 'new' };

  // Rule 3
  if (sessions.length === 1) {
    return { action: 'continue', sessionName: sessions[0][0] };
  }

  // Rule 4 — ask Haiku
  try {
    return await classifyWithHaiku({ text, sessions, apiKey });
  } catch {
    return { action: 'ask', sessions };
  }
}

async function classifyWithHaiku({ text, sessions, apiKey }) {
  const client = new Anthropic({ apiKey });

  const list = sessions
    .map(([name, s], i) => `${i + 1}. [${name}] "${s.summary || s.taskDescription.slice(0, 80)}"`)
    .join('\n');

  const { content } = await client.messages.create({
    model: 'claude-haiku-4-5-20251001',
    max_tokens: 30,
    messages: [{
      role: 'user',
      content: `User message: "${text}"\n\nActive sessions:\n${list}\n\nReply ONLY:\nNEW\nCONTINUE 1\nCONTINUE 2\n...`,
    }],
  });

  const reply = content[0].text.trim();

  if (reply.startsWith('CONTINUE')) {
    const idx = parseInt(reply.split(' ')[1], 10) - 1;
    if (sessions[idx]) {
      return { action: 'continue', sessionName: sessions[idx][0] };
    }
  }

  return { action: 'ask', sessions };
}

module.exports = { routeMessage };
