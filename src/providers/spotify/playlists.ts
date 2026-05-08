// F-016: Spotify playlist name lookup. Used by the seeder when adding a new
// extra playlist to the registry. Auth handled by spotifyFetch (R6 — 401
// retries are coalesced via the F-002 refresh path).

import { spotifyFetch } from "./oauth";
import type { Env } from "../../env";

// Path /v1/playlists/{playlist_id} with optional ?fields= projection.
// Verified: 2026-05-08 against https://developer.spotify.com/documentation/web-api/reference/get-playlist
const SPOTIFY_PLAYLIST_URL = "https://api.spotify.com/v1/playlists/";

interface PlaylistNameResponse {
  name?: string;
}

// F-016-R4 + R7: fetch the Spotify playlist name. On non-OK response, throws
// an Error whose message includes the status. On empty/missing name, falls
// back to a deterministic synthetic ('Spotify Playlist {id}').
export async function fetchSpotifyPlaylistName(
  env: Env,
  spotifyPlaylistId: string,
): Promise<string> {
  const url = `${SPOTIFY_PLAYLIST_URL}${spotifyPlaylistId}?fields=name`;
  const response = await spotifyFetch(env, url);

  if (!response.ok) {
    throw new Error(
      `Spotify playlist name fetch failed: ${response.status} for ${spotifyPlaylistId}`,
    );
  }

  const data = (await response.json()) as PlaylistNameResponse;
  const name = data.name;
  if (typeof name !== "string" || name.length === 0) {
    return `Spotify Playlist ${spotifyPlaylistId}`;
  }
  return name;
}
