# T-007: Fuzzy matching tests

Covers F-007.

---

## T-007-01: Identical metadata scores 1.0

**Type**: metric

**Setup**: Spotify track `{title: "Yesterday", artist: "The Beatles", album: "Help!", duration_ms: 125000}`. Tidal candidate with identical fields.

**Action**: Compute score via the matcher's scoring function (unit test, no API).

**Measurement**: Returned score, in [0, 1].

**Pass**: metric value MUST be ≥ 0.99.

---

## T-007-02: Completely different track scores below threshold

**Type**: metric

**Setup**: Spotify `{title: "Yesterday", artist: "The Beatles", album: "Help!", duration_ms: 125000}`. Tidal candidate `{title: "Yesterday", artist: "Atmosphere", album: "Seven's Travels", duration_ms: 240000}`.

**Action**: Compute score.

**Measurement**: Returned score.

**Pass**: metric value MUST be < 0.85.

---

## T-007-03: Remastered title normalised to base

**Type**: metric

**Setup**: Spotify `{title: "Bohemian Rhapsody", album: "A Night at the Opera"}`. Tidal `{title: "Bohemian Rhapsody (2011 Remaster)", album: "A Night at the Opera (Deluxe Remastered Version)"}`. Artists and durations match exactly.

**Action**: Compute score.

**Measurement**: Returned score.

**Pass**: metric value MUST be ≥ 0.85.

---

## T-007-04: "feat." stripped from title for matching

**Type**: metric

**Setup**: Spotify title `"Get Lucky"`. Tidal title `"Get Lucky (feat. Pharrell Williams and Nile Rodgers)"`. Other fields agree.

**Action**: Compute score.

**Measurement**: Returned score.

**Pass**: metric value MUST be ≥ 0.85.

---

## T-007-05: Match accepted writes matches row

**Type**: assertion

**Setup**: Tracks row with title/artist that yields a top score of 0.92 against a mocked Tidal search. Empty `matches` table.

**Action**: Run the matcher.

**Assertion**: One `matches` row exists with `method = 'fuzzy'`, `confidence = 0.92`, `tidal_id` equal to the top candidate id.

**Pass**: TRUE if all conditions hold.

---

## T-007-06: Below-threshold result enqueues unmatched

**Type**: assertion

**Setup**: Tracks row whose top fuzzy score is 0.70 against the mock. Empty `unmatched` table.

**Action**: Run the matcher.

**Assertion**: One `unmatched` row for that spotify_id with `reason = 'fuzzy_below_threshold'`, `attempts = 1`, `status = 'pending'`. Zero `matches` rows for that spotify_id.

**Pass**: TRUE if all hold.

---

## T-007-07: No candidates enqueues unmatched with correct reason

**Type**: assertion

**Setup**: Mock returns empty array.

**Action**: Run the matcher.

**Assertion**: One `unmatched` row with `reason = 'no_candidates'`.

**Pass**: TRUE if equal.

---

## T-007-08: Repeated unmatched increments attempts

**Type**: assertion

**Setup**: Existing `unmatched` row for spotify_id `X` with `attempts = 2`. Mock returns no candidates again.

**Action**: Run the matcher.

**Assertion**: The `unmatched` row for `X` has `attempts = 3` AND `status = 'pending'`.

**Pass**: TRUE if both hold.

---

## T-007-09: Tie broken by smaller duration delta

**Type**: assertion

**Setup**: Two candidates with identical title/artist/album normalisation but durations 220000 ms and 225000 ms; Spotify duration is 222000. Engineered so weighted scores tie within 0.001 except duration.

**Action**: Compute the chosen candidate.

**Assertion**: Selected candidate has `duration_ms = 220000` (delta 2000) over `225000` (delta 3000).

**Pass**: TRUE if equal.

---

## T-007-10: Score weights sum correctly

**Type**: metric

**Setup**: Synthetic candidate where individual component scores are: title 1.0, artist 1.0, duration 0.5, album 0.0.

**Action**: Compute final score.

**Measurement**: Returned score (expected 0.40 + 0.30 + 0.10 + 0 = 0.80).

**Pass**: metric value MUST equal 0.80 ± 0.001.

---

## T-007-11: Duration score is zero beyond 5000 ms delta

**Type**: metric

**Setup**: Spotify duration 200000 ms; candidate duration 210000 ms (delta 10000).

**Action**: Compute the duration score component.

**Measurement**: Returned duration sub-score.

**Pass**: metric value MUST equal 0.0.

---

## T-007-12: One search per track per run

**Type**: metric

**Setup**: 30 tracks rows requiring fuzzy matching. Instrument Tidal search call count.

**Action**: Run the matcher.

**Measurement**: Total Tidal search calls (across all tracks).

**Pass**: metric value MUST equal 30.

---

## T-007-13: Per-decision log line emitted

**Type**: metric

**Setup**: 5 tracks rows; mocked candidates produce mixed accept/reject. Capture log output.

**Action**: Run the matcher.

**Measurement**: Number of log lines with `event == 'fuzzy_decision'`.

**Pass**: metric value MUST equal 5.

---

## T-007-14: Determinism

**Type**: assertion

**Setup**: One tracks row; one set of candidates returned by the mock.

**Action**: Compute the score 10 times in a row using the same inputs.

**Assertion**: All 10 returned scores are byte-identical.

**Pass**: TRUE if all 10 are identical.

---

## T-007-15: Curated-set precision at threshold 0.85

**Type**: metric

**Setup**: 20 hand-curated tracks with varied metadata (remasters, featurings, remixes). Run against live Tidal or recorded fixtures. Ground truth labels indicate the correct Tidal id for each.

**Action**: Run the matcher; compare each accepted match against ground truth.

**Measurement**: Precision = (correctly matched) / (total accepted), in [0, 1].

**Pass**: metric value MUST be ≥ 0.80.
