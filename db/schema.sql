-- Source of truth for portage schema. Apply via Neon MCP or psql.
-- Last applied to project square-wave-04443485 on 2026-04-26 (added idx_tracks_added_at).
--
-- Invariants (application-layer enforcement — not DB CHECKs):
--   I-001: tracks.spotify_id MUST appear in exactly one of matches OR unmatched at any time,
--          never both, never neither (after at least one sync attempt).
--   I-002: matches.tidal_id MUST resolve to a real Tidal track at time of write.
--   I-003: provider_tokens rows MUST always contain non-null ciphertext; plaintext tokens
--          MUST NOT exist anywhere except volatile Worker memory during use.
--   I-004: sync_runs.status MUST be one of 'running','succeeded','failed','partial'.
--          Terminal states MUST have non-null finished_at.
--   I-005: The cursor (spotify_added_at high-water mark in sync_state) MUST be advanced
--          only after all tracks in a page are persisted (atomic with page persist).

-- Encrypted OAuth tokens. Plaintext MUST NOT be persisted (I-003).
-- Per F-004-R3: each ciphertext gets its own independent 96-bit IV (GCM nonce reuse
-- is structurally impossible with separate columns).
CREATE TABLE IF NOT EXISTS provider_tokens (
    provider                  TEXT PRIMARY KEY,
    access_token_ciphertext   BYTEA NOT NULL,
    refresh_token_ciphertext  BYTEA NOT NULL,
    access_token_iv           BYTEA NOT NULL,
    refresh_token_iv          BYTEA NOT NULL,
    status                    TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','revoked')),
    expires_at                TIMESTAMPTZ,
    updated_at                TIMESTAMPTZ DEFAULT now()
);

-- Spotify track catalogue cache. spotify_id is the stable PK.
CREATE TABLE IF NOT EXISTS tracks (
    spotify_id      TEXT PRIMARY KEY,
    isrc            TEXT,
    artist          TEXT NOT NULL,
    title           TEXT NOT NULL,
    album           TEXT,
    duration_ms     INT,
    spotify_added_at TIMESTAMPTZ NOT NULL,
    first_seen_at   TIMESTAMPTZ DEFAULT now()
);

-- One row per sync engine execution.
-- status CHECK enforces I-004 at the DB layer as well.
CREATE TABLE IF NOT EXISTS sync_runs (
    run_id        UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    started_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
    finished_at   TIMESTAMPTZ,
    status        TEXT NOT NULL CHECK (status IN ('running','succeeded','partial','failed')),
    error_code    TEXT,
    tracks_seen   INT DEFAULT 0,
    matched_isrc  INT DEFAULT 0,
    matched_fuzzy INT DEFAULT 0,
    unmatched     INT DEFAULT 0,
    errors        INT DEFAULT 0
);
-- Added by F-009: error_code captures the terminal failure reason (e.g. 'spotify_reauth_required').
ALTER TABLE sync_runs ADD COLUMN IF NOT EXISTS error_code TEXT;

-- Added by F-009 amendment 2026-05-03 (R12-R14): per-track error_details for partial-run diagnosis.
-- Shape: [{spotify_id, error_code, message}, ...]. NULL for runs with errors=0.
ALTER TABLE sync_runs ADD COLUMN IF NOT EXISTS error_details JSONB DEFAULT NULL;

-- Confirmed Spotify→Tidal pairings.
-- A spotify_id present here MUST NOT appear in unmatched (I-001).
CREATE TABLE IF NOT EXISTS matches (
    spotify_id       TEXT PRIMARY KEY REFERENCES tracks(spotify_id),
    tidal_id         TEXT NOT NULL,
    method           TEXT NOT NULL CHECK (method IN ('isrc','fuzzy','manual')),
    confidence       NUMERIC(3,2),
    matched_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
    sync_run_id      UUID REFERENCES sync_runs(run_id),
    tidal_id_invalid BOOLEAN NOT NULL DEFAULT false
);
-- Added by F-008: marks rows where the Tidal track no longer exists in catalog.
ALTER TABLE matches ADD COLUMN IF NOT EXISTS tidal_id_invalid BOOLEAN NOT NULL DEFAULT false;

-- Tracks that could not be matched; pending manual review or retry.
-- A spotify_id present here MUST NOT appear in matches (I-001).
CREATE TABLE IF NOT EXISTS unmatched (
    spotify_id      TEXT PRIMARY KEY REFERENCES tracks(spotify_id),
    reason          TEXT NOT NULL,
    attempts        INT NOT NULL DEFAULT 0,
    last_attempt_at TIMESTAMPTZ,
    status          TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','matched','skipped')),
    -- F-027: the run during which this row was (re-)written. NULL means
    -- the row predates the F-027 schema add — those rows aren't part of
    -- any specific run's manifest. The orchestrator passes the current
    -- runId on every upsert from F-027 onward.
    sync_run_id     UUID REFERENCES sync_runs(run_id),
    -- F-027a: top 3 ranked Tidal candidates persisted at the moment of
    -- fuzzy rejection so the operator can pick one from the run-detail
    -- page later. Shape: [{tidal_id, title, artist, album, score}, …].
    -- NULL for non-fuzzy_below_threshold reasons + pre-existing rows.
    candidates      JSONB
);
CREATE INDEX IF NOT EXISTS idx_unmatched_sync_run_id ON unmatched(sync_run_id);

