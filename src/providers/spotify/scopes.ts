// Verified: 2026-07-18 against developer.spotify.com Web API reference
// (Scopes concepts page + Create Playlist / Add Items to Playlist / Get
// Current User's Playlists reference pages — full citations in the F-030
// grounding notes).
//
// Code-touched Spotify endpoints and their scope requirements:
//   GET  /v1/me/tracks                — user-library-read
//   GET  /v1/me/playlists             — playlist-read-private
//   POST /v1/me/playlists             — playlist-modify-private (private dest)
//   POST /v1/playlists/{id}/items     — playlist-modify-private (private dest)
//   GET  /v1/search                   — no scope (valid token only)
export const SPOTIFY_SCOPES = [
  "user-library-read",
  "playlist-read-private",
  "playlist-modify-private",
].join(" ");
