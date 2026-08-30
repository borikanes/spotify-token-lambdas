#!/usr/bin/env python3
"""Verify that a deployed Lambda's index.js matches the file in this checkout.

Run immediately after a deploy so a silent failure (a stale zip, a build that
did not rerun, a deploy that hit the wrong function) fails the job instead of
leaving AWS quietly out of step with main. This exact check, run by hand, is
what caught two stale-zip deploys during the pre-pipeline cleanup.

Usage: verify_deployed.py <function-name> <path/to/index.js>
"""
import hashlib
import io
import json
import subprocess
import sys
import urllib.request
import zipfile


def deployed_index_sha(function_name):
    """Download a Lambda's deployment package and hash the index.js inside it.

    :param function_name: AWS Lambda function name.
    :returns: Hex sha256 of the deployed index.js.
    :raises KeyError: If the package contains no index.js at its root.
    """
    result = subprocess.run(
        ['aws', 'lambda', 'get-function', '--function-name', function_name,
         '--query', 'Code.Location', '--output', 'text'],
        capture_output=True, text=True, check=True
    )
    url = result.stdout.strip()

    with urllib.request.urlopen(url) as response:
        package = zipfile.ZipFile(io.BytesIO(response.read()))

    return hashlib.sha256(package.read('index.js')).hexdigest()


def main():
    """Compare deployed and local index.js, exiting non-zero on any mismatch."""
    if len(sys.argv) != 3:
        print(__doc__, file=sys.stderr)
        return 2

    function_name, local_path = sys.argv[1], sys.argv[2]

    with open(local_path, 'rb') as handle:
        local_sha = hashlib.sha256(handle.read()).hexdigest()

    try:
        remote_sha = deployed_index_sha(function_name)
    except Exception as error:  # noqa: BLE001 - any failure here must fail the deploy
        print(f'::error::Could not verify {function_name}: {error}')
        return 1

    if local_sha == remote_sha:
        print(f'Verified {function_name}: deployed index.js matches {local_path} ({local_sha[:12]})')
        return 0

    print(f'::error::{function_name} does not match {local_path} after deploy.')
    print(f'  deployed sha256: {remote_sha}')
    print(f'  expected sha256: {local_sha}')
    return 1


if __name__ == '__main__':
    sys.exit(main())
