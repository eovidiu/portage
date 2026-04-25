/**
 * Neon branch lifecycle helpers for integration tests.
 * Each test file creates one branch (shared across tests in that file) to amortize
 * the ~5-15s branch creation cost.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import * as https from "node:https";
import { neon } from "@neondatabase/serverless";

const NEON_API_BASE = "https://console.neon.tech/api/v2";
const PROJECT_ID = "square-wave-04443485";

function getNeonApiKey(): string {
  if (process.env.NEON_API_KEY) return process.env.NEON_API_KEY;
  const envPath = path.resolve(process.cwd(), ".env");
  if (fs.existsSync(envPath)) {
    const text = fs.readFileSync(envPath, "utf-8");
    const match = text.match(/^NEON_API_KEY\s*=\s*"?([^"\n]+)"?/m);
    if (match) return match[1].trim();
  }
  throw new Error("NEON_API_KEY not found in process.env or .env");
}

type JsonValue = Record<string, unknown> | unknown[] | string | number | boolean | null;

function neonApiFetch(endpoint: string, options: { method?: string; body?: JsonValue } = {}): Promise<JsonValue> {
  const apiKey = getNeonApiKey();
  return new Promise((resolve, reject) => {
    const url = new URL(`${NEON_API_BASE}${endpoint}`);
    const body = options.body ? JSON.stringify(options.body) : undefined;
    const req = https.request(
      {
        hostname: url.hostname,
        path: url.pathname + url.search,
        method: options.method ?? "GET",
        headers: {
          Authorization: `Bearer ${apiKey}`,
          "Content-Type": "application/json",
          Accept: "application/json",
          ...(body ? { "Content-Length": Buffer.byteLength(body).toString() } : {}),
        },
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (chunk: Buffer) => { chunks.push(chunk); });
        res.on("end", () => {
          const data = Buffer.concat(chunks).toString("utf-8");
          try {
            resolve(JSON.parse(data) as JsonValue);
          } catch {
            reject(new Error(`Neon API non-JSON response (${res.statusCode}): ${data.slice(0, 200)}`));
          }
        });
      }
    );
    req.on("error", reject);
    if (body) req.write(body);
    req.end();
  });
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

export interface BranchContext {
  branchId: string;
  connectionString: string;
}

export async function createTestBranch(label: string): Promise<BranchContext> {
  const branchName = `integ-test-${label}-${crypto.randomUUID().slice(0, 8)}`;

  const createResult = await neonApiFetch(`/projects/${PROJECT_ID}/branches`, {
    method: "POST",
    body: { branch: { name: branchName }, endpoints: [{ type: "read_write" }] },
  }) as {
    branch: { id: string };
    endpoints: Array<{ host: string }>;
  };

  const branchId = createResult.branch.id;
  const endpointHost = createResult.endpoints[0].host;

  const prodConnStr = getProductionConnectionString();
  const prodUrl = new URL(prodConnStr);
  const connString = [
    `postgresql://${prodUrl.username}`,
    `:${decodeURIComponent(prodUrl.password)}`,
    `@${endpointHost}/neondb?channel_binding=require&sslmode=require`,
  ].join("");

  // Wait for the compute to be ready before applying schema
  await waitForEndpoint(connString);

  // Apply schema to the fresh branch
  await applySchema(connString);

  return { branchId, connectionString: connString };
}

export async function deleteTestBranch(branchId: string): Promise<void> {
  await neonApiFetch(`/projects/${PROJECT_ID}/branches/${branchId}`, { method: "DELETE" });
}

async function waitForEndpoint(connString: string, maxAttempts = 20, intervalMs = 2000): Promise<void> {
  const sql = neon(connString);
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      await sql("SELECT 1");
      return;
    } catch {
      if (attempt === maxAttempts) {
        throw new Error(`Neon branch endpoint did not become ready after ${maxAttempts} attempts`);
      }
      await sleep(intervalMs);
    }
  }
}

async function applySchema(connString: string): Promise<void> {
  const sql = neon(connString);
  const schemaPath = path.resolve(process.cwd(), "db/schema.sql");
  const schemaSql = fs.readFileSync(schemaPath, "utf-8");
  const stmts = splitSqlStatements(schemaSql);
  for (const stmt of stmts) {
    await sql(stmt, []);
  }
}

function getProductionConnectionString(): string {
  for (const filename of [".dev.vars", ".env"]) {
    const filePath = path.resolve(process.cwd(), filename);
    if (!fs.existsSync(filePath)) continue;
    const text = fs.readFileSync(filePath, "utf-8");
    const match = text.match(/^DATABASE_URL\s*=\s*"?([^"\n]+)"?/m);
    if (match) return match[1].trim();
  }
  throw new Error("DATABASE_URL not found in .dev.vars or .env");
}

function splitSqlStatements(sql: string): string[] {
  const withoutLineComments = sql.replace(/--[^\n]*/g, "");
  return withoutLineComments
    .split(";")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}