-- Key/value store for sync cursor and other runtime state.
-- The 'cursor' key holds the spotify_added_at high-water mark (I-005).
CREATE TABLE IF NOT EXISTS sync_state (
    key        TEXT PRIMARY KEY,
    value      TEXT NOT NULL,
    updated_at TIMESTAMPTZ DEFAULT now()
);

-- OAuth PKCE state store. Rows are short-lived (TTL enforced by expires_at).
-- consumeOAuthState deletes atomically; purgeExpiredOAuthState cleans up strays.
CREATE TABLE IF NOT EXISTS oauth_state (
    state         TEXT PRIMARY KEY,
    code_verifier TEXT NOT NULL,
    expires_at    TIMESTAMPTZ NOT NULL,
    created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- F-016: playlist config registry. One row per Spotify playlist this deployment
-- syncs into Tidal: the synthetic '__liked__' row for Liked Songs, plus extras
-- declared via env.SPOTIFY_EXTRA_PLAYLIST_IDS. tidal_playlist_id is NULL until
-- the Tidal counterpart is created (F-018 owns the create-on-first-sync flow).
CREATE TABLE IF NOT EXISTS playlist_configs (
    spotify_playlist_id   TEXT PRIMARY KEY,
    spotify_name          TEXT NOT NULL,
    tidal_playlist_id     TEXT,
    created_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
    last_synced_at        TIMESTAMPTZ,
    enabled               BOOLEAN NOT NULL DEFAULT TRUE
);
-- Added by F-026a (2026-05-17): per-playlist sync pause without removing the row.
-- DEFAULT TRUE means existing rows take TRUE without a separate backfill UPDATE.
-- The orchestrator's iteration query filters WHERE enabled = TRUE (F-026b); the
-- GET /api/playlists handler returns ALL rows including disabled ones so the
-- operator can see and re-enable them.
ALTER TABLE playlist_configs ADD COLUMN IF NOT EXISTS enabled BOOLEAN NOT NULL DEFAULT TRUE;

-- F-016-R2: synthetic '__liked__' row is the stable key for Liked Songs.
-- Idempotent — repeat schema applies leave the row unchanged.
INSERT INTO playlist_configs (spotify_playlist_id, spotify_name)
VALUES ('__liked__', 'Spotify Liked')
ON CONFLICT (spotify_playlist_id) DO NOTHING;

-- F-017: per-playlist track membership. Records which Spotify tracks belong
-- to which Spotify playlists, and whether the corresponding Tidal counterpart
-- has been written to the Tidal side yet. synced_at IS NULL means "in Spotify
-- playlist, not yet written to Tidal". F-018's write pass is the only path
-- that flips synced_at to a timestamp.
CREATE TABLE IF NOT EXISTS playlist_membership (
    spotify_playlist_id   TEXT NOT NULL REFERENCES playlist_configs(spotify_playlist_id),
    spotify_track_id      TEXT NOT NULL REFERENCES tracks(spotify_id),
    added_at              TIMESTAMPTZ NOT NULL,
    synced_at             TIMESTAMPTZ,
    PRIMARY KEY (spotify_playlist_id, spotify_track_id)
);

-- F-017-R6: partial index used by F-018's selectUnsyncedMatchesForPlaylist.
CREATE INDEX IF NOT EXISTS idx_membership_unsynced
    ON playlist_membership (spotify_playlist_id, synced_at)
    WHERE synced_at IS NULL;

-- F-017: covers the FK lookups when a track lifecycle event needs to enumerate
-- every playlist it belongs to (future use).
CREATE INDEX IF NOT EXISTS idx_membership_track
    ON playlist_membership (spotify_track_id);

-- Indexes
CREATE INDEX IF NOT EXISTS idx_oauth_state_expires_at ON oauth_state(expires_at);
CREATE INDEX IF NOT EXISTS idx_tracks_isrc          ON tracks(isrc) WHERE isrc IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_tracks_added_at      ON tracks(spotify_added_at DESC);
CREATE INDEX IF NOT EXISTS idx_sync_runs_started_at ON sync_runs(started_at DESC);
CREATE INDEX IF NOT EXISTS idx_matches_sync_run_id  ON matches(sync_run_id);
CREATE INDEX IF NOT EXISTS idx_matches_tidal        ON matches(tidal_id);
CREATE INDEX IF NOT EXISTS idx_unmatched_status     ON unmatched(status, attempts);
