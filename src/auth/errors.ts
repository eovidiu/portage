export type AuthErrorCode =
  | "missing_token"
  | "malformed_token"
  | "invalid_signature"
  | "expired_token"
  | "invalid_issuer"
  | "invalid_subject";

export class AuthError extends Error {
  constructor(public readonly code: AuthErrorCode) {
    super(code);
    this.name = "AuthError";
  }
}
