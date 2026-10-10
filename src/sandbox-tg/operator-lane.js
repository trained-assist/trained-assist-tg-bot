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
    profileId: 'integration-sandbox3-v1',
  }),
});

/** Return a fixed sandbox lane only when its bot, state namespace and CP agree. */
export function sandboxOperatorLane(env) {
  if (env?.TG_ACCEPT_ONLY_ENVIRONMENT !== 'sandbox' || env?.EXECUTION_BACKEND !== 'control-plane') return null;
  for (const [target, expected] of Object.entries(LANES)) {
    const correctControlPlane = expected.serviceBinding
      ? Boolean(env.CONTROL_PLANE_SERVICE) || String(env.CONTROL_PLANE_URL ?? '').replace(/\/+$/, '') === expected.controlPlaneUrl
      : String(env.CONTROL_PLANE_URL ?? '').replace(/\/+$/, '') === expected.controlPlaneUrl
        && env.CONTROL_PLANE_PROFILE === expected.profileId;
    if (String(env.TG_SANDBOX_BOT_USERNAME ?? '').replace(/^@/, '') === expected.botUsername
      && env.SESSION_NAMESPACE === expected.sessionNamespace && correctControlPlane) return target;
  }
  return null;
}

export function sandboxOperatorToken(env, target) {
  return String(env?.[target === 'sandbox3' ? 'TG_SANDBOX3_OPERATOR_TOKEN' : 'TG_SANDBOX_CLEANUP_TOKEN'] ?? '').trim();
}

export function sandboxOperatorChatAllowed(env, config, target, chatId) {
  const value = String(chatId);
  if (target === 'sandbox3') {
    const pinnedChatId = String(env?.TG_SANDBOX_E2E_CHAT_ID ?? '').trim();
    return /^-?[1-9]\d*$/.test(pinnedChatId) && value === pinnedChatId
      && String(env?.TG_SANDBOX_E2E_USER_ID ?? '').trim().match(/^[1-9]\d*$/) !== null;
  }
  return config.openSandbox === true || config.allowedChats.includes(value);
}

export function sandboxOperatorUserAllowed(env, target, userId) {
  if (target !== 'sandbox3') return true;
  const pinnedUserId = String(env?.TG_SANDBOX_E2E_USER_ID ?? '').trim();
  return /^[1-9]\d*$/.test(pinnedUserId) && String(userId) === pinnedUserId;
}

export function sandboxOperatorResetChat(env, target) {
  if (target !== 'sandbox3') return null;
  const value = String(env?.TG_SANDBOX_E2E_CHAT_ID ?? '').trim();
  return /^-?[1-9]\d*$/.test(value) ? value : null;
}
