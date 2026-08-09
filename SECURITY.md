# Security policy

## Supported versions

Security fixes are applied to the latest release and the `main` branch.

## Report a vulnerability

Do not open a public issue for a suspected vulnerability. Use [GitHub's private vulnerability reporting form](https://github.com/malithedeveloper/obsdraw/security/advisories/new) and include:

- the affected commit or release;
- reproduction steps or a proof of concept;
- the expected impact;
- any suggested mitigation.

Please avoid accessing data that is not yours, disrupting a hosted instance, or publishing details before a fix is available. A report will be acknowledged as soon as practical, and remediation status will be shared through the private advisory.

## Deployment responsibilities

OBSdraw protects editor and viewer roles separately, but operators remain responsible for TLS, secret rotation, storage credentials, network boundaries, backups, and dependency updates. Viewer URLs contain a read-only secret and must not be published. `TRUST_PROXY=1` is safe only when a trusted proxy overwrites forwarded headers and the application port is not directly exposed.
