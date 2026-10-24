# Implementation Plan: Ludo Friends Offline and Multiplayer

## Overview
Make the existing Ludo Friends client feel like a purposeful game product rather than a generic dashboard, while making offline play dependable and multiplayer recovery observable. The server-authoritative online game remains the source of truth; offline mode uses the existing deterministic game-core rules with local bot opponents and persists an in-progress match in the browser.

## Architecture Decisions
- Keep game rules in `packages/game-core`; do not duplicate movement or win logic in UI components.
- Add offline persistence at the web boundary using `localStorage`, with versioned JSON and safe validation before restore.
- Keep Socket.IO multiplayer behavior server-authoritative and improve reconnect/error states rather than adding speculative client mutations.
- Replace broad decorative styling with a compact game-room visual system: warm paper-like surfaces, dark board contrast, restrained color, clear hierarchy, and responsive layouts.

## Task List

### Phase 1: Foundations
- [ ] Task 1: Add tested offline session persistence helpers.
- [ ] Task 2: Restore and resume offline games from local storage.

### Checkpoint: Offline play
- [ ] Game starts without a server.
- [ ] Refreshing an active offline game restores it.
- [ ] Offline persistence tests and workspace checks pass.

### Phase 2: Multiplayer reliability
- [ ] Task 3: Harden multiplayer connection and session recovery states.
- [ ] Task 4: Add multiplayer room-flow regression coverage.

### Checkpoint: Multiplayer
- [ ] Create/join/leave/reconnect flows remain server-authoritative.
- [ ] Connection failures are actionable and do not silently look like success.

### Phase 3: UI finish
- [ ] Task 5: Replace generic visual treatment with a responsive game-room design.
- [ ] Task 6: Add browser-level verification for offline and multiplayer entry flows.

### Checkpoint: Complete
- [ ] Full tests, typecheck, build, and format checks pass.
- [ ] Browser smoke test has no console errors.
- [ ] Changes are reviewed and committed in atomic slices.

## Risks and Mitigations
| Risk | Impact | Mitigation |
| --- | --- | --- |
| Persisted data shape changes | Medium | Version the payload and discard invalid/unknown snapshots safely. |
| Socket reconnect changes player identity | High | Use the existing session ID and preserve room/player mapping server-side. |
| Offline and online rule drift | High | Reuse `@ludo/game-core` in both modes. |
| Large single-page client file | Medium | Keep helpers small and avoid adding another state framework in this pass. |

## Open Questions
- None blocking the first implementation pass.
