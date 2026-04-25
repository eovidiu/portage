// TODO(Ovidiu): Verify these scope strings against your Tidal Developer Portal app config.
// Source: https://developer.tidal.com/documentation/api/api-overview
// Suggested set covers catalog read, search, and user playlist read/write.
export const TIDAL_SCOPES = [
  "playlists.read",
  "playlists.write",
  "user.read",
  "collection.read",
  "collection.write",
  "search.read",
].join(" ");
