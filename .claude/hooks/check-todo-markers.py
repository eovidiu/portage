#!/usr/bin/env python3
# Stage 5 TODO-marker gate.
#
# Mechanically enforces the "audit-marker discipline" anti-pattern that hit
# Sprint 4 (TODO(ovidiu) markers asymmetric across parallel teammates: F-007 had
# the marker, F-006 + F-008 didn't). Same family of issue as Sprint 3's
# coverage-claim recurrence and Sprint 4's schema-drift recurrence.
#
# Detection scope:
#   Top-level constants in src/ assigned a string literal containing one of the
#   external-API URL prefixes that need Ovidiu's verification.
#
# Required: each such constant must have a `TODO(ovidiu)` comment on the
# immediately preceding non-blank source line (single-line // or end of /* */).
#
# Skipped (avoid false positives):
#   - URLs inside function bodies / template literals (those are usage, not specs)
#   - Comments / docstrings that mention the URL
#   - Test files (tests/, *.test.ts, *.spec.ts)
#
# Exit 0 = clean, exit 1 = drift detected (one issue per line on stdout).

import re
import sys
import pathlib

PROJECT_ROOT = pathlib.Path(__file__).resolve().parents[2]
SRC_DIR = PROJECT_ROOT / "src"

URL_PATTERNS = [
    "openapi.tidal.com",
    "api.spotify.com",
]

# Match TOP-LEVEL `const NAME = "url..."` (or with `export`).
# Stops at line break — we don't pick up template literals or multi-line strings.
CONSTANT_RE = re.compile(
    r'^(?:export\s+)?const\s+([A-Z_][A-Z0-9_]*)\s*[:=]'
    r'[^\n]*?["\'`]([^"\'`\n]*(?:openapi\.tidal\.com|api\.spotify\.com)[^"\'`\n]*)["\'`]',
    re.MULTILINE,
)

TODO_MARKER_RE = re.compile(r'TODO\(ovidiu\)', re.IGNORECASE)


def find_constants(content: str) -> list[tuple[int, str, str]]:
    """Return [(line_number, const_name, url)] for matching top-level constants."""
    out = []
    for m in CONSTANT_RE.finditer(content):
        line_no = content[: m.start()].count("\n") + 1
        out.append((line_no, m.group(1), m.group(2)))
    return out


def has_todo_above(lines: list[str], const_line_idx: int) -> bool:
    """Walk upward from `const_line_idx - 1` skipping blank lines.
    Return True if the first non-blank line has a TODO(ovidiu) marker.
    """
    i = const_line_idx - 1
    while i >= 0:
        s = lines[i].strip()
        if s == "":
            i -= 1
            continue
        return bool(TODO_MARKER_RE.search(s))
    return False


def main() -> int:
    if not SRC_DIR.exists():
        return 0
    issues = []
    for path in SRC_DIR.rglob("*.ts"):
        # Skip test files (defensive — src/ shouldn't have them, but just in case)
        name = path.name
        if name.endswith(".test.ts") or name.endswith(".spec.ts"):
            continue
        try:
            content = path.read_text()
        except Exception:
            continue
        rel = path.relative_to(PROJECT_ROOT)
        lines = content.split("\n")
        for line_no, const_name, url in find_constants(content):
            if not has_todo_above(lines, line_no - 1):
                issues.append(
                    f"{rel}:{line_no}: const {const_name} (url contains "
                    f"{[p for p in URL_PATTERNS if p in url][0]}) "
                    f"missing TODO(ovidiu) marker on the preceding line"
                )
    if issues:
        for i in sorted(set(issues)):
            print(i)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
