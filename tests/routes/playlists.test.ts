// T-021 + T-022: /api/playlists route tests (list + add)
import { createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { Hono } from "hono";
import { SignJWT } from "jose";
import type { Env } from "../../src/env";
import type { PlaylistConfigRow } from "../../src/db/playlist_configs";

vi.mock("../../src/db/playlist_configs");
vi.mock("../../src/providers/spotify/playlists");
vi.mock("@neondatabase/serverless", () => ({
  neon: () => vi.fn(),
}));

import {
  listPlaylistConfigs,
  getPlaylistConfig,
  upsertPlaylistConfig,
} from "../../src/db/playlist_configs";
import { fetchSpotifyPlaylistName } from "../../src/providers/spotify/playlists";

const mockListPlaylistConfigs = vi.mocked(listPlaylistConfigs);
const mockGetPlaylistConfig = vi.mocked(getPlaylistConfig);
const mockUpsertPlaylistConfig = vi.mocked(upsertPlaylistConfig);
const mockFetchSpotifyPlaylistName = vi.mocked(fetchSpotifyPlaylistName);

const VALID_PLAYLIST_ID = "37i9dQZF1DXcBWIGoYBM5M";

function makeEnv(): Env {
  return {
    DATABASE_URL: "postgresql://test",
    JWT_SECRET: "test-jwt-secret-32-bytes-long-ok!",
    TOKEN_ENCRYPTION_KEY: "dGVzdC1lbmNyeXB0aW9uLWtleS0zMmJ5dGVzLWxvbmc=",
    SPOTIFY_CLIENT_ID: "spotify-client-id",
    SPOTIFY_CLIENT_SECRET: "spotify-client-secret",
    SPOTIFY_REDIRECT_URI: "https://portage.eovidiu.co.uk/auth/spotify/callback",
    TIDAL_CLIENT_ID: "tidal-client-id",
    TIDAL_CLIENT_SECRET: "tidal-client-secret",
    TIDAL_REDIRECT_URI: "https://portage.eovidiu.co.uk/auth/tidal/callback",
    TIDAL_COUNTRY_CODE: "RO",
    TIDAL_PLAYLIST_TITLE: "Spotify Liked",
  };
}

async function mintBearer(secret: string): Promise<string> {
  return new SignJWT({})
    .setProtectedHeader({ alg: "HS256" })
    .setIssuer("spotify-roon-sync")
    .setSubject("owner")
    .setIssuedAt()
    .setExpirationTime("1h")
    .sign(new TextEncoder().encode(secret));
}

async function doFetch(
  path: string,
  opts: { method?: string; body?: unknown; authed?: boolean } = {},
): Promise<Response> {
  const { default: playlistsRoute } = await import("../../src/routes/playlists");
  const { jwtMiddleware } = await import("../../src/middleware/auth");
  const env = makeEnv();
  const app = new Hono<{ Bindings: Env }>();
  app.use("*", jwtMiddleware([]));
  app.route("/api", playlistsRoute);

  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (opts.authed !== false) {
    const token = await mintBearer(env.JWT_SECRET);
    headers["Authorization"] = `Bearer ${token}`;
  }

  const ctx = createExecutionContext();
  const req = new Request(`https://worker.test${path}`, {
    method: opts.method ?? "GET",
    headers,
    body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
  });
  const res = await app.fetch(req, env, ctx);
  await waitOnExecutionContext(ctx);
  return res;
}

beforeEach(() => {
  vi.resetAllMocks();
});

const LIKED_ROW: PlaylistConfigRow = {
  spotify_playlist_id: "__liked__",
  spotify_name: "Liked Songs",
  tidal_playlist_id: "f10ce98a-e3b8-4bc4-96ca-d38ab88ca3c5",
  created_at: "2026-05-09T00:00:00Z",
  last_synced_at: "2026-05-09T07:23:00Z",
  enabled: true,
};

const EXTRA_ROW: PlaylistConfigRow = {
  spotify_playlist_id: VALID_PLAYLIST_ID,
  spotify_name: "Today's Top Hits",
  tidal_playlist_id: null,
  created_at: "2026-05-09T08:00:00Z",
  last_synced_at: null,
  enabled: true,
};

// ============ T-021: GET /api/playlists ============

describe("GET /api/playlists — liked-only (T-021-01)", () => {
  it("returns the __liked__ row alone when registry has only the seeded row", async () => {
    mockListPlaylistConfigs.mockResolvedValue([LIKED_ROW]);
    const res = await doFetch("/api/playlists");
    expect(res.status).toBe(200);
    const body = (await res.json()) as PlaylistConfigRow[];
    expect(body).toHaveLength(1);
    expect(body[0]?.spotify_playlist_id).toBe("__liked__");
  });
});

describe("GET /api/playlists — liked + extras (T-021-02)", () => {
  it("returns rows with __liked__ first, extras after", async () => {
    // DB returns in arbitrary order; the route is responsible for ordering.
    mockListPlaylistConfigs.mockResolvedValue([EXTRA_ROW, LIKED_ROW]);
    const res = await doFetch("/api/playlists");
    expect(res.status).toBe(200);
    const body = (await res.json()) as PlaylistConfigRow[];
    expect(body).toHaveLength(2);
    expect(body[0]?.spotify_playlist_id).toBe("__liked__");
    expect(body[1]?.spotify_playlist_id).toBe(VALID_PLAYLIST_ID);
  });
});

describe("GET /api/playlists — multiple extras sorted by created_at (T-021-02b)", () => {
  it("places __liked__ first, then extras in created_at ascending order", async () => {
    const earlier: PlaylistConfigRow = {
      ...EXTRA_ROW,
      spotify_playlist_id: "ZZZZZZZZZZZZZZZZZZZZZZ",
      spotify_name: "Older",
      created_at: "2026-05-01T00:00:00Z",
    };
    const later: PlaylistConfigRow = {
      ...EXTRA_ROW,
      spotify_playlist_id: "AAAAAAAAAAAAAAAAAAAAAA",
      spotify_name: "Newer",
      created_at: "2026-05-08T00:00:00Z",
    };
    // DB returns later first; route must reorder by created_at ascending.
    mockListPlaylistConfigs.mockResolvedValue([later, earlier, LIKED_ROW]);
    const res = await doFetch("/api/playlists");
    expect(res.status).toBe(200);
    const body = (await res.json()) as PlaylistConfigRow[];
    expect(body.map((r) => r.spotify_playlist_id)).toEqual([
      "__liked__",
      "ZZZZZZZZZZZZZZZZZZZZZZ", // older first among extras
      "AAAAAAAAAAAAAAAAAAAAAA", // newer last
    ]);
  });
});

describe("GET /api/playlists — unauthenticated (T-021-03)", () => {
  it("returns 401 when no Authorization header", async () => {
    const res = await doFetch("/api/playlists", { authed: false });
    expect(res.status).toBe(401);
    expect(mockListPlaylistConfigs).not.toHaveBeenCalled();
  });
});

// ============ T-026a: enabled + last_synced_at projection ============

describe("GET /api/playlists — includes enabled and last_synced_at fields (T-026a-06)", () => {
  it("returns enabled: true on default rows and enabled: false on a disabled row", async () => {
    const disabled: PlaylistConfigRow = { ...EXTRA_ROW, enabled: false };
    mockListPlaylistConfigs.mockResolvedValue([LIKED_ROW, disabled]);
    const res = await doFetch("/api/playlists");
    expect(res.status).toBe(200);
    const body = (await res.json()) as PlaylistConfigRow[];
    expect(body).toHaveLength(2);
    expect(body[0]?.enabled).toBe(true);
    expect(body[1]?.enabled).toBe(false);
  });

  it("preserves an ISO last_synced_at on a synced row and null on an unsynced row", async () => {
    const unsynced: PlaylistConfigRow = { ...EXTRA_ROW, last_synced_at: null };
    const synced: PlaylistConfigRow = { ...LIKED_ROW, last_synced_at: "2026-05-16T18:00:00Z" };
    mockListPlaylistConfigs.mockResolvedValue([synced, unsynced]);
    const res = await doFetch("/api/playlists");
    expect(res.status).toBe(200);
    const body = (await res.json()) as PlaylistConfigRow[];
    expect(body[0]?.last_synced_at).toBe("2026-05-16T18:00:00Z");
    expect(body[1]?.last_synced_at).toBeNull();
  });
});

describe("GET /api/playlists — disabled rows still appear (T-026a-07)", () => {
  it("does not filter out enabled: false rows from the GET response", async () => {
    const enabledRow: PlaylistConfigRow = { ...EXTRA_ROW, enabled: true };
    const disabledA: PlaylistConfigRow = {
      ...EXTRA_ROW,
      spotify_playlist_id: "DDDDDDDDDDDDDDDDDDDDDD",
      enabled: false,
    };
    const disabledB: PlaylistConfigRow = {
      ...EXTRA_ROW,
      spotify_playlist_id: "EEEEEEEEEEEEEEEEEEEEEE",
      enabled: false,
    };
    mockListPlaylistConfigs.mockResolvedValue([LIKED_ROW, enabledRow, disabledA, disabledB]);
    const res = await doFetch("/api/playlists");
    expect(res.status).toBe(200);
    const body = (await res.json()) as PlaylistConfigRow[];
    expect(body).toHaveLength(4);
    expect(body.filter((r) => !r.enabled)).toHaveLength(2);
  });
});

describe("POST /api/playlists — synthetic row reflects enabled: true (T-026a-09)", () => {
  it("returns enabled: true on the synthetic 201 response after insert", async () => {
    mockGetPlaylistConfig.mockResolvedValueOnce(null);
    mockFetchSpotifyPlaylistName.mockResolvedValue("Today's Top Hits");
    mockUpsertPlaylistConfig.mockResolvedValue(undefined);
    const res = await doFetch("/api/playlists", {
      method: "POST",
      body: { spotify_playlist_id: VALID_PLAYLIST_ID },
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as PlaylistConfigRow;
    expect(body.enabled).toBe(true);
  });
});

// ============ T-022: POST /api/playlists ============

describe("POST /api/playlists — valid new id (T-022-01)", () => {
  it("inserts a new row and returns 201 with a synthetic row reflecting the insert", async () => {
    mockGetPlaylistConfig.mockResolvedValueOnce(null); // not present yet
    mockFetchSpotifyPlaylistName.mockResolvedValue("Today's Top Hits");
    mockUpsertPlaylistConfig.mockResolvedValue(undefined);

    const res = await doFetch("/api/playlists", {
      method: "POST",
      body: { spotify_playlist_id: VALID_PLAYLIST_ID },
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as PlaylistConfigRow;
    expect(body.spotify_playlist_id).toBe(VALID_PLAYLIST_ID);
    expect(body.spotify_name).toBe("Today's Top Hits");
    expect(body.tidal_playlist_id).toBeNull();
    expect(body.last_synced_at).toBeNull();
    expect(typeof body.created_at).toBe("string");
    expect(mockUpsertPlaylistConfig).toHaveBeenCalledWith(expect.anything(), {
      spotify_playlist_id: VALID_PLAYLIST_ID,
      spotify_name: "Today's Top Hits",
    });
  });
});

describe("POST /api/playlists — malformed id (T-022-02)", () => {
  it("returns 400 invalid_playlist_id and writes nothing", async () => {
    const res = await doFetch("/api/playlists", {
      method: "POST",
      body: { spotify_playlist_id: "abc" },
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body).toEqual({ error: "invalid_playlist_id" });
    expect(mockGetPlaylistConfig).not.toHaveBeenCalled();
    expect(mockUpsertPlaylistConfig).not.toHaveBeenCalled();
  });

  it("returns 400 when body is missing spotify_playlist_id entirely", async () => {
    const res = await doFetch("/api/playlists", { method: "POST", body: {} });
    expect(res.status).toBe(400);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body).toEqual({ error: "invalid_playlist_id" });
  });

  it("returns 400 when body is not JSON", async () => {
    const { default: playlistsRoute } = await import("../../src/routes/playlists");
    const { jwtMiddleware } = await import("../../src/middleware/auth");
    const env = makeEnv();
    const app = new Hono<{ Bindings: Env }>();
    app.use("*", jwtMiddleware([]));
    app.route("/api", playlistsRoute);
    const token = await mintBearer(env.JWT_SECRET);
    const ctx = createExecutionContext();
    const req = new Request("https://worker.test/api/playlists", {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: "not json {{{",
    });
    const res = await app.fetch(req, env, ctx);
    await waitOnExecutionContext(ctx);
    expect(res.status).toBe(400);
  });
});

describe("POST /api/playlists — duplicate is idempotent (T-022-03)", () => {
  it("returns 200 with the existing row and does NOT call Spotify or upsert", async () => {
    mockGetPlaylistConfig.mockResolvedValueOnce({ ...EXTRA_ROW });

    const res = await doFetch("/api/playlists", {
      method: "POST",
      body: { spotify_playlist_id: VALID_PLAYLIST_ID },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as PlaylistConfigRow;
    expect(body.spotify_playlist_id).toBe(VALID_PLAYLIST_ID);
    expect(mockFetchSpotifyPlaylistName).not.toHaveBeenCalled();
    expect(mockUpsertPlaylistConfig).not.toHaveBeenCalled();
  });
});

describe("POST /api/playlists — Spotify 404 (T-022-04)", () => {
  it("returns 404 spotify_playlist_not_found when fetchSpotifyPlaylistName fails with 404", async () => {
    mockGetPlaylistConfig.mockResolvedValueOnce(null);
    mockFetchSpotifyPlaylistName.mockRejectedValue(
      new Error("Spotify playlist name fetch failed: 404 for " + VALID_PLAYLIST_ID),
    );

    const res = await doFetch("/api/playlists", {
      method: "POST",
      body: { spotify_playlist_id: VALID_PLAYLIST_ID },
    });
    expect(res.status).toBe(404);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body).toEqual({ error: "spotify_playlist_not_found" });
    expect(mockUpsertPlaylistConfig).not.toHaveBeenCalled();
  });

  it("returns 502 spotify_unreachable for non-404 Spotify errors", async () => {
    mockGetPlaylistConfig.mockResolvedValueOnce(null);
    mockFetchSpotifyPlaylistName.mockRejectedValue(
      new Error("Spotify playlist name fetch failed: 500 for " + VALID_PLAYLIST_ID),
    );

    const res = await doFetch("/api/playlists", {
      method: "POST",
      body: { spotify_playlist_id: VALID_PLAYLIST_ID },
    });
    expect(res.status).toBe(502);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body).toEqual({ error: "spotify_unreachable" });
  });
});

describe("POST /api/playlists — unauthenticated (T-022-05)", () => {
  it("returns 401 when no Authorization header", async () => {
    const res = await doFetch("/api/playlists", {
      method: "POST",
      body: { spotify_playlist_id: VALID_PLAYLIST_ID },
      authed: false,
    });
    expect(res.status).toBe(401);
    expect(mockGetPlaylistConfig).not.toHaveBeenCalled();
  });
});
