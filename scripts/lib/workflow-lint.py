#!/usr/bin/env python3
"""Static linter for n8n workflow JSON files, used by verify-security.sh (N8N-002).

Usage: workflow-lint.py <manifest.json> <workflow.json> [<workflow.json> ...]

Exits 1 and prints every finding to stdout if any file fails; exits 0 with
no output if every file passes. Never touches n8n, never mints or reads a
credential -- purely a structural check against the JSON on disk.

A workflow file is trusted to run against a real automation account's
Bearer token, so this exists to keep the risky primitives (a webhook that
would give this deployment an inbound HTTP surface, an embedded credential,
a call to something other than this platform's own API, code-node
execution of an external process) out of what individual PRs can add
without that fact being visible in a diff or a `verify-security` run.
"""
import json
import os
import re
import sys

FORBIDDEN_NODE_TYPES = {
    "n8n-nodes-base.webhook",
    "n8n-nodes-base.respondToWebhook",
    "n8n-nodes-base.executeCommand",
    "n8n-nodes-base.ssh",
}

# HTTP Request nodes may only ever target this platform's own API. Anything
# else (including a literal IP, a public domain, or a different port) is
# rejected outright -- this workflow's whole reason to exist is to call
# Project Control, never a third party.
ALLOWED_HTTP_PREFIX = "http://control-api:8080/"

# $env access is whitelisted to exactly the one non-secret value the
# shipped example workflow already documents using this way.
ALLOWED_ENV_VARS = {"PC_TELEGRAM_CHAT_ID"}

TOKEN_PATTERN = re.compile(r"\bpcs_[A-Za-z0-9_-]{6,}")
ENV_PATTERN = re.compile(r"\$env(?:\.|\[[\"'])([A-Za-z0-9_]+)")


def find_strings(value, path="$"):
    """Yields (path, string) for every string leaf in a parsed JSON document."""
    if isinstance(value, str):
        yield path, value
    elif isinstance(value, dict):
        for key, sub in value.items():
            yield from find_strings(sub, f"{path}.{key}")
    elif isinstance(value, list):
        for index, sub in enumerate(value):
            yield from find_strings(sub, f"{path}[{index}]")


def lint_workflow(doc, filename, known_keys):
    findings = []

    # A workflow file with no top-level "id" fails `n8n import:workflow`
    # outright (verified against the pinned 2.34.0 image: it raises
    # `null value in column "id" of relation "workflow_entity" violates
    # not-null constraint` and imports nothing) — this is not a style
    # preference, it is the difference between install-workflows.sh working
    # at all and every import silently-per-file failing. The id must also be
    # STABLE across commits: `import:workflow` upserts by id (re-importing
    # the same id updates the same row, proven not to duplicate), but two
    # different ids sharing the same `name` DO create a genuine duplicate
    # (also proven) — so a regenerated id on every edit would eventually
    # leave old copies behind under the workflow's own display name.
    workflow_id = doc.get("id")
    if not isinstance(workflow_id, str) or not workflow_id.strip():
        findings.append(
            f"{filename}: missing a top-level \"id\" — n8n's import:workflow refuses a workflow with no id "
            "(NOT NULL constraint on workflow_entity.id); generate one once with `python3 -c \"import uuid; "
            "print(uuid.uuid4())\"` and commit it, never regenerate it on a later edit"
        )

    nodes = doc.get("nodes", [])
    if not isinstance(nodes, list) or not nodes:
        findings.append(f"{filename}: no nodes[] array")
        return findings

    for node in nodes:
        node_type = node.get("type", "")
        node_name = node.get("name", "<unnamed>")

        if node_type in FORBIDDEN_NODE_TYPES:
            findings.append(f"{filename}: node '{node_name}' has forbidden type {node_type}")

        if node_type == "n8n-nodes-base.httpRequest":
            url = node.get("parameters", {}).get("url", "")
            # url may carry a leading '=' marking it as an n8n expression;
            # the literal prefix still has to match once that is stripped.
            stripped = url[1:] if url.startswith("=") else url
            if not stripped.startswith(ALLOWED_HTTP_PREFIX):
                findings.append(
                    f"{filename}: node '{node_name}' targets '{url}', not {ALLOWED_HTTP_PREFIX}*"
                )

        if node_type == "n8n-nodes-base.code":
            code = node.get("parameters", {}).get("jsCode", "")
            if re.search(r"\brequire\s*\(", code):
                findings.append(f"{filename}: code node '{node_name}' calls require(...)")
            if "fetch(" in code or "http.request" in code or "child_process" in code:
                findings.append(
                    f"{filename}: code node '{node_name}' appears to perform its own I/O "
                    "instead of using an HTTP Request node"
                )

    # Whole-document scan: no embedded token, no unlisted $env reference.
    for path, s in find_strings(doc):
        if TOKEN_PATTERN.search(s):
            findings.append(f"{filename}: embedded service-token-shaped string at {path}")
        for var in ENV_PATTERN.findall(s):
            if var not in ALLOWED_ENV_VARS:
                findings.append(f"{filename}: references $env.{var} at {path}, not in the allowed list {sorted(ALLOWED_ENV_VARS)}")

    # workflowKey embedded in the "Open Run" node's body must match both the
    # file's own basename and a real manifest entry -- a copy-pasted
    # workflow that was renamed but not re-keyed is exactly the kind of
    # mistake this catches.
    base = os.path.basename(filename)
    if base.endswith(".workflow.json"):
        expected_key = base[: -len(".workflow.json")]
        combined = json.dumps(doc)
        match = re.search(r'workflowKey:\s*\\?"([a-z0-9-]+)\\?"', combined)
        if not match:
            findings.append(f"{filename}: no workflowKey literal found in any node body")
        else:
            found_key = match.group(1)
            if found_key != expected_key:
                findings.append(
                    f"{filename}: workflowKey '{found_key}' does not match filename-derived key '{expected_key}'"
                )
            if found_key not in known_keys:
                findings.append(f"{filename}: workflowKey '{found_key}' is not in the manifest")

    return findings


def main(argv):
    if len(argv) < 3:
        print("usage: workflow-lint.py <manifest.json> <workflow.json> [...]", file=sys.stderr)
        return 2

    manifest_path = argv[1]
    with open(manifest_path, "r", encoding="utf-8") as f:
        manifest = json.load(f)
    known_keys = {w["key"] for w in manifest.get("workflows", [])}

    all_findings = []
    for path in argv[2:]:
        with open(path, "r", encoding="utf-8") as f:
            doc = json.load(f)
        all_findings.extend(lint_workflow(doc, path, known_keys))

    if all_findings:
        for finding in all_findings:
            print(finding)
        return 1

    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
