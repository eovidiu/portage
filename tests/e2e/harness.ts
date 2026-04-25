/**
 * Shared e2e test helpers. Manages the wrangler dev lifecycle and provides
 * utilities for minting JWTs, making timed HTTP requests, and computing percentiles.
 *
 * Hardware baseline: results documented below are measured on an Apple M-series Mac.
 * On slower machines (shared CI, older hardware) the absolute latency thresholds in
 * T-001-10 (< 5 ms) and T-014-03 (< 50 ms) may legitimately fail.
 */

import { spawn, type ChildProcess } from "node:child_process";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { SignJWT } from "jose";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const PROJECT_ROOT = join(__dirname, "../..");
const WRANGLER_PORT = 8787;
const BASE_URL = `http://localhost:${WRANGLER_PORT}`;
const STARTUP_TIMEOUT_MS = 30_000;

// Read JWT_SECRET from .dev.vars at module load time (not logged).
// Wrangler strips surrounding quotes from values, so we do the same.
function readJwtSecret(): string {
  const devVarsPath = join(PROJECT_ROOT, ".dev.vars");
  const contents = readFileSync(devVarsPath, "utf8");
  for (const line of contents.split("\n")) {
    const trimmed = line.trim();
    if (trimmed.startsWith("JWT_SECRET=")) {
      const raw = trimmed.slice("JWT_SECRET=".length).trim();
      // Strip optional surrounding double or single quotes (wrangler strips them too).
      return raw.replace(/^["'](.*)["']$/, "$1");
    }
  }
  throw new Error(".dev.vars missing JWT_SECRET — cannot run e2e tests");
}

const JWT_SECRET = readJwtSecret();
const JWT_SECRET_BYTES = new TextEncoder().encode(JWT_SECRET);

/** Mint a fresh bootstrap JWT signed with the real .dev.vars JWT_SECRET. */
export async function mintToken(overrides: { sub?: string; iss?: string } = {}): Promise<string> {
  return new SignJWT({})
    .setProtectedHeader({ alg: "HS256" })
    .setSubject(overrides.sub ?? "owner")
    .setIssuer(overrides.iss ?? "spotify-roon-sync")
    .setIssuedAt()
    .setExpirationTime("1h")
    .sign(JWT_SECRET_BYTES);
}

/** Issue a GET and return the response + wall-clock duration in ms. */
export async function timedFetch(
  path: string,
  headers: Record<string, string> = {},
  options: { redirect?: RequestRedirect } = {}
): Promise<{ res: Response; durationMs: number }> {
  const start = performance.now();
  const res = await fetch(`${BASE_URL}${path}`, { headers, redirect: options.redirect ?? "follow" });
  const durationMs = performance.now() - start;
  return { res, durationMs };
}

/** Compute the p-th percentile (0–100) of a sorted numeric array. */
export function percentile(sortedValues: number[], p: number): number {
  if (sortedValues.length === 0) return 0;
  const idx = Math.floor((sortedValues.length * p) / 100);
  return sortedValues[Math.min(idx, sortedValues.length - 1)];
}

/** Poll localhost:port until it accepts a TCP connection, or throw after timeoutMs. */
async function waitForPort(port: number, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`http://localhost:${port}/healthz`);
      await res.text(); // drain body
      return;
    } catch {
      await new Promise((r) => setTimeout(r, 250));
    }
  }
  throw new Error(`wrangler dev did not become ready on port ${port} within ${timeoutMs} ms`);
}

let wranglerProc: ChildProcess | null = null;

/** Start wrangler dev and wait until it's accepting requests. */
export async function startWrangler(): Promise<void> {
  if (wranglerProc) return;

  wranglerProc = spawn(
    "node",
    ["node_modules/.bin/wrangler", "dev", "--port", String(WRANGLER_PORT), "--local"],
    {
      cwd: PROJECT_ROOT,
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env },
    }
  );

  // Forward wrangler stderr to our stderr for debugging — don't suppress errors.
  wranglerProc.stderr?.on("data", (chunk: Buffer) => {
    process.stderr.write(chunk);
  });

  wranglerProc.on("error", (err) => {
    process.stderr.write(`[harness] wrangler spawn error: ${err.message}\n`);
  });

  await waitForPort(WRANGLER_PORT, STARTUP_TIMEOUT_MS);
}

/** SIGTERM wrangler dev and wait for it to exit. */
export async function stopWrangler(): Promise<void> {
  if (!wranglerProc) return;
  const proc = wranglerProc;
  wranglerProc = null;
  await new Promise<void>((resolve) => {
    proc.on("close", () => resolve());
    proc.kill("SIGTERM");
    // Force-kill after 5 s if SIGTERM didn't work.
    setTimeout(() => {
      try { proc.kill("SIGKILL"); } catch { /* already dead */ }
    }, 5_000);
  });
}
