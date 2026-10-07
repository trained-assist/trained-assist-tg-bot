// Регистрация пакета накопителя в control plane (arch#132 R9).
//
// Зачем. Окно «сообщение принято накопителем, задачи ещё НЕ создана» — то самое,
// где 2026-10-04 потерялся ввод: у накопителя есть свой таймер, и если он не
// взведён или сломан, ввод не виден никому. Наружу нужен след: batchId, когда
// пришло ПЕРВОЕ сообщение, состояние подготовки, граница ожидания и адрес
// доставки — иначе внешний детектор (который живёт вне накопителя) не сможет
// отличить «пользователь думает» от «ввод потерялся».
//
// ГРАНИЦЫ. Канал и durable-приём — зона шлюза; общее состояние задач и переходы —
// control plane. Здесь только сообщение «у меня накоплено вот это». Переход и
// запуск выполняет существующий владелец, не этот модуль.
//
// ВСЁ BEST-EFFORT. Недоступность control plane не имеет права ломать приём
// сообщений: сбой регистрации пишется в лог и молча уходит. Иначе детектор,
// который мы строим, сам стал бы причиной тишины.
//
// Молчание по умолчанию: без CONTROL_PLANE_URL/SECRET модуль — no-op.

const PRINCIPAL_HEADER = 'x-principal';
const PRINCIPAL_SIGNATURE_HEADER = 'x-principal-sig';
const DEFAULT_TIMEOUT_MS = 3000;

const hex = (buf) => [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');

/** HMAC-SHA256(secret, principalId) — та же схема, что ждёт control plane. */
async function sign(secret, principalId) {
  const key = await crypto.subtle.importKey(
    'raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'],
  );
  return hex(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(principalId)));
}

/** Подготовленные заголовки: пусто, если control plane не настроен. */
export async function controlPlaneHeaders(env) {
  const secret = env?.CONTROL_PLANE_SECRET;
  const principalId = env?.CONTROL_PLANE_PRINCIPAL || 'gateway';
  if (!env?.CONTROL_PLANE_URL || !secret) return null;
  return {
    'Content-Type': 'application/json',
    [PRINCIPAL_HEADER]: principalId,
    [PRINCIPAL_SIGNATURE_HEADER]: await sign(secret, principalId),
  };
}

/**
 * Сообщить control plane о пакете, который накопитель держит.
 *
 * Идемпотентно по batchId на стороне control plane: повторные вызовы (новые
 * сообщения в том же пакете) НЕ передвигают время первого сообщения — иначе
 * активный чат подменял бы возраст самого старого ввода свежими.
 */
export async function registerPendingBatch(env, batch) {
  const headers = await controlPlaneHeaders(env);
  if (!headers || !batch?.batchId) return false;
  try {
    const res = await fetch(`${env.CONTROL_PLANE_URL.replace(/\/$/, '')}/intake/pending`, {
      method: 'PUT',
      headers,
      body: JSON.stringify({
        batchId: batch.batchId,
        version: batch.version ?? 1,
        profileId: batch.profileId,
        channel: batch.channel ?? 'telegram',
        conversationId: batch.conversationId ?? null,
        audienceId: batch.audienceId ?? null,
        destinationId: batch.destinationId ?? null,
        firstMessageAt: batch.firstMessageAt,
        prepState: batch.prepState ?? 'collecting',
        deadlineMs: batch.deadlineMs,
      }),
      signal: AbortSignal.timeout(DEFAULT_TIMEOUT_MS),
    });
    if (!res.ok) {
      console.warn(`[pending-intake] register ${batch.batchId} → ${res.status}`, (await res.text().catch(() => '')).slice(0, 120));
      return false;
    }
    return true;
  } catch (e) {
    console.warn(`[pending-intake] register ${batch.batchId} failed: ${e.message}`);
    return false;
  }
}

/**
 * Пакет больше не ждёт: он ушёл в задачу (userTaskId известна → связываем),
 * отменён или очищен. Решение пользователя не должно выглядеть как зависание.
 */
export async function closePendingBatch(env, batchId, reason, userTaskId = null) {
  const headers = await controlPlaneHeaders(env);
  if (!headers || !batchId) return false;
  try {
    const res = await fetch(`${env.CONTROL_PLANE_URL.replace(/\/$/, '')}/intake/pending/gone`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ batchId, reason, userTaskId }),
      signal: AbortSignal.timeout(DEFAULT_TIMEOUT_MS),
    });
    if (!res.ok) {
      console.warn(`[pending-intake] close ${batchId} → ${res.status}`);
      return false;
    }
    return true;
  } catch (e) {
    console.warn(`[pending-intake] close ${batchId} failed: ${e.message}`);
    return false;
  }
}
