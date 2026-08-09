# Configuration reference

OBSdraw loads `.env.local` during local development and uses normal environment variables in production. Never commit `.env.local` or real credentials.

## Authentication

| Variable | Required | Default | Description |
| --- | --- | --- | --- |
| `ACCESS_KEY` | Yes | None | Plain editor sign-in key. |
| `ACCESS_KEY_HASH` | Alternative | None | SHA-256 hex digest of the editor key. Takes precedence over `ACCESS_KEY`. |
| `VIEW_KEY` | Yes | None | Plain read-only viewer key. |
| `VIEW_KEY_HASH` | Alternative | None | SHA-256 hex digest of the viewer key. Takes precedence over `VIEW_KEY`. |
| `AUTH_SECRET` | Yes | `ACCESS_KEY` | Signs HTTP-only editor sessions. Set a separate random value in production. |
| `SOCKET_AUTH_SECRET` | Yes | Other configured keys | Signs role-bound websocket tokens. Set a separate random value in production. |

Generate independent values with `openssl rand -hex 48`, or let `npm run setup` generate them. To store only a key digest:

```bash
printf '%s' 'your-key' | sha256sum
```

Copy only the 64-character digest into `ACCESS_KEY_HASH` or `VIEW_KEY_HASH`. The setup script uses plain local keys so it can print usable URLs.

## Core server settings

| Variable | Default | Description |
| --- | --- | --- |
| `HOST` | `0.0.0.0` | Listen address. |
| `PORT` | `3000` | Listen port. Heroku sets this automatically. |
| `BOARD_NAME` | `anonymous` | Namespace and storage filename for the single active board. |
| `LOCAL_STORE_DIR` | `./server-data` | Durable history directory when no remote backend is configured. |
| `NEXT_PUBLIC_WS_URL` | Same origin | Optional websocket server URL for split deployments. |
| `NEXT_PUBLIC_SOURCE_URL` | Project repository | Source-code link displayed to network users for AGPL compliance. |
| `TRUST_PROXY` | `0` | Trust forwarded client IP and protocol headers. Enable only behind a trusted proxy. |
| `ALLOWED_ORIGINS` | Same origin | Comma-separated extra origins allowed to open websocket connections. |

## Persistence

Backend priority is R2, then WebDAV, then local disk. A backend is selected only when all its required credentials exist.

### Cloudflare R2

| Variable | Required | Default | Description |
| --- | --- | --- | --- |
| `R2_ACCOUNT_ID` | Yes | None | Cloudflare account ID. |
| `R2_ACCESS_KEY_ID` | Yes | None | R2 token access key. |
| `R2_SECRET_ACCESS_KEY` | Yes | None | R2 token secret. |
| `R2_BUCKET_NAME` | Yes | None | Private bucket name. |
| `R2_ENDPOINT` | No | Cloudflare endpoint | S3-compatible endpoint override. |
| `R2_HISTORY_PREFIX` | No | `boards` | Object prefix for board snapshots. |
| `R2_MEDIA_PREFIX` | No | `media` | Object prefix for uploaded media. |

### WebDAV

| Variable | Required | Default | Description |
| --- | --- | --- | --- |
| `WEBDAV_URL` | Yes | None | WebDAV server base URL. |
| `WEBDAV_USERNAME` | Yes | None | WebDAV username. |
| `WEBDAV_PASSWORD` | Yes | None | WebDAV password. `WEBDAV_TOKEN` is also accepted. |
| `WEBDAV_BASE_PATH` | No | `/` | Directory used by OBSdraw. |
| `WEBDAV_BACKUPS` | No | `0` | Create timestamped history backups before replacement. |
| `WEBDAV_SPOOF_ORIGIN` | No | None | Advanced compatibility header override for unusual providers. |

## Media limits

| Variable | Default | Description |
| --- | --- | --- |
| `MEDIA_MAX_FILE_BYTES` | `20971520` | Maximum single upload or remote import, capped at 100 MB. |
| `MEDIA_MAX_INPUT_PIXELS` | `40000000` | Maximum decoded raster-image pixel count. |
| `MEDIA_MAX_BYTES` | `209715200` | Total in-memory media cache budget. |
| `MEDIA_TTL_MS` | `3600000` | In-memory media lifetime. |
| `MEDIA_REFRESH_ON_GET` | `0` | Refresh in-memory lifetime on access when set to `1`. |
| `MEDIA_COMPRESS` | `0` | Enable server-side JPEG/AVIF recompression when set to `1`. |
| `MEDIA_COMPRESS_FORMAT` | Original | Set to `webp` to convert eligible uploads. |
| `MEDIA_COMPRESS_QUALITY` | `82` | Compression quality from 35 to 95. |
| `MEDIA_PROXY_MAX_BYTES` | `52428800` | Maximum proxied response size. |
| `MEDIA_PROXY_ALLOW_HOSTS` | None | Comma-separated remote host allowlist. Empty permits public internet hosts. |
| `MEDIA_PROXY_ALLOW_PORTS` | `80,443` | Comma-separated allowed remote ports. |

Supported media types are PNG, JPEG, GIF, WebP, AVIF, MP4, and WebM. File signatures are verified. SVG and unknown binary content are rejected.

## History and rate limits

| Variable | Default | Description |
| --- | --- | --- |
| `MAX_HISTORY` | `5000` | Maximum compacted persisted events. |
| `PERSIST_FLUSH_MS` | `1500` | Maximum delay before pending events are persisted. |
| `PERSIST_FLUSH_EVENTS` | `100` | Pending event count that triggers an immediate flush. |
| `SNAPSHOT_CHUNK_SIZE` | `500` | Events per initial synchronization chunk. |
| `SOCKET_MAX_MESSAGE_BYTES` | `65536` | Maximum serialized websocket message size. |
| `SOCKET_RATE_LIMIT_MESSAGES` | `1500` | Messages allowed per socket window. |
| `SOCKET_RATE_LIMIT_BYTES` | `8388608` | Bytes allowed per socket window. |
| `SOCKET_RATE_LIMIT_WINDOW_MS` | `10000` | Websocket rate-limit window. |
| `SOCKET_MAX_CONNECTIONS_PER_IP` | `12` | Concurrent websocket connections per client IP. |
| `LOGIN_RATE_LIMIT_ATTEMPTS` | `20` | Sign-in attempts allowed per client window. |
| `LOGIN_RATE_LIMIT_WINDOW_MS` | `600000` | Sign-in rate-limit window. |

Raise limits conservatively. Protocol messages are additionally constrained by allowed fields, data depth, string lengths, and editor/viewer role.
