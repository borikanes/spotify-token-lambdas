# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

This repo contains 5 independent AWS Lambda functions backing an iOS app called "Song Updater" that monitors Spotify playlists for new tracks and delivers push notifications.

## Setup

Each lambda is self-contained. To set up any lambda:
```bash
cd <lambda-folder>
npm install
```

Deploy via [node-lambda](https://www.npmjs.com/package/node-lambda) or the AWS console. Include `node_modules` in the deployment package.

There are no build, lint, or test commands — scripts are all no-ops.

## Architecture

Five independent lambdas, each in its own directory:

| Lambda | Trigger | Purpose |
|---|---|---|
| `fetch-new-song` | CloudWatch cron + API Gateway GET `/tracks/new` | Core: fetches new Spotify tracks, stores in DynamoDB, sends APN push notifications |
| `spotify-api-token-lambda` | API Gateway POST `/api/token` | Spotify OAuth authorization code → token exchange |
| `spotify-refresh-token-lambda` | API Gateway POST `/api/refresh_token` | Spotify OAuth refresh token → new access token |
| `playlist-table-handler` | API Gateway POST `/playlists/add`, `/playlists/remove` | Manages watched playlists in DynamoDB + S3 |
| `get-feedback-help` | API Gateway | User feedback → AWS SES email |

### Data Flow (fetch-new-song cron)

1. Reads active playlist IDs from S3 (`song-updater-resources/playlists.json`)
2. For each playlist, fetches tracks added in the last 24 hours from Spotify API (handles pagination)
3. Skips Spotify-owned playlists that reload 100% of their tracks (anti-spam)
4. Writes new tracks to `SongTrackMapper` DynamoDB table with a 24-hour TTL
5. Queries `NotificationTracker` table for devices whose `preferredNotificationTime` matches current UTC hour
6. Sends APN push notifications via a separate notification service endpoint

### DynamoDB Tables

- **`NotificationTracker`** — Devices with push notification settings; GSI: `preferredNotificationTimeIndex` on `preferredNotificationTime`
- **`WatchedPlaylists`** — Playlists being monitored with a watch counter (multiple users can watch the same playlist)
- **`SongTrackMapper`** — Tracks added in the last 24 hours; GSI: `playlistId-index` on `playlistId`; items auto-expire via TTL

QA equivalents: `SongTrackMapperQA`, `WatchedPlaylistsQA`.

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

## Key Implementation Details

- **`fetch-new-song`** serves dual purposes: as a cron job (CloudWatch) and as an HTTP endpoint (`GET /tracks/new`). The handler branches on `event.path === "/tracks/new"`.
- **`playlist-table-handler`** uses a reference-counting pattern — playlists are tracked with a watch counter so that removing one user's watch doesn't delete a playlist still watched by others. On last removal, all associated `SongTrackMapper` records are deleted.
- Spotify tokens for `fetch-new-song` use the **client credentials flow** (not user OAuth), so it can only access public playlists.
- The APN notification endpoint is hardcoded: `https://ho7won2i0j.execute-api.us-east-1.amazonaws.com/{prod|QA}/send-notifications`
- All lambdas target `us-east-1`.
- **API Gateway mapping template** is required for the token lambdas — the gateway must translate `application/x-www-form-urlencoded` POST bodies into `{ "data": { ... } }` JSON before passing to the lambda (see README.md for the VTL template).
