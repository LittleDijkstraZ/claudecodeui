/** Accept only the three base64url segments used by the existing auth flow. */
export const isValidRefreshedToken = (token: unknown): token is string =>
  typeof token === 'string' && /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(token);
