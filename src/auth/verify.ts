import { jwtVerify } from "jose";
import { AuthError } from "./errors";

const ISSUER = "spotify-roon-sync";
const SUBJECT_ALLOWLIST = ["owner"];

export async function verifyJwt(token: string, secret: string): Promise<{ subject: string }> {
  const secretBytes = new TextEncoder().encode(secret);

  let payload;
  try {
    const result = await jwtVerify(token, secretBytes, {
      algorithms: ["HS256"],
      issuer: ISSUER,
      clockTolerance: 30,
    });
    payload = result.payload;
  } catch (err) {
    const code = (err as { code?: string }).code ?? "";

    if (code === "ERR_JWS_SIGNATURE_VERIFICATION_FAILED") {
      throw new AuthError("invalid_signature");
    }
    if (code === "ERR_JWT_EXPIRED") {
      throw new AuthError("expired_token");
    }
    if (code === "ERR_JWT_CLAIM_VALIDATION_FAILED") {
      const claim = (err as { claim?: string }).claim ?? "";
      if (claim === "iss") throw new AuthError("invalid_issuer");
      throw new AuthError("malformed_token");
    }
    throw new AuthError("malformed_token");
  }

  const sub = payload.sub;
  if (!sub || !SUBJECT_ALLOWLIST.includes(sub)) {
    throw new AuthError("invalid_subject");
  }

  return { subject: sub };
}
