"""
Unit tests for the classification rules of the maintenance scripts.

A script returns before its main part when it is sourced, so a test can call
its functions with the text that Dependabot and the commit history produce.
"""

import os
import subprocess
from pathlib import Path

import pytest

ROOT = Path(__file__).parent.parent
ENV = {"GH_TOKEN": "x", "GITHUB_REPOSITORY": "o/r", "PR_NUMBER": "1"}


def _call(script, function, text):
    result = subprocess.run(
        [
            "bash",
            "-c",
            'source "$1"; shift; "$@"',
            "bash",
            str(ROOT / script),
            function,
            text,
        ],
        capture_output=True,
        text=True,
        env={**os.environ, **ENV},
    )
    assert result.returncode == 0, result.stderr
    return result.stdout.strip()


def _level(updates):
    return _call("scripts/ci/dependabot-automerge.sh", "worst_level", updates)


def _kept(subjects):
    return _call("scripts/ci/auto-bump.sh", "keeps_manual", subjects)


# --- dependabot-automerge.sh: the worst bump of a pull request ----------------


@pytest.mark.parametrize(
    "updates, level",
    [
        ("Updates `flask` from 3.1.2 to 3.1.3", "patch"),
        ("Updates `ruff` from 0.17.4 to 0.17.5.", "patch"),
        ("Updates `ruff` from 0.17.5 to 0.18.0", "minor"),
        ("Bump node from 26.13.1-alpine to 26.14.0-alpine", "minor"),
        ("Bump actions/checkout from v7.0.1 to v8.0.0", "major"),
        ("Updates `a` from 1.0.0 to 1.0.1\nUpdates `b` from 2.0.0 to 3.0.0", "major"),
        # a digest-only bump: the pinned tag was rebuilt upstream
        ("Bumps python from `63bb298` to `a1b2c3d`.", "patch"),
        ("Bump python from 3.15.2-slim@sha256:aaa to 3.15.2-slim@sha256:bbb", "patch"),
        # no version pair to compare: a human looks at it
        ("Bump foo from latest to stable", "manual"),
        ("chore(deps): bump the runtime group", "patch"),
    ],
)
def test_the_worst_bump_of_a_dependabot_pull_request(updates, level):
    assert _level(updates) == level


# --- auto-bump.sh: which commits keep the release manual ----------------------


@pytest.mark.parametrize(
    "subjects, kept",
    [
        ("fix: handle x", ""),
        ("fix(ui): handle x", ""),
        ("docs(readme): x\nci: y\nchore(deps): bump the runtime group", ""),
        ("chore(ci): bump the ci-tooling group with 2 updates", ""),
        ("feat(ui): x", "- feat(ui): x"),
        ("refactor(core): x\nfix: y", "- refactor(core): x"),
        ("fix(core)!: change the schema", "- breaking: fix(core)!: change the schema"),
        ("chore: bump version to 3.1.1", "- chore: bump version to 3.1.1"),
        ("Merge branch main", "- unparsable: Merge branch main"),
    ],
)
def test_the_commits_that_keep_the_release_manual(subjects, kept):
    assert _kept(subjects) == kept
