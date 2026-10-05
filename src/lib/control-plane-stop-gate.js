export function controlPlaneStopDisabled(env) {
  return env.EXECUTION_BACKEND === 'control-plane' && env.TG_SLICE_STOP_ENABLED === 'false';
}

export function controlPlaneStopDisabledError() {
  return Object.assign(new Error('Control Plane stop is disabled'), { code: 'CONTROL_PLANE_STOP_DISABLED', stopConfirmed: false });
}
