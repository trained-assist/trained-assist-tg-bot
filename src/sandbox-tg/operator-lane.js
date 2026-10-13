const LANES = Object.freeze({
  sandbox: Object.freeze({
    botUsername: 'probability_cat_bot',
    sessionNamespace: 'integrator-existing-ux-v1',
    controlPlaneUrl: 'https://trained-assist-cp-telegram-ux-v1-sandbox.skillset-apply.workers.dev',
    serviceBinding: true,
  }),
  sandbox3: Object.freeze({
    botUsername: 'ptichka_status_bot',
    sessionNamespace: 'integrator-sandbox3-v1',
    controlPlaneUrl: 'https://trained-assist-cp-sandbox3.skillset-apply.workers.dev',
    principalId: 'integration-sandbox3-v1',
    profileId: 'integration-sandbox3-v1',
  }),
  'prod-principal': Object.freeze({
    botUsername: 'ptichka_status_bot',
    sessionNamespace: 'integrator-production-e2e-v1',
    controlPlaneUrl: 'https://trained-assist-cp-production.skillset-apply.workers.dev',
    principalId: 'production-e2e-telegram-v1',
    profileId: 'production-e2e-telegram-v1',
  }),
});

/** Return a fixed sandbox lane only when its bot, state namespace and CP agree. */
export function sandboxControlPlaneFetch(env) {
  if (sandboxOperatorLane(env) === 'prod-principal') return undefined;
  return env?.CONTROL_PLANE_SERVICE?.fetch?.bind(env.CONTROL_PLANE_SERVICE);
}

export function sandboxOperatorLane(env) {
  if (env?.TG_ACCEPT_ONLY_ENVIRONMENT !== 'sandbox' || env?.EXECUTION_BACKEND !== 'control-plane') return null;
  for (const [target, expected] of Object.entries(LANES)) {
    const correctControlPlane = expected.serviceBinding
      ? Boolean(env.CONTROL_PLANE_SERVICE) || String(env.CONTROL_PLANE_URL ?? '').replace(/\/+$/, '') === expected.controlPlaneUrl
      : String(env.CONTROL_PLANE_URL ?? '').replace(/\/+$/, '') === expected.controlPlaneUrl
        && env.CONTROL_PLANE_PROFILE === expected.profileId;
    if (String(env.TG_SANDBOX_BOT_USERNAME ?? '').replace(/^@/, '') === expected.botUsername
      && env.SESSION_NAMESPACE === expected.sessionNamespace && correctControlPlane
      && (!expected.principalId || env.CONTROL_PLANE_PRINCIPAL === expected.principalId)) return target;
  }
  return null;
}

export function sandboxOperatorToken(env, target) {
  return String(env?.[target === 'sandbox3' || target === 'prod-principal'
    ? 'TG_SANDBOX3_OPERATOR_TOKEN' : 'TG_SANDBOX_CLEANUP_TOKEN'] ?? '').trim();
}

const isPinnedTestLane = target => target === 'sandbox3' || target === 'prod-principal';

export function sandboxOperatorChatAllowed(env, config, target, chatId) {
  const value = String(chatId);
  if (isPinnedTestLane(target)) {
    const pinnedChatId = String(env?.TG_SANDBOX_E2E_CHAT_ID ?? '').trim();
    return /^-?[1-9]\d*$/.test(pinnedChatId) && value === pinnedChatId
      && String(env?.TG_SANDBOX_E2E_USER_ID ?? '').trim().match(/^[1-9]\d*$/) !== null;
  }
  return config.openSandbox === true || config.allowedChats.includes(value);
}

export function sandboxOperatorUserAllowed(env, target, userId) {
  if (!isPinnedTestLane(target)) return true;
  const pinnedUserId = String(env?.TG_SANDBOX_E2E_USER_ID ?? '').trim();
  return /^[1-9]\d*$/.test(pinnedUserId) && String(userId) === pinnedUserId;
}

export function sandboxOperatorResetChat(env, target) {
  if (!isPinnedTestLane(target)) return null;
  const value = String(env?.TG_SANDBOX_E2E_CHAT_ID ?? '').trim();
  return /^-?[1-9]\d*$/.test(value) ? value : null;
}

export function sandboxOperatorPinnedTestLane(target) {
  return isPinnedTestLane(target);
}
