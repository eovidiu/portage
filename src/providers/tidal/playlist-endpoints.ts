// Tidal Open API v2 playlist endpoints
// Batch size sourced from Tidal API docs: max 100 items per add-tracks request.
export const BATCH_SIZE = 100;

export const TIDAL_PLAYLISTS_URL = "https://openapi.tidal.com/v2/playlists";

export function playlistUrl(playlistId: string): string {
  return `${TIDAL_PLAYLISTS_URL}/${playlistId}`;
}

export function playlistTracksUrl(playlistId: string): string {
  return `${TIDAL_PLAYLISTS_URL}/${playlistId}/relationships/items`;
}
