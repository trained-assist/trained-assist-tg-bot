// Transport identity on the wire for a given bot deployment.
//
// One Worker env == one bot == one audience (1:1 for now, see issue #1302 §2):
//   main       → SESSION_NAMESPACE unset → 'default'
//   recruiter  → SESSION_NAMESPACE=recruiter → 'recruiter'
//   freelance  → SESSION_NAMESPACE=freelance → 'freelance'
//
// The backend keys sessions/projects by username+chatId, so two bots serving the
// same human must send distinct `audience` values or they mix each other's
// sessions (the #1290 cross-bot leak). One resolver keeps that mapping from
// drifting across agent-client.js / commands.js / telegram.js.
export const resolveAudience = (env) => env?.SESSION_NAMESPACE || 'default';
