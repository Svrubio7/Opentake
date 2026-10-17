# Contributing to OpenTake

Thanks for helping. OpenTake is a small app; issues and pull requests are welcome.

## Before you start

- Bugs and ideas go in [GitHub Issues](https://github.com/Svrubio7/Opentake/issues). Use the templates so we can reproduce the problem.
- For a larger change, open an issue first so we can agree on the approach before you write it.

## Working on the code

```sh
git lfs install
npm ci
npm run dev
```

Before you open a pull request:

```sh
npm run typecheck
npm test
```

The code is split by module under `src/renderer/modules/` (audio, camera, record, teleprompter), with the Electron main process in `src/main/` and types shared across processes in `src/shared/`. Pure logic lives in `*-core.ts` files with unit tests next to them; keep new logic there so it can be tested without a window.

## Rules of the house

- Everything stays on the user's computer. No network calls, no telemetry, no accounts. A pull request that sends user data anywhere will not be merged.
- No new runtime dependency without a reason in the pull request, and its licence must be compatible with MIT (add it to `THIRD_PARTY_NOTICES.md`).
- Keep copy plain and short.

By contributing you agree that your work is released under the project's MIT licence.
