// Invocation: JWT_SECRET="<32-byte-secret>" npx tsx scripts/mint-bootstrap-token.ts
import { SignJWT } from "jose";

export async function mintBootstrapToken(secret: string): Promise<string> {
  const secretBytes = new TextEncoder().encode(secret);
  if (secretBytes.length < 32) {
    throw new Error("secret too short: JWT_SECRET must be at least 32 bytes");
  }

  return new SignJWT({})
    .setProtectedHeader({ alg: "HS256" })
    .setSubject("owner")
    .setIssuer("spotify-roon-sync")
    .setIssuedAt()
    .setExpirationTime("365d")
    .sign(secretBytes);
}

/* istanbul ignore next -- CLI entry point; uses Node.js process APIs unavailable in Workers sandbox */
async function main(): Promise<void> {
  const secret = process.env.JWT_SECRET ?? "";
  try {
    const token = await mintBootstrapToken(secret);
    process.stdout.write(token + "\n");
  } catch (err) {
    process.stderr.write((err instanceof Error ? err.message : String(err)) + "\n");
    process.exit(1);
  }
}

/* istanbul ignore next -- CLI guard only fires when invoked directly */
if (import.meta.url === new URL(process.argv[1], "file://").href) {
  main();
}
