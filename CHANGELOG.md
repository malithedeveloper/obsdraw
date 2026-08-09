# Changelog

All notable changes to OBSdraw are documented here.

## 1.0.0 - 2026-08-09

- Rebranded the application and repository as OBSdraw.
- Replaced the legacy setup with an idempotent one-command setup flow.
- Added Docker Compose, Heroku app metadata, CI, Dependabot, and deployment documentation.
- Separated session and websocket token formats to prevent role confusion.
- Protected media upload, lookup, retrieval, proxy, and resolution routes by role.
- Added SSRF-resistant DNS and connection validation for remote media.
- Rejected SVG and unknown binary uploads; added signature, size, and pixel limits.
- Added websocket origin checks, message schemas, payload limits, and rate limits.
- Consolidated history, media, R2, and WebDAV helpers and removed legacy endpoints.
- Converted the complete interface and project documentation to English.
- Optimized the project logo and added AGPL-3.0 attribution for Whitebophir.
