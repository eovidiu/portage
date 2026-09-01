// Tidal Open API v2 playlist endpoints.
//
// OAS source:
//   https://tidal-music.github.io/tidal-api-reference/tidal-api-oas.json
//
// Per the schema PlaylistsItemsRelationshipAddOperation_Payload the `data`
// array is capped by `maxItems`. That cap was 20 when this was written and is
// 50 as of OAS 1.10.115 (re-verified 2026-09-01); BATCH_SIZE must stay <= it.
// We deliberately do NOT track the cap upward: each batch is one subrequest and
// a Workers free-tier invocation gets 50 in total, shared with the match stage.
// The original value of 100 was fabricated and failed validation outright.
export const BATCH_SIZE = 20;

// Per Playlists_Attributes the access enum is [PUBLIC, UNLISTED] only —
// there is no PRIVATE value. F-008-R3 specifies UNLISTED (closest non-public
// option: not surfaced in browse/search, accessible only via direct id /
// share link).
export const PLAYLIST_ACCESS_TYPE = "UNLISTED";

// Verified: 2026-04-27 against https://tidal-music.github.io/tidal-api-reference/tidal-api-oas.json (path /v2/playlists POST + /v2/playlists/{id} GET; attributes.name required; accessType enum [PUBLIC, UNLISTED]; add-tracks data maxItems=20 + meta.positionBefore required).
export const TIDAL_PLAYLISTS_URL = "https://openapi.tidal.com/v2/playlists";

export function playlistUrl(playlistId: string): string {
  return `${TIDAL_PLAYLISTS_URL}/${encodeURIComponent(playlistId)}`;
}

export function playlistTracksUrl(playlistId: string): string {
  return `${TIDAL_PLAYLISTS_URL}/${encodeURIComponent(playlistId)}/relationships/items`;
}

// Verified: 2026-07-21 against tidal-api-oas.json path /tracks GET —
// `filter[id]` is `array(string)`, no documented style/explode override, so
// the OpenAPI default (form, explode=true) applies: repeated `filter[id]=`
// query params, not a comma-joined list.
export const TIDAL_TRACKS_URL = "https://openapi.tidal.com/v2/tracks";
