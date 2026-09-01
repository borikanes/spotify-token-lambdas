#!/usr/bin/env python3
"""Verify the HTTP response contract of the deployed API, from the outside.

Unit tests check what a lambda returns. They cannot check what the *client*
receives, because that depends on the API Gateway integration type — and that
gap caused a production outage on 2026-08-30: token refresh was deployed
returning an API-Gateway-style `{statusCode, body}` envelope, which is correct
for a PROXY integration but wrong for the non-proxy one these endpoints use.
The lambda's return value is the response body verbatim, so the SpotifyiOS SDK
stopped finding `access_token` and every Spotify call in the app failed. The
unit tests passed the whole time, because they asserted the broken shape.

This runs after a deploy against the real stage URL and fails the job if the
wire format is wrong.

Usage: smoke_endpoints.py <stage>        # qa | prod
"""
import json
import sys
import urllib.error
import urllib.parse
import urllib.request

API_ID = '7lqqfxe2va'
REGION = 'us-east-1'

# Envelope keys that must never appear at the top level of a non-proxy response.
# Their presence means a lambda is returning a proxy-shaped payload and the
# client is receiving a wrapper instead of the data it expects.
ENVELOPE_KEYS = ('statusCode', 'body', 'headers')


def post_form(url, fields):
    """POST form-urlencoded data and return (status, decoded_body).

    :param url: Full endpoint URL.
    :param fields: Dict of form fields.
    :returns: Tuple of (http_status:int, body:str).
    """
    data = urllib.parse.urlencode(fields).encode()
    request = urllib.request.Request(
        url, data=data,
        headers={'Content-Type': 'application/x-www-form-urlencoded'}
    )
    try:
        with urllib.request.urlopen(request, timeout=30) as response:
            return response.status, response.read().decode()
    except urllib.error.HTTPError as error:
        return error.code, error.read().decode()


def get(url, headers=None):
    """GET a URL and return its status code.

    :param url: Full endpoint URL.
    :param headers: Optional request headers.
    :returns: HTTP status code as an int.
    """
    request = urllib.request.Request(url, headers=headers or {})
    try:
        with urllib.request.urlopen(request, timeout=30) as response:
            return response.status
    except urllib.error.HTTPError as error:
        return error.code


def check_raw_json_contract(name, url, fields, failures):
    """Assert a non-proxy endpoint returns raw JSON, not a proxy envelope.

    Probes with a deliberately invalid credential: the point is the SHAPE of the
    response, which is identical for success and failure on these endpoints.

    :param name: Endpoint label for output.
    :param url: Full endpoint URL.
    :param fields: Form fields to post.
    :param failures: List that failure messages are appended to.
    :returns: None.
    """
    status, body = post_form(url, fields)

    try:
        payload = json.loads(body)
    except json.JSONDecodeError:
        failures.append(f'{name}: response is not JSON: {body[:200]}')
        print(f'  FAIL {name}: not JSON')
        return

    if not isinstance(payload, dict):
        failures.append(f'{name}: expected a JSON object, got {type(payload).__name__}')
        print(f'  FAIL {name}: not a JSON object')
        return

    found = [key for key in ENVELOPE_KEYS if key in payload]
    if found:
        failures.append(
            f'{name}: response is wrapped in an API Gateway envelope {found}. '
            f'This endpoint is a non-proxy integration, so the lambda must return '
            f'the payload raw — the SpotifyiOS SDK reads access_token off the top level.'
        )
        print(f'  FAIL {name}: envelope keys present {found}')
        return

    # An invalid credential must never yield a token.
    if 'access_token' in payload:
        failures.append(f'{name}: returned an access_token for an invalid credential')
        print(f'  FAIL {name}: unexpected access_token')
        return

    # Spotify's error JSON is what should come back, passed through untouched.
    if 'error' not in payload:
        failures.append(f'{name}: expected Spotify\'s error JSON, got keys {sorted(payload)}')
        print(f'  FAIL {name}: no error field; keys={sorted(payload)}')
        return

    print(f'  ok   {name}: raw JSON, no envelope (error={payload["error"]!r})')


def main():
    """Run the contract checks for one stage; exit non-zero on any failure."""
    if len(sys.argv) != 2 or sys.argv[1] not in ('qa', 'prod'):
        print(__doc__, file=sys.stderr)
        return 2

    stage = sys.argv[1]
    base = f'https://{API_ID}.execute-api.{REGION}.amazonaws.com/{stage}'
    failures = []

    print(f'Checking {stage} endpoint contracts at {base}')

    # Non-proxy integrations: the lambda's return value IS the response body.
    check_raw_json_contract(
        'POST /api/refresh_token',
        f'{base}/api/refresh_token',
        {'refresh_token': 'ci-smoke-test-invalid'},
        failures,
    )
    check_raw_json_contract(
        'POST /api/token',
        f'{base}/api/token',
        {'code': 'ci-smoke-test-invalid'},
        failures,
    )

    # Proxy integration: API Gateway unwraps the lambda's envelope, so a real
    # HTTP 400 here proves the unwrapping still works and the lambda is reachable.
    # (No device-id header, which the handler rejects with 400.)
    status = get(f'{base}/playlists')
    if status == 400:
        print('  ok   GET /playlists: proxy integration unwrapped to HTTP 400')
    else:
        failures.append(f'GET /playlists: expected HTTP 400 with no device-id, got {status}')
        print(f'  FAIL GET /playlists: HTTP {status}')

    # POST /api/feedback is deliberately NOT probed: it sends a real email.

    print()
    if failures:
        for failure in failures:
            print(f'::error::{failure}')
        return 1

    print(f'All {stage} endpoint contracts hold.')
    return 0


if __name__ == '__main__':
    sys.exit(main())
