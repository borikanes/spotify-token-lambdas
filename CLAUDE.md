# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

This repo contains 6 independent AWS Lambda functions backing an iOS app called "Song Updater" that monitors Spotify playlists for new tracks and delivers push notifications.

## Setup

Each lambda is self-contained. To set up any lambda:
```bash
cd <lambda-folder>
npm install
```

**fetch-new-song** runs on `nodejs22.x` with AWS SDK v3 (provided by the runtime) and has no runtime npm dependencies — its deploy zip is just `index.js`. Deploy with `npm run build && npm run deploy` from `fetch-new-song/`. The other lambdas still bundle their `node_modules` (deploy via [node-lambda](https://www.npmjs.com/package/node-lambda) or the AWS console).

There are no lint or test commands.

## Architecture

Six independent lambdas, each in its own directory:

| Lambda | Trigger | Purpose |
|---|---|---|
| `fetch-new-song` | CloudWatch cron + API Gateway GET `/tracks/new` | Core: fetches new Spotify tracks, stores in DynamoDB, sends APN push notifications |
| `spotify-api-token-lambda` | API Gateway POST `/api/token` | Spotify OAuth authorization code → token exchange |
| `spotify-refresh-token-lambda` | API Gateway POST `/api/refresh_token` | Spotify OAuth refresh token → new access token |
| `playlist-table-handler` | API Gateway POST `/playlists/add`, `/playlists/remove` | Manages watched playlists in DynamoDB + S3 |
| `get-feedback-help` | API Gateway | User feedback → AWS SES email |
| `clean-playlist-generator` | API Gateway POST `/playlists/clean`, GET `/playlists/clean-jobs`, + async self-invocation | Generates a non-explicit copy of a playlist for the requesting user |

### Data Flow (fetch-new-song cron)

1. Reads active playlist IDs from S3 (`song-updater-resources/playlists.json`)
2. For each playlist (processed in parallel batches of 10), fetches tracks added in the last 24 hours from Spotify API (handles pagination). Playlists that Spotify errors on are skipped, recorded, and summarized in a `Failed playlists this run` log line
3. Skips Spotify-owned playlists that reload 100% of their tracks (anti-spam)
4. Writes new tracks to `SongTrackMapper` DynamoDB table with a 24-hour TTL
5. Queries `NotificationTracker` table for devices whose `preferredNotificationTime` matches current UTC hour
6. Sends APN push notifications via a separate notification service endpoint (the `apn-lambda-go` repo at `/Users/borikanes/Code/go/src/github.com/borikanes/apn-lambda-go` — see its CLAUDE.md)

`fetch-new-song/scripts/prune-stale-playlists.js` is a maintenance script (dry-run by default, `--apply` to write) that removes playlists watched only by devices inactive since a cutoff date from `playlists.json` and `WatchedPlaylists`, backing up the old file to S3 first.

### Data Flow (clean-playlist-generator)

Generates a copy of a playlist with explicit tracks swapped for their clean equivalents (or dropped if none exists), owned by the requesting user. Split into a fast synchronous entry point and an async worker to stay clear of API Gateway's ~29s timeout on playlists with many uncached explicit tracks:

1. `POST /playlists/clean` (body: `{ playlistId, isPublic, playlistName?, deviceId }`, header: `Authorization: Bearer <user token>`) validates input, writes a `pending` job to `CleanPlaylistJobs`, and asynchronously self-invokes (`InvocationType: 'Event'`) with the job payload — returns `202 { jobId }` immediately. **`deviceId` comes from the body, not a header**: the iOS app's `NetworkManager.makePostOrPutCall` only forwards an `Authorization` header, never `device-id` (that forwarding exists solely in `makeGetCall`). A `device-id` header is still accepted as a fallback for curl/tests.
2. The async invocation (`event.action === 'processCleanJob'`) does the actual work, using a **client-credentials token** (own `fetchSpotifyToken()`, same flow as `fetch-new-song`) for every read/search call, and the **user's forwarded access token** only for the final create-playlist/add-tracks calls — so job duration isn't bounded by the user's token lifetime (~1hr):
   - Fetches all tracks in the source playlist (must be publicly readable, since this uses a client-credentials token)
   - For each explicit track, checks `CleanTrackMapper` (keyed by the explicit track's Spotify ID — stable/permanent, no TTL) for a cached clean-version match; on a miss, searches Spotify (`track:{name} artist:{artist}`, requiring an exact case-insensitive name+artist match on a non-explicit result) and caches the outcome either way, including a `no_clean_version` negative result, so a track is never searched twice
   - Non-explicit tracks pass through unchanged; explicit tracks with no clean match are skipped entirely (not included dirty)
   - Creates the new playlist under the requesting user (`public`/`private` per request), adds the resulting tracks (batched at 100/request), updates the job to `complete` (recording `newPlaylistId`, `newPlaylistName`, `tracksAdded`, `tracksSkipped` — the name is stored so the app's result screen doesn't have to re-fetch it)
   - Sends an APN push via the same notification service endpoint `fetch-new-song` uses, looking up the device token from `NotificationTracker`. The push carries `notificationType: "cleanPlaylistReady"` + `playlistId` so the iOS app can tell it apart from a new-song push and deep link to the result — this required adding two optional passthrough fields to the `apn-lambda-go` lambda (see its CLAUDE.md); without them the app badges the New Songs tab and jumps to it for *any* push.
3. `GET /playlists/clean-jobs?jobId=...` is a polling fallback for clients that don't get the push.

**QA is fully provisioned and smoke-tested (2026-08-25):** `CleanTrackMapperQA`/`CleanPlaylistJobsQA` tables, `cleanPlaylistGeneratorQA` function (role `lambda-apiGateway-s3Access`, which needed an added inline policy `cleanPlaylistGeneratorSelfInvoke` granting `lambda:InvokeFunction` on itself — none of its existing managed policies covered that), `/playlists/clean` + `/playlists/clean-jobs` resources on `7lqqfxe2va` wired via the `${stageVariables.cleanPlaylistGeneratorAPI}` pattern (stage variable set on `qa` only), deployed to the `qa` stage. Smoke test against a real public playlist confirmed the full chain (sync entry point → async self-invoke → cache read/search/write → job status) works end-to-end; only 7/33 explicit tracks in that playlist had a confident clean-version match (21%) — a real data point on how often the search heuristic actually finds one. **Prod is not provisioned** — no `CleanTrackMapper`/`CleanPlaylistJobs` tables, no `cleanPlaylistGenerator` function, no prod stage variable/resources yet; the self-invoke IAM policy already includes the prod function's ARN preemptively so that step is ready when prod is built.

### DynamoDB Tables

- **`NotificationTracker`** — Devices with push notification settings; GSI: `preferredNotificationTimeIndex` on `preferredNotificationTime`
- **`WatchedPlaylists`** — Playlists being monitored with a watch counter (multiple users can watch the same playlist)
- **`SongTrackMapper`** — Tracks added in the last 24 hours; GSI: `playlistId-index` on `playlistId`; items auto-expire via TTL
- **`CleanTrackMapper`** *(QA only so far — `CleanTrackMapperQA`; prod not yet created)* — Permanent cache of explicit→clean track matches; hash key `explicitTrackId`; no TTL, since a resolved match (positive or negative) never goes stale
- **`CleanPlaylistJobs`** *(QA only so far — `CleanPlaylistJobsQA`; prod not yet created)* — Clean-playlist job status; hash key `jobId`

QA equivalents: `SongTrackerMapperQA` (note the extra "er" — it does NOT match the prod name), `WatchedPlaylistsQA`, `NotificationTrackerQA`, `CleanTrackMapperQA`, `CleanPlaylistJobsQA`.

### S3

`song-updater-resources` bucket — stores `playlists.json` (a dictionary of active playlist IDs). `playlist-table-handler` writes this file; `fetch-new-song` reads it.

## Environment Variables

Each lambda reads from environment variables set in AWS Lambda configuration:

**fetch-new-song:**
- `SPOTIFY_CLIENT_ID`, `SPOTIFY_CLIENT_SECRET` — Spotify app credentials (client credentials flow)
- `NOTIFICATION_TRACKER_TABLE`, `WATCHED_PLAYLISTS_TABLE`, `SONG_TRACKER_TABLE` — DynamoDB table names (default to prod table names)
- `PLAYLIST_FILE_KEY` — S3 key for playlist file (default: `playlists.json`)
- `ENV` — Set to `qa` for QA environment (affects APN bundle ID)

**spotify-api-token-lambda / spotify-refresh-token-lambda:**
- `SPOTIFY_CLIENT_ID`, `SPOTIFY_CLIENT_SECRET`, `SPOTIFY_CLIENT_CALLBACK_URL`

**get-feedback-help:**
- `TO_EMAIL`, `FROM_EMAIL`

**clean-playlist-generator:**
- `SPOTIFY_CLIENT_ID`, `SPOTIFY_CLIENT_SECRET` — for its own client-credentials token (reads/searches only)
- `CLEAN_TRACK_MAPPER_TABLE`, `CLEAN_PLAYLIST_JOBS_TABLE`, `NOTIFICATION_TRACKER_TABLE` — DynamoDB table names (default to prod table names; set to the `QA` variants on the QA function/alias, same pattern as `fetch-new-song`)

## Key Implementation Details

- **`fetch-new-song`** serves dual purposes: as a cron job (CloudWatch) and as an HTTP endpoint (`GET /tracks/new`). The handler branches on `event.path === "/tracks/new"`.
- **`playlist-table-handler`** uses a reference-counting pattern — playlists are tracked with a watch counter so that removing one user's watch doesn't delete a playlist still watched by others. On last removal, all associated `SongTrackMapper` records are deleted.
- Spotify tokens for `fetch-new-song` (and for the read/search calls in `clean-playlist-generator`) use the **client credentials flow** (not user OAuth), so they can only access public playlists.
- The APN notification endpoint is hardcoded: `https://ho7won2i0j.execute-api.us-east-1.amazonaws.com/{prod|QA}/send-notifications`
- All lambdas target `us-east-1`.
- **API Gateway mapping template** is required for the token lambdas — the gateway must translate `application/x-www-form-urlencoded` POST bodies into `{ "data": { ... } }` JSON before passing to the lambda (see README.md for the VTL template).
- **Known bug (not fixed, out of scope):** `fetch-new-song`'s notification-sending code compares `environmentFromStageVariable === 'qa'` (line ~248) to pick the QA vs prod notification URL, but `environmentFromStageVariable` is assigned the whole `event.stageVariables` *object* (line ~422), not a string — so that comparison likely never evaluates true. `clean-playlist-generator` avoids this by comparing `environmentFromStageVariable.environment === 'qa'` instead, matching `playlist-table-handler`'s (correct) pattern.
- ⚠️ **`stageVariables` do NOT survive an async self-invoke.** API Gateway sets `event.stageVariables` only on the *HTTP* invocation; a `lambda.invoke(InvocationType: 'Event')` event carries whatever payload you pass and nothing else. `clean-playlist-generator` hit this in QA device testing (2026-08-28): the worker computed `isQA === false`, so the completion push was sent with the **prod** bundle ID, which routed it to production APNs and returned `400 BadDeviceToken` against a sandbox device token. Fix: `handleStartCleanJob` threads `environment: environmentFromStageVariable.environment` into the worker payload, and the worker restores `environmentFromStageVariable` from it. **Any new state read from `stageVariables` must be threaded the same way** — this class of bug is invisible to HTTP-level testing because the sync entry point always has the stage variables.
