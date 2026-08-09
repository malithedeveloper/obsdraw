# Deployment guide

This guide covers local production, Docker, Heroku, and a generic reverse proxy. Complete the [security checklist](#production-security-checklist) before exposing OBSdraw to the internet.

## Local production server

```bash
npm run setup
npm run build
npm start
```

The server listens on `0.0.0.0:3000` by default. Override it with `HOST` and `PORT`. Local board history is written atomically under `LOCAL_STORE_DIR`; uploaded media is kept in memory unless R2 or WebDAV is configured.

## Docker Compose

```bash
npm run setup -- --skip-install
docker compose up --build -d
docker compose logs -f obsdraw
```

The compose file mounts a named volume at `/app/server-data`. To upgrade:

```bash
git pull --ff-only
docker compose up --build -d
```

`docker compose down` keeps the named volume. Do not use `docker compose down --volumes` unless deleting the saved board is intentional.

## Heroku deploy button

Use the deploy button in the main README. Heroku generates `ACCESS_KEY`, `VIEW_KEY`, `AUTH_SECRET`, and `SOCKET_AUTH_SECRET`, and sets `TRUST_PROXY=1`.

After deployment, add R2 or WebDAV config vars. Heroku dyno files are ephemeral and are not suitable for durable history or media storage.

Keep the app at one web dyno. OBSdraw stores live Socket.IO room state in process and does not include a cross-dyno message adapter.

## Manual Heroku deployment

Install and authenticate the [Heroku CLI](https://devcenter.heroku.com/articles/heroku-cli), then run:

```bash
heroku create your-obsdraw-app
heroku config:set ACCESS_KEY="$(openssl rand -hex 24)"
heroku config:set VIEW_KEY="$(openssl rand -hex 24)"
heroku config:set AUTH_SECRET="$(openssl rand -hex 48)"
heroku config:set SOCKET_AUTH_SECRET="$(openssl rand -hex 48)"
heroku config:set TRUST_PROXY=1
git push heroku main
```

Retrieve the generated values when configuring clients:

```bash
heroku config:get ACCESS_KEY
heroku config:get VIEW_KEY
```

The editor URL is `https://your-obsdraw-app.herokuapp.com/`. The OBS URL is `https://your-obsdraw-app.herokuapp.com/view/<VIEW_KEY>`.

### Cloudflare R2 on Heroku

Create an R2 bucket and a token limited to object read/write access for that bucket. Set:

```bash
heroku config:set \
  R2_ACCOUNT_ID="your-account-id" \
  R2_ACCESS_KEY_ID="your-access-key-id" \
  R2_SECRET_ACCESS_KEY="your-secret-access-key" \
  R2_BUCKET_NAME="your-private-bucket"
```

The bucket does not need to be public. OBSdraw serves authenticated media through `/api/media/:id`.

### WebDAV on Heroku

```bash
heroku config:set \
  WEBDAV_URL="https://dav.example.com" \
  WEBDAV_USERNAME="your-user" \
  WEBDAV_PASSWORD="your-password" \
  WEBDAV_BASE_PATH="/obsdraw"
```

R2 takes precedence when both R2 and WebDAV are configured.

## Reverse proxy

OBSdraw needs normal HTTP forwarding and WebSocket upgrade support. A minimal Nginx location is:

```nginx
location / {
    proxy_pass http://127.0.0.1:3000;
    proxy_http_version 1.1;
    proxy_set_header Host $host;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;
    proxy_set_header Upgrade $http_upgrade;
    proxy_set_header Connection "upgrade";
}
```

Set `TRUST_PROXY=1` only when direct access to the application port is blocked and the proxy overwrites forwarded headers. Set `ALLOWED_ORIGINS=https://draw.example.com` if needed. Multiple origins are comma-separated.

## Health checks

`GET /api/health` returns HTTP 200 with a small JSON response. It does not expose secrets or storage credentials.

## Production security checklist

- Use HTTPS for every editor and viewer connection.
- Use four different, randomly generated secrets.
- Keep the viewer URL out of screenshots, logs, and public OBS scene collections.
- Configure durable R2 or WebDAV storage on ephemeral hosts.
- Restrict R2 or WebDAV credentials to the smallest required scope.
- Restrict inbound traffic to the reverse proxy before enabling `TRUST_PROXY`.
- Set `ALLOWED_ORIGINS` when serving through a nonstandard proxy topology.
- Run `npm run check` and `npm run audit` before deploying changes.
- Keep GitHub Dependabot and CI enabled.
