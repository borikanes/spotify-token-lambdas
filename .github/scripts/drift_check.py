#!/usr/bin/env python3
"""Compare every deployed Lambda's index.js against this checkout of main.

This is the automated form of the manual audit that found four drifted
functions in August 2026 — including a production token-refresh lambda running
an older implementation than main, on a runtime that could not even execute
main's code. Running it on a schedule means that gap is measured in hours
rather than discovered by accident.

Exits non-zero if any function's deployed code differs from main, so the
scheduled workflow fails loudly.
"""
import hashlib
import io
import json
import os
import subprocess
import sys
import urllib.request
import zipfile

TARGETS_FILE = os.path.join(os.path.dirname(__file__), '..', 'deploy-targets.json')


def deployed_index_sha(function_name):
    """Download a Lambda deployment package and hash the index.js inside it.

    :param function_name: AWS Lambda function name.
    :returns: Hex sha256 of the deployed index.js.
    """
    location = subprocess.run(
        ['aws', 'lambda', 'get-function', '--function-name', function_name,
         '--query', 'Code.Location', '--output', 'text'],
        capture_output=True, text=True, check=True
    ).stdout.strip()

    with urllib.request.urlopen(location) as response:
        package = zipfile.ZipFile(io.BytesIO(response.read()))
    return hashlib.sha256(package.read('index.js')).hexdigest()


def local_index_sha(lambda_dir):
    """Hash the index.js in this checkout for the given lambda directory.

    :param lambda_dir: Lambda directory name, e.g. "fetch-new-song".
    :returns: Hex sha256 of the local index.js.
    """
    with open(os.path.join(lambda_dir, 'index.js'), 'rb') as handle:
        return hashlib.sha256(handle.read()).hexdigest()


def main():
    """Check every configured function against main, printing a table."""
    with open(TARGETS_FILE) as handle:
        targets = json.load(handle)['lambdas']

    drifted = []
    rows = []

    for lambda_dir, config in sorted(targets.items()):
        expected = local_index_sha(lambda_dir)
        for stage in ('qa', 'prod'):
            function_name = config.get(stage)
            if not function_name:
                continue
            try:
                actual = deployed_index_sha(function_name)
            except Exception as error:  # noqa: BLE001 - report, don't crash the run
                rows.append((function_name, stage, f'ERROR: {error}'))
                drifted.append(function_name)
                continue

            if actual == expected:
                rows.append((function_name, stage, 'in sync'))
            else:
                rows.append((function_name, stage, f'DRIFT deployed={actual[:12]} main={expected[:12]}'))
                drifted.append(function_name)

    width = max(len(row[0]) for row in rows)
    for name, stage, status in rows:
        print(f'{name:{width}}  {stage:4}  {status}')

    print()
    if drifted:
        print(f'::error::{len(drifted)} function(s) differ from main: {", ".join(drifted)}')
        return 1

    print(f'All {len(rows)} deployed functions match main.')
    return 0


if __name__ == '__main__':
    sys.exit(main())
