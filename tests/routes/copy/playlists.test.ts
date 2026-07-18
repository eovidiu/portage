import { createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { Hono } from "hono";
import { SignJWT } from "jose";
import type { Env } from "../../../src/env";

vi.mock("../../../src/db/provider_tokens", () => ({ hasSpotifyScopes: vi.fn() }));
vi.mock("../../../src/providers/tidal/own-playlists", () => ({ listOwnPlaylists: vi.fn() }));
vi.mock("../../../src/providers/spotify/playlists", () => ({ listOwnPlaylists: vi.fn() }));

import copyPlaylistsRoute from "../../../src/routes/copy/playlists";
import { hasSpotifyScopes } from "../../../src/db/provider_tokens";
import { listOwnPlaylists as listTidalOwnPlaylists } from "../../../src/providers/tidal/own-playlists";
import { listOwnPlaylists as listSpotifyOwnPlaylists } from "../../../src/providers/spotify/playlists";

const mockHasSpotifyScopes = vi.mocked(hasSpotifyScopes);
const mockListTidalOwnPlaylists = vi.mocked(listTidalOwnPlaylists);
const mockListSpotifyOwnPlaylists = vi.mocked(listSpotifyOwnPlaylists);

function makeEnv(): Env {
  return {
    DATABASE_URL: "postgresql://test",
    JWT_SECRET: "test-jwt-secret-32-bytes-long-ok!",
    TOKEN_ENCRYPTION_KEY: "dGVzdC1lbmNyeXB0aW9uLWtleS0zMmJ5dGVzLWxvbmc=",
    SPOTIFY_CLIENT_ID: "",
    SPOTIFY_CLIENT_SECRET: "",
    SPOTIFY_REDIRECT_URI: "",
    TIDAL_CLIENT_ID: "",
    TIDAL_CLIENT_SECRET: "",
    TIDAL_REDIRECT_URI: "",
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

async function doFetch(path: string, opts: { authed?: boolean } = {}): Promise<Response> {
  const { jwtMiddleware } = await import("../../../src/middleware/auth");
  const env = makeEnv();
  const app = new Hono<{ Bindings: Env }>();
  app.use("*", jwtMiddleware([]));
  app.route("/api/copy", copyPlaylistsRoute);

  const headers: Record<string, string> = {};
  if (opts.authed !== false) {
    headers["Authorization"] = `Bearer ${await mintBearer(env.JWT_SECRET)}`;
  }

  const ctx = createExecutionContext();
  const req = new Request(`https://worker.test${path}`, { headers });
  const res = await app.fetch(req, env, ctx);
  await waitOnExecutionContext(ctx);
  return res;
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("GET /api/copy/playlists — Spotify", () => {
  it("returns 200 with id/name/track_count and next_cursor", async () => {
    mockHasSpotifyScopes.mockResolvedValueOnce(true);
    mockListSpotifyOwnPlaylists.mockResolvedValueOnce({
      playlists: [{ id: "sp1", name: "My Playlist", trackCount: 42 }],
      nextOffset: 50,
    });

    const res = await doFetch("/api/copy/playlists?provider=spotify");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({
      playlists: [{ id: "sp1", name: "My Playlist", track_count: 42 }],
      next_cursor: "50",
    });
  });

  it("returns 409 spotify_reauth_required when the scope is missing", async () => {
    mockHasSpotifyScopes.mockResolvedValueOnce(false);
    const res = await doFetch("/api/copy/playlists?provider=spotify");
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: "spotify_reauth_required" });
    expect(mockListSpotifyOwnPlaylists).not.toHaveBeenCalled();
  });

  it("passes the cursor query param through as an offset", async () => {
    mockHasSpotifyScopes.mockResolvedValueOnce(true);
    mockListSpotifyOwnPlaylists.mockResolvedValueOnce({ playlists: [], nextOffset: null });
    await doFetch("/api/copy/playlists?provider=spotify&cursor=50");
    expect(mockListSpotifyOwnPlaylists).toHaveBeenCalledWith(expect.anything(), 50);
  });
});

describe("GET /api/copy/playlists — Tidal", () => {
  it("returns 200 mapped from data[] attributes with next_cursor from links.meta.nextCursor", async () => {
    mockListTidalOwnPlaylists.mockResolvedValueOnce({
      playlists: [{ id: "td1", name: "Tidal Playlist", numberOfItems: 7 }],
      hasMore: true,
      cursor: "abc",
    });

    const res = await doFetch("/api/copy/playlists?provider=tidal");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      playlists: [{ id: "td1", name: "Tidal Playlist", track_count: 7 }],
      next_cursor: "abc",
    });
    expect(mockHasSpotifyScopes).not.toHaveBeenCalled();
  });

  it("passes the cursor query param through verbatim", async () => {
    mockListTidalOwnPlaylists.mockResolvedValueOnce({ playlists: [], hasMore: false, cursor: null });
    await doFetch("/api/copy/playlists?provider=tidal&cursor=xyz");
    expect(mockListTidalOwnPlaylists).toHaveBeenCalledWith(expect.anything(), "xyz");
  });

  it("defaults track_count to 0 when numberOfItems is null", async () => {
    mockListTidalOwnPlaylists.mockResolvedValueOnce({
      playlists: [{ id: "td2", name: "T2", numberOfItems: null }],
      hasMore: false,
      cursor: null,
    });
    const res = await doFetch("/api/copy/playlists?provider=tidal");
    const body = (await res.json()) as { playlists: Array<{ track_count: number }> };
    expect(body.playlists[0].track_count).toBe(0);
  });
});

describe("GET /api/copy/playlists — validation", () => {
  it("returns 422 when provider is missing", async () => {
    const res = await doFetch("/api/copy/playlists");
    expect(res.status).toBe(422);
  });

  it("returns 422 when provider is not spotify/tidal", async () => {
    const res = await doFetch("/api/copy/playlists?provider=deezer");
    expect(res.status).toBe(422);
  });
});

describe("GET /api/copy/playlists — unauthenticated", () => {
  it("returns 401 without a bearer token", async () => {
    const res = await doFetch("/api/copy/playlists?provider=tidal", { authed: false });
    expect(res.status).toBe(401);
    expect(mockListTidalOwnPlaylists).not.toHaveBeenCalled();
  });
});
