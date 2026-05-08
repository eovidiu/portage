import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Env } from "../../src/env";

vi.mock("@neondatabase/serverless", () => ({
  neon: () => vi.fn(),
}));

vi.mock("../../src/db/playlist_configs", () => ({
  upsertPlaylistConfig: vi.fn(),
}));

vi.mock("../../src/providers/spotify/playlists", () => ({
  fetchSpotifyPlaylistName: vi.fn(),
}));

import { seedPlaylistConfigs } from "../../src/sync/playlist-config-seeder";
import { upsertPlaylistConfig } from "../../src/db/playlist_configs";
import { fetchSpotifyPlaylistName } from "../../src/providers/spotify/playlists";

const mockUpsert = vi.mocked(upsertPlaylistConfig);
const mockFetchName = vi.mocked(fetchSpotifyPlaylistName);

const makeEnv = (overrides: Partial<Env> = {}): Env => ({
  DATABASE_URL: "postgresql://test",
  JWT_SECRET: "secret",
  TOKEN_ENCRYPTION_KEY: btoa(String.fromCharCode(...new Array(32).fill(0x42))),
  SPOTIFY_CLIENT_ID: "",
  SPOTIFY_CLIENT_SECRET: "",
  SPOTIFY_REDIRECT_URI: "",
  TIDAL_CLIENT_ID: "",
  TIDAL_CLIENT_SECRET: "",
  TIDAL_REDIRECT_URI: "",
  TIDAL_COUNTRY_CODE: "RO",
  TIDAL_PLAYLIST_TITLE: "Spotify Liked",
  ...overrides,
});

beforeEach(() => {
  mockUpsert.mockReset();
  mockUpsert.mockResolvedValue(undefined);
  mockFetchName.mockReset();
});

describe("T-016-11: Seeder seeds __liked__ if absent", () => {
  it("upserts __liked__ when env var undefined and skips fetchSpotifyPlaylistName", async () => {
    await seedPlaylistConfigs(makeEnv());
    expect(mockUpsert).toHaveBeenCalledTimes(1);
    expect(mockUpsert).toHaveBeenCalledWith(
      expect.anything(),
      { spotify_playlist_id: "__liked__", spotify_name: "Spotify Liked" },
    );
    expect(mockFetchName).not.toHaveBeenCalled();
  });

  it("upserts __liked__ when env var is empty string", async () => {
    await seedPlaylistConfigs(makeEnv({ SPOTIFY_EXTRA_PLAYLIST_IDS: "" }));
    expect(mockUpsert).toHaveBeenCalledTimes(1);
    expect(mockFetchName).not.toHaveBeenCalled();
  });
});

describe("T-016-12: Seeder upserts extras from env var", () => {
  it("upserts __liked__ + each extra after fetching the name", async () => {
    mockFetchName
      .mockResolvedValueOnce("Workout")
      .mockResolvedValueOnce("Roadtrip");

    await seedPlaylistConfigs(
      makeEnv({ SPOTIFY_EXTRA_PLAYLIST_IDS: "abc123,def456" }),
    );

    expect(mockFetchName).toHaveBeenCalledTimes(2);
    expect(mockFetchName).toHaveBeenNthCalledWith(1, expect.anything(), "abc123");
    expect(mockFetchName).toHaveBeenNthCalledWith(2, expect.anything(), "def456");
    expect(mockUpsert).toHaveBeenCalledWith(
      expect.anything(),
      { spotify_playlist_id: "__liked__", spotify_name: "Spotify Liked" },
    );
    expect(mockUpsert).toHaveBeenCalledWith(
      expect.anything(),
      { spotify_playlist_id: "abc123", spotify_name: "Workout" },
    );
    expect(mockUpsert).toHaveBeenCalledWith(
      expect.anything(),
      { spotify_playlist_id: "def456", spotify_name: "Roadtrip" },
    );
  });
});

