# T-006: ISRC matching tests

Covers F-006.

---

## T-006-01: Exact ISRC match with agreeing artist accepted

**Type**: assertion

**Setup**: Insert one `tracks` row with `isrc = 'GBUM71029604'`, `artist = 'Adele'`, `duration_ms = 220000`. Mock Tidal ISRC search to return one candidate with the same ISRC, `artists[0].name = 'Adele'`, `duration_ms = 220500`.

**Action**: Run the matcher.

**Assertion**: One row in `matches` exists for that spotify_id with `method = 'isrc'`, `confidence = 0.95`, and `tidal_id` equal to the candidate id.

**Pass**: TRUE if all conditions hold.

---

## T-006-02: ISRC match with disagreeing artist rejected

**Type**: assertion

**Setup**: Insert tracks row with `artist = 'Adele'`. Mock Tidal returns one candidate with `artists[0].name = 'Random Cover Band'`, ISRC matching.

**Action**: Run the matcher.

**Assertion**: Zero `matches` rows exist for that spotify_id (the track is passed to F-007).

**Pass**: TRUE if count == 0.

---

## T-006-03: ISRC missing skips the stage

**Type**: metric

**Setup**: Insert tracks row with `isrc IS NULL`. Instrument Tidal mock to count ISRC search calls.

**Action**: Run the matcher.

**Measurement**: Number of ISRC search calls observed for this track.

**Pass**: metric value MUST equal 0.

---

## T-006-04: Multiple results selected by closest duration

**Type**: assertion

**Setup**: Tracks row with `duration_ms = 220000`. Mock returns three candidates with durations 215000, 220300, 230000, all artists matching.

**Action**: Run the matcher.

**Assertion**: The chosen `matches.tidal_id` equals the candidate with `duration_ms = 220300`.

**Pass**: TRUE if equal.

---

## T-006-05: All candidates outside duration tolerance rejected

**Type**: assertion

**Setup**: Tracks row with `duration_ms = 200000`. Candidates: 195000 (delta 5000), 207000 (delta 7000) — both above the 2000 ms tolerance.

**Action**: Run the matcher.

**Assertion**: Zero `matches` rows for this spotify_id; the track falls through to F-007.

**Pass**: TRUE if count == 0.

---

## T-006-06: "feat." in artist normalised correctly

**Type**: assertion

**Setup**: Tracks row with `artist = 'Daft Punk feat. Pharrell Williams'`. Candidate `artists[0].name = 'Daft Punk'`.

**Action**: Run the matcher.

**Assertion**: A match is created with `method = 'isrc'`.

**Pass**: TRUE if match exists.

---

## T-006-07: Parenthetical content stripped from artist comparison

**Type**: assertion

**Setup**: Tracks row with `artist = 'The Rolling Stones (Live)'`. Candidate `artists[0].name = 'The Rolling Stones'`.

**Action**: Run the matcher.

**Assertion**: A match is created.

**Pass**: TRUE if match exists.

---

## T-006-08: One Tidal call per track in the ISRC stage

**Type**: metric

**Setup**: 50 `tracks` rows with valid ISRCs. Tidal mock returns one candidate per query. Instrument call count.

**Action**: Run the matcher.

**Measurement**: Total Tidal ISRC search calls.

**Pass**: metric value MUST equal 50.

---

## T-006-09: Tidal 401 triggers refresh and retry

**Type**: metric

**Setup**: One tracks row. Mock Tidal: ISRC search returns 401 once, 200 with valid candidate on retry. Instrument target endpoint.

**Action**: Run the matcher.

**Measurement**: Number of ISRC search calls (refresh excluded).

**Pass**: metric value MUST equal 2.

---

## T-006-10: Second 429 records error and falls through

**Type**: assertion

**Setup**: One tracks row with valid ISRC. Mock Tidal returns 429 twice in succession.

**Action**: Run the matcher.

**Assertion**: Zero `matches` rows for this track AND a per-track error is recorded in run statistics AND the track is passed to F-007.

**Pass**: TRUE if all hold.

---

## T-006-11: Confidence is exactly 0.95 on ISRC match

**Type**: assertion

**Setup**: Standard ISRC match scenario.

**Action**: Run the matcher.

**Assertion**: `matches.confidence` for the matched row equals 0.95.

**Pass**: TRUE if equal.

---

## T-006-12: countryCode parameter present on requests

**Type**: assertion

**Setup**: Configure `TIDAL_COUNTRY_CODE = 'RO'`. One tracks row. Spy on outbound Tidal HTTP.

**Action**: Run the matcher.

**Assertion**: Every Tidal request includes a `countryCode=RO` query parameter.

**Pass**: TRUE if every request matches.

---

## T-006-13: Curated set match rate

**Type**: metric

**Setup**: Insert 20 tracks rows with hand-curated ISRCs from mainstream releases (Adele, Daft Punk, Drake, etc.). Use the live Tidal API or a high-fidelity recorded fixture.

**Action**: Run the matcher.

**Measurement**: Number of tracks matched via the ISRC path.

**Pass**: metric value MUST be ≥ 18.

---

## T-006-14: Corrupted ISRC produces no false match

**Type**: assertion

**Setup**: Insert one tracks row with a synthetic ISRC `'XXXX99999999'` that no real release uses.

**Action**: Run the matcher against the live Tidal API or recorded fixture.

**Assertion**: Zero `matches` rows for that spotify_id.

**Pass**: TRUE if count == 0.

---

## T-006-15: ISRC normalised to uppercase (F-006-R12)

**Type**: assertion

**Setup**: A track with a lowercase ISRC (e.g., `'usx9p1417118'`).

**Action**: Run the matcher; capture the URL passed to `tidalFetch`.

**Assertion**: The captured URL contains `filter[isrc]=USX9P1417118` (URL-encoded
uppercase). The URL MUST NOT contain the lowercase form.

**Pass**: TRUE if both conditions hold.
