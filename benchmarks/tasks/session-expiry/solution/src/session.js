/**
 * Session helpers. `expiresAt` is a Unix timestamp in SECONDS (as issued by
 * the auth server); `now` is milliseconds (Date.now()).
 */
export function isExpired(session, now = Date.now()) {
  return session.expiresAt * 1000 <= now;
}

export function secondsRemaining(session, now = Date.now()) {
  return Math.max(0, session.expiresAt - Math.floor(now / 1000));
}

export async function ensureFresh(session, refresh, now = Date.now()) {
  if (isExpired(session, now)) return refresh(session.refreshToken);
  return session;
}
