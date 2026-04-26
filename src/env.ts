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
  /** Test-only: overrides the 300 s wall-time cap. Absent in production. */
  WALL_TIME_OVERRIDE_MS?: string;
}
