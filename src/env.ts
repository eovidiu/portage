export interface Env {
  DATABASE_URL: string;
  JWT_SECRET: string;
  TOKEN_ENCRYPTION_KEY: string;
  SPOTIFY_CLIENT_ID: string;
  SPOTIFY_CLIENT_SECRET: string;
  SPOTIFY_REDIRECT_URI: string;
  TIDAL_CLIENT_ID: string;
  TIDAL_CLIENT_SECRET: string;
  TIDAL_REDIRECT_URI: string;
  TIDAL_COUNTRY_CODE: string;
  TIDAL_PLAYLIST_TITLE: string;
  /** Operator email allowed past the Cloudflare Access JWT gate. Single-tenant. (F-019) */
  OPERATOR_EMAIL: string;
  /** UI origin allowed by the CORS middleware (e.g. https://app.portage.example.com). */
  UI_ORIGIN: string;
  /** Test-only: overrides the 300 s wall-time cap. Absent in production. */
  WALL_TIME_OVERRIDE_MS?: string;
  /** Per-invocation Spotify Liked Songs page budget. Defaults to 1. (F-015) */
  LIKED_PAGES_PER_RUN?: string;
  /** Per-invocation ISRC match queue size. Defaults to 5. (F-015) */
  MATCH_BATCH_ISRC?: string;
  /** Per-invocation fuzzy match queue size. Defaults to 5. (F-015) */
  MATCH_BATCH_FUZZY?: string;
  /** Comma-separated Spotify playlist IDs to sync beyond Liked Songs. (F-016) */
  SPOTIFY_EXTRA_PLAYLIST_IDS?: string;
  /** Maximum playlists processed per orchestrator invocation. Defaults to 3. (F-016) */
  MAX_PLAYLISTS_PER_RUN?: string;
  /** Cloudflare Access team name (e.g. "eovidiu" → eovidiu.cloudflareaccess.com). (F-019) */
  CF_ACCESS_TEAM?: string;
  /** Cloudflare Access Application Audience tag — `aud` claim on the Access JWT. (F-019) */
  CF_ACCESS_AUD?: string;
  /**
   * ntfy topic for sync-run push notifications. Worker secret — on the public
   * ntfy.sh server the topic name is the only access control. Notifications
   * are disabled entirely when unset. (F-029)
   */
  NTFY_TOPIC?: string;
  /** ntfy base URL for self-hosted instances. Defaults to https://ntfy.sh. (F-029) */
  NTFY_URL?: string;
  /** Optional ntfy access token, sent as `Authorization: Bearer`. Worker secret. (F-029) */
  NTFY_TOKEN?: string;
}
