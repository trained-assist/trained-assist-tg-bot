// Project picker state lives in SESSIONS KV, which is eventually consistent across
// colos (up to ~60s). In groups the picker is usually opened by the IntakeBuffer DO
// (flush), while the tap is handled by the webhook in another colo that still reads
// the OLD pendingProjectChoice → messageId mismatch → «⌛ Меню устарело», the task is
// never launched and «Запускай» just reopens the picker (owner, 2026-09-24).
// The chat's IntakeBuffer DO is strongly consistent, so the picker is mirrored there
// and the tap handler trusts the mirror when KV looks stale. Best-effort: any failure
// falls back to the KV-only behaviour.
const stubFor = (env, chatId) => env?.INTAKE?.get?.(env.INTAKE.idFromName(String(chatId)));

export async function mirrorPicker(env, chatId, pending) {
  try {
    await stubFor(env, chatId)?.fetch('https://intake/picker', { method: 'PUT', body: JSON.stringify({ pending: pending || null }) });
  } catch { /* best-effort */ }
}

export async function readPicker(env, chatId) {
  try {
    const res = await stubFor(env, chatId)?.fetch('https://intake/picker');
    if (!res?.ok) return null;
    return (await res.json())?.pending || null;
  } catch { return null; }
}
