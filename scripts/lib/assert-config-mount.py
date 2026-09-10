#!/usr/bin/env python3
"""Asserts a rendered Compose model has no unsafe nested bind mount.

Usage: docker compose ... config --format json | assert-config-mount.py <service> [<mount-target>]

Reads a fully-resolved `docker compose config --format json` document (not
the raw YAML source -- interpolation, merges and defaults are already
applied) from stdin and checks one service's `volumes[]` list for the exact
failure class that broke the Stage 9 live deployment twice: a read-only
bind mount whose target is a nested subpath of ANOTHER mount's target on
the same service. Docker/runc mounts bind targets shortest-path-first, so
once the shorter (parent) target is bound read-only, runc cannot `mkdir`
the nested mountpoint for the longer (child) target -- an OCI runtime
container-*create* failure, not a slow-start race, and therefore not
something a health-check retry loop could ever paper over.

If <mount-target> is given, additionally asserts that service has EXACTLY
ONE volume entry whose target equals it -- the specific, named assertion
scripts/update.sh makes for control-api's /config mount, on top of the
general nested-mount rule.

Exits 0 (silent) if the model is safe. Exits 1, printing exactly what is
wrong, otherwise. Never touches Docker itself -- the caller is responsible
for producing the `compose config` output this script inspects, which is
what makes this check exercise the SAME resolved model an actual `compose
run`/`compose up` would use, not a separate guess at what the YAML means.
"""
import json
import sys


def main(argv):
    if len(argv) < 2:
        print("usage: assert-config-mount.py <service> [<mount-target>] < compose-config.json", file=sys.stderr)
        return 2
    service_name = argv[1]
    required_target = argv[2] if len(argv) > 2 else None

    try:
        model = json.load(sys.stdin)
    except json.JSONDecodeError as exc:
        print(f"stdin is not valid JSON (expected `docker compose config --format json` output): {exc}", file=sys.stderr)
        return 1

    services = model.get("services", {})
    if service_name not in services:
        print(f"service '{service_name}' not found in the resolved compose model", file=sys.stderr)
        return 1

    volumes = services[service_name].get("volumes", [])
    targets = [v.get("target") for v in volumes if isinstance(v, dict) and v.get("target")]

    problems = []

    # General rule: no mount's target may be a proper nested subpath of
    # another mount's target on the same service -- exactly the mechanical
    # shape of the bug, independent of the specific path name involved.
    for target in targets:
        for other in targets:
            if target == other:
                continue
            if target.startswith(other.rstrip("/") + "/"):
                problems.append(
                    f"mount target '{target}' is nested inside mount target '{other}' -- "
                    "this is the exact shape that fails under read_only:true "
                    "(runc cannot create the nested mountpoint inside an already-read-only parent mount)"
                )

    if required_target is not None:
        matches = [t for t in targets if t == required_target]
        if len(matches) != 1:
            problems.append(
                f"expected exactly one volume with target '{required_target}' on service '{service_name}', found {len(matches)}"
            )

    if problems:
        for problem in problems:
            print(problem, file=sys.stderr)
        return 1

    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
