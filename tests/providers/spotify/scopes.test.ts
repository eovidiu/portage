import { describe, it, expect } from "vitest";
import { SPOTIFY_SCOPES } from "../../../src/providers/spotify/scopes";

// F-030: centralized Spotify OAuth scope set (design.md D8, spec
// spotify-playlist-write "Centralized Spotify scope set").
describe("SPOTIFY_SCOPES", () => {
  it("is the space-separated grounded scope set", () => {
    expect(SPOTIFY_SCOPES).toBe(
      "user-library-read playlist-read-private playlist-modify-private",
    );
  });

  it("contains exactly the three grounded scopes, no more, no fewer", () => {
    const scopes = SPOTIFY_SCOPES.split(" ");
    expect(scopes).toEqual([
      "user-library-read",
      "playlist-read-private",
      "playlist-modify-private",
    ]);
  });
});
