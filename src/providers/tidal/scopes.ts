// Verified: 2026-05-02 against developer.tidal.com → portage app → Scopes
// (canonical scope vocabulary; only playlists.read + playlists.write enabled
// on the portage app) and against the OAS at
// https://tidal-music.github.io/tidal-api-reference/tidal-api-oas.json.
//
// Code-touched Tidal endpoints and their scope requirements:
//   GET  /v2/tracks?filter[isrc]      — no specific scope (any valid token)
//   GET  /v2/tracks/{id}              — no specific scope
//   GET  /v2/searchResults            — no specific scope (search.read is for
//                                       PERSONALIZED results; we hit catalog).
//                                       Collection + filter[query]; the
//                                       /searchResults/{id} singleton was
//                                       removed upstream ~2026-08-11.
//   POST /v2/playlists                — playlists.write
//   GET  /v2/playlists/{id}           — playlists.read
//   GET  .../relationships/items      — playlists.read
//   POST .../relationships/items      — playlists.write
export const TIDAL_SCOPES = [
  "playlists.read",
  "playlists.write",
].join(" ");
