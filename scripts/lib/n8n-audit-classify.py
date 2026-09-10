#!/usr/bin/env python3
"""Classifies `n8n audit` output into pass/fail/warn check rows.

Usage: n8n-audit-classify.py < audit-output.txt

Reads the raw stdout of `n8n audit --categories=credentials,database,nodes,
instance,filesystem` (which n8n 2.34.0 sometimes prefixes with an unrelated
status line such as "Acquiring database migration lock..." before the JSON
report itself) and prints one line per check in the same
`STATUS|ID|DESCRIPTION|DETAIL` shape verify-security.sh's own
`record_check`/`PC_CHECK_ROWS` convention uses, so the caller only has to
split on `|` and call `record_check` — the actual audit-report semantics
live here, once, where they can be unit-tested against synthetic fixtures
(tests/n8n-audit-classify-regression.sh) without a live n8n instance.

Design principle: fail closed on the unknown. `n8n audit` only emits a
top-level report key for a category when it actually found something —
there is no "Credentials Risk Report: nothing to report" for the empty
case. That means the *absence* of a category's report key is not
distinguishable from "n8n audit wasn't asked to check it" without also
recording which categories were requested — so any report key this script
does not specifically recognise (Credentials/Database/Nodes/Filesystem Risk
Report, or an unrecognised section inside Instance Risk Report) is treated
as a finding requiring human review (N8N-006), not silently accepted. A
narrower classifier that only ever checked communityPackagesEnabled would
pass even if n8n's own audit found a SQL-injection-shaped expression or a
risky node in an imported workflow — this one does not.
"""
import json
import sys

KNOWN_INSTANCE_SECTIONS = {"Security settings", "Outdated instance"}

# n8n's "Official risky nodes" audit flags ANY use of a handful of official
# node types that could run arbitrary code — it does not (and cannot) know
# that this deployment's own node types are the two the shipped, reviewed
# Project Control workflows are built on: HTTP Request (to call this
# deployment's own control-api, never an arbitrary external host — see
# workflow-lint.py's own URL-allowlist rule) and Code (an inline evaluation
# step, never install-workflows.sh's own review boundary). The single most
# dangerous official node type, Execute Command, is excluded at the n8n
# instance level entirely (NODES_EXCLUDE, see infra/compose/compose.yaml's
# N8N_COMMUNITY_PACKAGES_ENABLED comment) and would never even load if
# something tried to reference it. This narrows acceptance to exactly those
# two node types — anything else this report ever flags (Execute Command
# somehow present, a Webhook trigger, an unreviewed third node type) stays
# an unaccepted, FAIL-classified finding, same as before this exception
# existed.
ACCEPTED_RISKY_NODE_TYPES = {"n8n-nodes-base.httpRequest", "n8n-nodes-base.code"}


def emit(status: str, check_id: str, description: str, detail: str = "") -> None:
    # Pipe-delimited, matching PC_CHECK_ROWS; neither field may contain '|'.
    description = description.replace("|", "/")
    detail = detail.replace("|", "/")
    print(f"{status}|{check_id}|{description}|{detail}")


