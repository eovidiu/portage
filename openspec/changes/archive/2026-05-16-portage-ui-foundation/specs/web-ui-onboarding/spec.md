## ADDED Requirements

### Requirement: Connect page surfaces provider OAuth status

The SPA SHALL render a `/connect` route showing one card per provider
(Spotify, Tidal) and a row of health pills for the Worker, Spotify token
state, Tidal token state, and Neon Postgres reachability. The page sources
its data from `GET /readyz` and `GET /api/me`.

#### Scenario: Both providers connected
- **WHEN** `/readyz` reports `spotify: "ok"`, `tidal: "ok"`, `database:
  "ok"`
- **THEN** both provider cards display a green checkmark and the four
  health pills are green

#### Scenario: Spotify token missing
- **WHEN** `/readyz` reports `spotify: "missing_token"`
- **THEN** the Spotify card displays a "Connect Spotify" button whose
  `href` is `https://portage.eovidiu.co.uk/auth/spotify/start` and the
  Spotify health pill is red with the label "Spotify: not connected"

#### Scenario: Database unreachable
- **WHEN** `/readyz` reports `database: "down"`
- **THEN** the Neon health pill is red with the label "Database: down" and
  an alert banner at the top of the page advises the operator to check
  Neon status

### Requirement: OAuth deep links use top-level navigation

Every "Connect" button on the page SHALL navigate the top-level browser
context (not an iframe or a popup) to the Worker's OAuth start URL. The
button MUST use a real `<a target="_top">` element, not JavaScript-driven
`window.open`, to preserve cookie flow.

#### Scenario: Connect button click
- **WHEN** the operator clicks the "Connect Spotify" button
- **THEN** the browser navigates the top-level frame to
  `https://portage.eovidiu.co.uk/auth/spotify/start`
