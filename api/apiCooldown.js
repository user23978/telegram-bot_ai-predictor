let cooldownUntil = 0;
let lastReason = null;

const DEFAULT_COOLDOWN_MS = Number(process.env.API_RATE_LIMIT_COOLDOWN_MS) || 10 * 60 * 1000;

export function isApiCoolingDown() {
  return Date.now() < cooldownUntil;
}

export function getApiCooldownState() {
  return {
    active: isApiCoolingDown(),
    cooldownUntil,
    remainingMs: Math.max(0, cooldownUntil - Date.now()),
    reason: lastReason
  };
}

export function markApiRateLimited(reason = 'HTTP 429') {
  cooldownUntil = Date.now() + DEFAULT_COOLDOWN_MS;
  lastReason = reason;
}

export function clearApiCooldown() {
  cooldownUntil = 0;
  lastReason = null;
}

export function shouldSkipApi() {
  return isApiCoolingDown();
}
