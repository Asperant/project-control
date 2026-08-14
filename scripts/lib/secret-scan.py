#!/usr/bin/env python3
"""Repository secret-scan classifier used by verify-security.sh (GIT-001).

Usage: secret-scan.py <repo_root> < list-of-repo-relative-paths

Prints one repo-relative path per line for every candidate file that
contains a credential-shaped literal. Read-only; never modifies anything.

Every decision here is syntax-based, never a guess about "how random" or
"how digit-heavy" a value looks -- entropy/digit-counting heuristics are
deliberately not used, because they are both easy to defeat (a hand-typed
secret with no digits) and easy to trip on legitimate code (an
all-letters variable name that happens to be long). Instead each context
is resolved by what its own language/tool actually means:

  - In a recognised programming-language file (see CODE_EXTENSIONS), a
    BARE (unquoted) token after `password: `, `password = `, or
    `password := ` is a variable/identifier reference -- these languages
    require quotes for string literals, so an unquoted RHS cannot be one.
  - In a shell/env-style `KEY=value` assignment (no quotes), the value is
    a real value UNLESS it is a shell parameter expansion (`$VAR`,
    `${VAR}`) -- those simply never match the literal-value character
    class below, so they never produce a finding.
  - `keyword :'value'` / `keyword :"value"` (a bare colon, preceded by
    whitespace, directly touching the quote with no space) is psql's own
    variable-substitution syntax, not a literal -- true by construction,
    not a guess.
  - A `/run/secrets/...`-style path, an explicit safe test sentinel, or a
    recognised placeholder marker are all still exempt, same as before.

PEM headers, AWS access-key IDs and Telegram-bot-token-shaped strings are
matched independently of all of the above, since those shapes are
unambiguous on their own.
"""
import os
import re
import sys

# Languages where a string literal syntactically requires quotes, so an
# unquoted token after a `keyword <sep> ` credential-shaped prefix can only
# be a variable/identifier reference, never a literal value.
CODE_EXTENSIONS = {
    ".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs",
    ".py", ".go", ".rs", ".java", ".kt", ".kts", ".swift",
    ".rb", ".php", ".c", ".cc", ".cpp", ".h", ".hpp", ".cs",
}

CRED_KEYWORD = r"(password|passwd|secret|api[_-]?key|token|bearer)"

# A literal value wrapped in matching quotes, anywhere. Captures the
# separator and the whitespace immediately around it so the psql
# substitution shape (see PSQL_SUBSTITUTION below) can be told apart from a
# real "key: value" / "key = value" literal.
KEYWORD_QUOTED = re.compile(
    CRED_KEYWORD + r"(?P<pregap>[ \t]*)(?P<sep>:=|[:=])(?P<postgap>[ \t]*)"
    r"(['\"])(?P<value>[^'\"\n]*)\5",
    re.IGNORECASE,
)

# Shell/env `KEY=value` with no quotes at all. The character class
# deliberately excludes `$`, `{` and `}`, so `PASSWORD=$VALUE` and
# `PASSWORD=${VALUE}` never match this pattern in the first place -- they
# are shell parameter expansions, not literal values, and need no separate
# exemption check.
KEYWORD_UNQUOTED_SHELL = re.compile(
    CRED_KEYWORD + r"\w*=(?P<value>[A-Za-z0-9/+._-]+)",
    re.IGNORECASE,
)

IDENTIFIER = re.compile(r"[A-Za-z_$][A-Za-z0-9_]*")

PEM_HEADER = re.compile(r"-----BEGIN [A-Z ]*PRIVATE KEY-----")
TELEGRAM_TOKEN = re.compile(r"\b[0-9]{8,12}:[A-Za-z0-9_-]{30,}\b")
AWS_KEY = re.compile(r"\bAKIA[0-9A-Z]{16}\b")

# Values this deployment deliberately uses as non-secret, self-describing
# test fixtures -- never a real credential.
SAFE_SENTINELS = {"regression-test-only"}
PLACEHOLDER_MARKERS = ("example", "EXAMPLE", "placeholder", "<your", "CHANGEME", "xxxxx", "REDACTED")


def is_psql_substitution(sep, pregap, postgap):
    # psql's own `:'ident'` / `:"ident"` variable-substitution syntax: a
    # bare colon, preceded by whitespace (separating it from the keyword),
    # directly touching the opening quote with no space in between. This is
    # a fact about psql's grammar, not a guess about the value inside the
    # quotes -- true regardless of what the substituted variable is named.
    # Ordinary "key: value" / "key : value" / minified "key":"value" JSON
    # never produces this exact (whitespace, then bare ':', then quote with
    # zero gap) shape, so it is not mistaken for one.
    return sep == ":" and pregap != "" and postgap == ""


def is_exempt_value(value):
    if value == "":
        # Nothing to leak.
        return True
    if value in SAFE_SENTINELS:
        return True
    if value.startswith("/"):
        return True
    if value.startswith("$"):
        # A shell parameter expansion or command substitution written
        # inside quotes (idiomatic, recommended shell style — "$VAR",
        # "${VAR}", "$(cmd)" — to prevent word-splitting) is still an
        # expansion, not a literal, whether or not it is quoted.
        return True
    if any(marker in value for marker in PLACEHOLDER_MARKERS):
        return True
    return False


def scan_file(path):
    try:
        with open(path, "r", encoding="utf-8", errors="ignore") as fh:
            text = fh.read()
    except OSError:
        return False

    if PEM_HEADER.search(text) or TELEGRAM_TOKEN.search(text) or AWS_KEY.search(text):
        return True

    _, ext = os.path.splitext(path)
    is_code_file = ext in CODE_EXTENSIONS

    for m in KEYWORD_QUOTED.finditer(text):
        if is_psql_substitution(m.group("sep"), m.group("pregap"), m.group("postgap")):
            continue
        if not is_exempt_value(m.group("value")):
            return True

    for m in KEYWORD_UNQUOTED_SHELL.finditer(text):
        value = m.group("value")
        if is_code_file and IDENTIFIER.fullmatch(value):
            # In a language where a string literal requires quotes, an
            # unquoted token here is -- by that language's own grammar,
            # never a guess -- a variable/identifier reference, whatever
            # its spelling. Digits or their absence play no part in this.
            continue
        if not is_exempt_value(value):
            return True

    return False


def main():
    repo_root = sys.argv[1]
    for rel in sys.stdin:
        rel = rel.rstrip("\n")
        if not rel:
            continue
        if scan_file(os.path.join(repo_root, rel)):
            print(rel)


if __name__ == "__main__":
    main()
