/** Missing or invalid environment configuration. */
export class ConfigError extends Error {
  override name = 'ConfigError';
}

/** The user must log in again (no tokens, or the refresh token was rejected). */
export class AuthError extends Error {
  override name = 'AuthError';
}

/** The X token endpoint rejected a request. */
export class TokenRequestError extends Error {
  override name = 'TokenRequestError';
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}