describe("T-016-13: Seeder trims whitespace and skips empty entries", () => {
  it("trims surrounding whitespace and skips empty CSV entries", async () => {
    mockFetchName
      .mockResolvedValueOnce("A")
      .mockResolvedValueOnce("B");

    await seedPlaylistConfigs(
      makeEnv({ SPOTIFY_EXTRA_PLAYLIST_IDS: " abc123 ,, def456 ," }),
    );

    expect(mockFetchName).toHaveBeenCalledTimes(2);
    expect(mockFetchName).toHaveBeenNthCalledWith(1, expect.anything(), "abc123");
    expect(mockFetchName).toHaveBeenNthCalledWith(2, expect.anything(), "def456");
  });

  it("ignores explicit __liked__ entries in env var (avoids duplicate work)", async () => {
    await seedPlaylistConfigs(
      makeEnv({ SPOTIFY_EXTRA_PLAYLIST_IDS: "__liked__" }),
    );
    expect(mockFetchName).not.toHaveBeenCalled();
    expect(mockUpsert).toHaveBeenCalledTimes(1);
  });
});

describe("T-016-14: Seeder continues past a single fetch failure", () => {
  it("logs structured failure and processes remaining IDs", async () => {
    mockFetchName
      .mockRejectedValueOnce(
        new Error("Spotify playlist name fetch failed: 404 for badid"),
      )
      .mockResolvedValueOnce("Good");

    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

    await seedPlaylistConfigs(
      makeEnv({ SPOTIFY_EXTRA_PLAYLIST_IDS: "badid,goodid" }),
    );

    // upsert: __liked__ + goodid (badid skipped)
    expect(mockUpsert).toHaveBeenCalledTimes(2);
    expect(mockUpsert).toHaveBeenCalledWith(
      expect.anything(),
      { spotify_playlist_id: "goodid", spotify_name: "Good" },
    );
    expect(mockUpsert).not.toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ spotify_playlist_id: "badid" }),
    );

    // structured log line for the failure
    const logged = logSpy.mock.calls.map((c) => c[0] as string);
    const failureLog = logged.find((l) => l.includes("playlist_name_fetch_failed"));
    expect(failureLog).toBeTruthy();
    expect(failureLog).toContain("badid");

    logSpy.mockRestore();
  });
});

describe("T-016-14b: Seeder logs non-Error throws", () => {
  it("handles a non-Error rejection by stringifying it in the log", async () => {
    mockFetchName.mockRejectedValueOnce("string-fetch-error");

    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

    await seedPlaylistConfigs(
      makeEnv({ SPOTIFY_EXTRA_PLAYLIST_IDS: "abc123" }),
    );

    const logged = logSpy.mock.calls.map((c) => c[0] as string);
    const failureLog = logged.find((l) => l.includes("playlist_name_fetch_failed"));
    expect(failureLog).toBeTruthy();
    expect(failureLog).toContain("string-fetch-error");
    // upsert: __liked__ only; abc123 was skipped
    expect(mockUpsert).toHaveBeenCalledTimes(1);

    logSpy.mockRestore();
  });
});

describe("T-016-15: Seeder is idempotent", () => {
  it("repeated invocations do not produce extra upserts beyond their per-call count", async () => {
    mockFetchName.mockResolvedValue("Workout");

    await seedPlaylistConfigs(
      makeEnv({ SPOTIFY_EXTRA_PLAYLIST_IDS: "abc123" }),
    );
    await seedPlaylistConfigs(
      makeEnv({ SPOTIFY_EXTRA_PLAYLIST_IDS: "abc123" }),
    );

    // 2 invocations × (1 __liked__ + 1 extra) = 4 upserts; idempotency at the
    // DB layer (ON CONFLICT DO UPDATE) is what makes the actual table state
    // correct. The seeder itself does NOT memoise across invocations.
    expect(mockUpsert).toHaveBeenCalledTimes(4);
  });
});

describe("T-016-17: Empty env var produces no Spotify subrequests", () => {
  it("undefined and empty string env both result in 0 fetch calls", async () => {
    await seedPlaylistConfigs(makeEnv({ SPOTIFY_EXTRA_PLAYLIST_IDS: undefined }));
    await seedPlaylistConfigs(makeEnv({ SPOTIFY_EXTRA_PLAYLIST_IDS: "" }));
    expect(mockFetchName).not.toHaveBeenCalled();
  });
});
