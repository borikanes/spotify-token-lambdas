#!/usr/bin/env python3
"""Work out which lambda directories a set of changed files touches.

Reads newline-separated changed file paths on stdin and prints a JSON array of
lambda directory names to stdout, so a push touching one lambda does not trigger
a redeploy of the others.

Test files are ignored: they are never included in a deploy zip, so a
test-only change should not produce a deploy.
"""
import json
import os
import sys

TARGETS_FILE = os.path.join(os.path.dirname(__file__), '..', 'deploy-targets.json')


def detect(changed_files, lambda_names):
    """Return the sorted lambda directories that own at least one changed file.

    :param changed_files: Iterable of repo-relative changed file paths.
    :param lambda_names: Iterable of known lambda directory names.
    :returns: Sorted list of lambda directory names needing a deploy.
    """
    hits = set()
    for name in lambda_names:
        prefix = name + '/'
        for path in changed_files:
            path = path.strip()
            if not path or not path.startswith(prefix):
                continue
            if path.endswith('.test.js'):
                continue
            hits.add(name)
            break
    return sorted(hits)


def main():
    """Read changed paths from stdin and print the JSON array of lambdas to deploy."""
    with open(TARGETS_FILE) as handle:
        targets = json.load(handle)['lambdas']

    changed = [line for line in sys.stdin.read().split('\n') if line.strip()]
    print(json.dumps(detect(changed, targets.keys())))


if __name__ == '__main__':
    main()