def classify(raw: str) -> None:
    start = raw.find("{")
    if start < 0:
        emit("WARN", "N8N-004", "n8n audit produced no parseable JSON output", raw[:200])
        emit("WARN", "N8N-005", "n8n audit produced no parseable JSON output", "")
        emit("WARN", "N8N-006", "n8n audit produced no parseable JSON output", "")
        return

    try:
        doc = json.loads(raw[start:])
    except Exception as exc:  # noqa: BLE001 - deliberately broad, this is a diagnostic path
        emit("WARN", "N8N-004", "n8n audit output could not be parsed as JSON", str(exc)[:200])
        emit("WARN", "N8N-005", "n8n audit output could not be parsed as JSON", "")
        emit("WARN", "N8N-006", "n8n audit output could not be parsed as JSON", "")
        return

    if not isinstance(doc, dict):
        emit("WARN", "N8N-004", "n8n audit output was not a JSON object", "")
        emit("WARN", "N8N-005", "n8n audit output was not a JSON object", "")
        emit("WARN", "N8N-006", "n8n audit output was not a JSON object", "")
        return

    instance = doc.get("Instance Risk Report")
    sections = {}
    if isinstance(instance, dict):
        for section in instance.get("sections", []) or []:
            if isinstance(section, dict) and section.get("title"):
                sections[section["title"]] = section

    # --- N8N-004: community packages -----------------------------------------
    security = sections.get("Security settings")
    if security is None:
        emit("WARN", "N8N-004", "n8n audit has no Security settings section", "cannot confirm community-packages setting")
    else:
        features = (security.get("settings") or {}).get("features") or {}
        enabled = features.get("communityPackagesEnabled")
        if enabled is False:
            emit("PASS", "N8N-004", "n8n community packages are disabled", "")
        elif enabled is True:
            emit("FAIL", "N8N-004", "n8n community packages are enabled", "set N8N_COMMUNITY_PACKAGES_ENABLED=false")
        else:
            emit("WARN", "N8N-004", "could not read communityPackagesEnabled from n8n audit output", "")

    # --- N8N-005: outdated-instance notice, accepted by design ---------------
    # This deployment pins every image to an immutable digest (see
    # infra/versions.lock.env and the "Version pinning" section of the
    # project README) rather than tracking upstream releases automatically —
    # an available update is an expected, ongoing state, not a defect, so
    # this is WARN (visible on every run) rather than FAIL.
    outdated = sections.get("Outdated instance")
    if outdated is not None:
        emit(
            "WARN", "N8N-005", "n8n reports a newer version is available",
            "accepted: this deployment pins images to a digest deliberately — "
            + str(outdated.get("description") or "")[:200],
        )
    else:
        emit("PASS", "N8N-005", "n8n instance reports no available update", "")

    # --- N8N-006: anything else n8n's own audit found -------------------------
    unexpected: list[str] = []
    accepted_nodes_finding = False
    for key, report in doc.items():
        if not isinstance(report, dict):
            continue
        if key == "Instance Risk Report":
            extra_titles = [
                s.get("title")
                for s in (report.get("sections") or [])
                if isinstance(s, dict) and s.get("title") not in KNOWN_INSTANCE_SECTIONS
            ]
            unexpected.extend(f"Instance Risk Report: {t}" for t in extra_titles)
        elif key == "Nodes Risk Report":
            sections = report.get("sections") or []
            all_official_risky_and_accepted = bool(sections) and all(
                isinstance(s, dict)
                and s.get("title") == "Official risky nodes"
                and all(
                    isinstance(loc, dict) and loc.get("nodeType") in ACCEPTED_RISKY_NODE_TYPES
                    for loc in (s.get("location") or [])
                )
                for s in sections
            )
            if all_official_risky_and_accepted:
                accepted_nodes_finding = True
            else:
                titles = [s.get("title") for s in sections if isinstance(s, dict)]
                label = ", ".join(str(t) for t in titles if t) or "no section titles"
                unexpected.append(f"{key} ({label})")
        else:
            titles = [s.get("title") for s in (report.get("sections") or []) if isinstance(s, dict)]
            label = ", ".join(str(t) for t in titles if t) or "no section titles"
            unexpected.append(f"{key} ({label})")

    if accepted_nodes_finding:
        emit(
            "WARN", "N8N-007", "n8n flagged Official risky nodes",
            "accepted: this deployment's own shipped workflows use only HTTP Request "
            "(calling this instance's own control-api) and Code (inline evaluation) — "
            "Execute Command is excluded at the instance level (NODES_EXCLUDE)",
        )

    if unexpected:
        emit(
            "FAIL", "N8N-006", "n8n audit reported finding(s) this deployment has not reviewed",
            "; ".join(unexpected)[:300],
        )
    else:
        emit("PASS", "N8N-006", "n8n audit reported no findings outside the known/accepted set", "")


if __name__ == "__main__":
    classify(sys.stdin.read())
