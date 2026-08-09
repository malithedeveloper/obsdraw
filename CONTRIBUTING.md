# Contributing to OBSdraw

Thank you for improving OBSdraw.

## Development setup

```bash
git clone https://github.com/malithedeveloper/obsdraw.git
cd obsdraw
npm run setup
npm run dev
```

Create a focused branch, keep changes small, and preserve compatibility with the editor and read-only viewer routes.

## Before opening a pull request

Run the complete verification suite:

```bash
npm run check
npm run audit
```

Add tests for authentication, protocol validation, history compaction, storage paths, range requests, or remote-media security whenever those areas change. Do not commit `.env.local`, credentials, generated board data, build output, or dependency directories.

## Style and behavior

- Keep all source code, UI text, comments, commits, and documentation in English.
- Prefer shared helpers over route-specific copies.
- Reject invalid input at trust boundaries and keep resource limits explicit.
- Preserve transparent viewer rendering and read-only viewer permissions.
- Document new environment variables in `.env.example` and `docs/CONFIGURATION.md`.

## License

By contributing, you agree that your contribution is licensed under AGPL-3.0-only, as described in [LICENSE](LICENSE).
