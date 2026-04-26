#!/usr/bin/env python3
# Stage 4 schema-drift gate.
#
# Scans src/ for SQL strings and verifies every column reference appears in db/schema.sql.
# Driven by Sprint 1/3/4 misses (status, idx_tracks_added_at, tidal_id_invalid) where
# a column was queried in code but absent from db/schema.sql + production Neon.
#
# Detection scope:
#   - INSERT INTO <table> (<col1>, <col2>, ...)
#   - UPDATE <table> SET <col>=...
#   - WHERE/AND/OR <col> [=<>!]
#
# Skipped (avoid false positives):
#   - SELECT lists (function calls like pg_try_advisory_lock, count(*), etc.)
#   - JOIN ON (rare in this codebase; revisit if needed)
#
# Exit 0 = clean, exit 1 = drift detected (one issue per line on stdout).

import re
import sys
import pathlib

SQL_KEYWORDS = {
    "select", "from", "where", "and", "or", "not", "in", "is", "null", "true", "false",
    "insert", "into", "values", "update", "set", "delete", "returning", "join",
    "inner", "outer", "left", "right", "on", "as", "asc", "desc", "order", "by",
    "group", "having", "limit", "offset", "union", "all", "exists", "case",
    "when", "then", "else", "end", "default", "primary", "key", "foreign",
    "references", "constraint", "create", "table", "index", "if", "column",
    "alter", "add", "drop", "count", "max", "min", "sum", "avg", "distinct",
    "now", "gen_random_uuid", "coalesce", "nullif", "interval", "date",
    "timestamp", "timestamptz", "text", "int", "integer", "numeric", "boolean",
    "uuid", "bytea", "jsonb", "json", "with", "do", "nothing", "conflict",
    "between", "like", "ilike", "extract", "epoch", "current_timestamp",
}

PROJECT_ROOT = pathlib.Path(__file__).resolve().parents[2]
SCHEMA_PATH = PROJECT_ROOT / "db" / "schema.sql"
SRC_DIR = PROJECT_ROOT / "src"


def schema_columns() -> set[str]:
    if not SCHEMA_PATH.exists():
        return set()
    text = SCHEMA_PATH.read_text()
    cols = set()
    # Columns from CREATE TABLE bodies
    for m in re.finditer(
        r"CREATE TABLE (?:IF NOT EXISTS )?\w+\s*\((.*?)\);",
        text,
        re.DOTALL | re.IGNORECASE,
    ):
        body = m.group(1)
        for raw in re.split(r",(?![^()]*\))\s*\n", body):
            line = raw.strip()
            if not line:
                continue
            if re.match(
                r"(PRIMARY|FOREIGN|UNIQUE|CONSTRAINT|CHECK)\s",
                line,
                re.IGNORECASE,
            ):
                continue
            tok = re.match(r"(\w+)", line)
            if tok:
                cols.add(tok.group(1).lower())
    # Columns from ALTER TABLE ... ADD COLUMN
    for m in re.finditer(
        r"ADD COLUMN (?:IF NOT EXISTS )?(\w+)",
        text,
        re.IGNORECASE,
    ):
        cols.add(m.group(1).lower())
    return cols


def extract_sql_strings(content: str) -> list[str]:
    out = []
    # Backtick template literals (template substitutions ${...} are placeholders for params,
    # so they don't introduce column-shaped tokens we'd care about — leaving them in is safe).
    out += re.findall(
        r"`([^`]*?(?:SELECT|INSERT|UPDATE|DELETE)[^`]*?)`",
        content,
        re.IGNORECASE | re.DOTALL,
    )
    # Single-quoted strings
    out += re.findall(
        r"'([^']*?(?:SELECT|INSERT|UPDATE|DELETE)[^']*?)'",
        content,
        re.IGNORECASE,
    )
    # Double-quoted
    out += re.findall(
        r'"([^"]*?(?:SELECT|INSERT|UPDATE|DELETE)[^"]*?)"',
        content,
        re.IGNORECASE,
    )
    return out


def check_sql(sql: str, allowed: set[str], path: str) -> list[str]:
    issues = []
    # INSERT INTO <table> ( ... )
    for ins in re.finditer(r"INSERT INTO \w+\s*\(([^)]+)\)", sql, re.IGNORECASE):
        for tok in re.findall(r"\b([a-z_][a-z0-9_]+)\b", ins.group(1)):
            if tok in SQL_KEYWORDS or tok in allowed:
                continue
            issues.append(f"{path}: INSERT references '{tok}' not in db/schema.sql")
    # UPDATE ... SET col=...
    for upd in re.finditer(
        r"UPDATE \w+ SET\s+(.*?)(?:WHERE|RETURNING|$)",
        sql,
        re.IGNORECASE | re.DOTALL,
    ):
        for assign in re.split(r",\s*", upd.group(1)):
            m = re.match(r"\s*(\w+)\s*=", assign)
            if not m:
                continue
            tok = m.group(1).lower()
            if tok in SQL_KEYWORDS or tok in allowed:
                continue
            issues.append(f"{path}: UPDATE SET references '{tok}' not in db/schema.sql")
    # WHERE / AND / OR <col> [op]
    for wh in re.finditer(
        r"(?:WHERE|AND|OR)\s+(\w+)\s*[=<>!]",
        sql,
        re.IGNORECASE,
    ):
        tok = wh.group(1).lower()
        if tok in SQL_KEYWORDS or tok in allowed:
            continue
        issues.append(f"{path}: WHERE references '{tok}' not in db/schema.sql")
    return issues


def main() -> int:
    allowed = schema_columns()
    if not allowed:
        # No schema file → silent pass; this hook is opt-in via schema presence
        return 0
    issues = []
    for path in SRC_DIR.rglob("*.ts"):
        try:
            content = path.read_text()
        except Exception:
            continue
        rel = path.relative_to(PROJECT_ROOT)
        for sql in extract_sql_strings(content):
            issues.extend(check_sql(sql, allowed, str(rel)))
    if issues:
        for i in sorted(set(issues)):
            print(i)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
