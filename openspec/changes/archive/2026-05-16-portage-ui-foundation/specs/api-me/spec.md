## ADDED Requirements

### Requirement: Return the authenticated principal

The Worker SHALL expose `GET /api/me` returning a JSON body
`{ email: string, kind: "user" | "service" }` derived from
`c.var.principal`. The endpoint requires authentication.

#### Scenario: Authenticated browser user
- **WHEN** an authenticated request reaches `GET /api/me` via Cloudflare
  Access (`c.var.principal.kind === "user"`)
- **THEN** the response is `200 OK` with body
  `{ "email": "eovidiu@gmail.com", "kind": "user" }`

#### Scenario: Service caller (Bearer JWT)
- **WHEN** an authenticated request reaches `GET /api/me` with a valid
  Bearer JWT and a CF Access service-token bypass
  (`c.var.principal.kind === "service"`)
- **THEN** the response is `200 OK` with body `{ "kind": "service" }` and
  no `email` field

#### Scenario: Unauthenticated request
- **WHEN** an unauthenticated request reaches `GET /api/me`
- **THEN** the response is `401 Unauthorized` and the principal is not
  enumerated in the body
