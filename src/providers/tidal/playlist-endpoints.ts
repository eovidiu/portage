// Tidal Open API v2 playlist endpoints
// Batch size sourced from Tidal API docs: max 100 items per add-tracks request.
export const BATCH_SIZE = 100;

// TODO(ovidiu): Verify URL template against Tidal Open API v2 docs.
export const TIDAL_PLAYLISTS_URL = "https://openapi.tidal.com/v2/playlists";

// TODO(ovidiu): Verify privacy value against Tidal Open API v2 docs — may be "PRIVATE" uppercase or use a "visibility" field.
export const PLAYLIST_PRIVACY = "private";

export function playlistUrl(playlistId: string): string {
  return `${TIDAL_PLAYLISTS_URL}/${playlistId}`;
}

export function playlistTracksUrl(playlistId: string): string {
  return `${TIDAL_PLAYLISTS_URL}/${playlistId}/relationships/items`;
}
