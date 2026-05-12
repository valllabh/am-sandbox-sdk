# am-sandbox-sdk

Shared SDK for agent-manager sandbox runners. Imported by `am-pi-agent` and `am-opencode-agent` as a git submodule (mounted at `src/sdk/` in each runner).

## Modules

- `sdk` — `ManagerClient`: `bootstrap`, `loadSkills`, `loadSkillAsset`, `getSecret`, `pushLogs`, `uploadArtifact`, `heartbeat`, `complete`, `fail`.
- `skills` — `buildSkillsContext`, `stripFrontmatter` for assembling the Level-2 SKILL.md disclosure block ahead of the operator prompt.
- `monitor` — `startMonitor` returns a `Monitor` with `appendTranscript`, `markActivity`, `getTranscript`, `stop`, `finalize`. `finalize` uploads `transcript.ndjson`, `system-prompt.md`, `payload.json`, `result.json`/`error.json`, plus every regular file under workdir (capped at 2 MB per file) as run artifacts. Watchdog fires `onStall` when the child has been silent for `stallMs` (default 180 s).

## Why one submodule and not an npm package

Avoiding npm publish + version drift. The runners pin the SDK by submodule SHA; CodeBuild fetches the submodule on each build. Bumping the SDK is a `git submodule update --remote && git commit` in the runner repo.
