# cursor-poc Validation

**Date**: 2026-10-10
**Spec**: `.specs/features/cursor-poc/spec.md`
**Diff range**: `d5f3718..2e7cf02` (branch `cursor-poc`; 39 files, +5591/-41)
**Verifier**: independent sub-agent (author ≠ verifier)
**Re-verification**: iteration 1 of max 3 — Fix 1 applied in `2e7cf02`

---

## Task Completion

| Task | Status  | Notes |
| ---- | ------- | ----- |
| T1   | ✅ Done | Provider union + 2 exhaustive Records |
| T2   | ✅ Done | `HABBLAUD_CURSOR` flag |
| T3   | ✅ Done | `CursorLive` contract |
| T4   | ✅ Done | Normalizer + tool translation |
| T5   | ✅ Done | `CursorSource` |
| T6   | ✅ Done | `server/cursor/http.ts` |
| T7   | ✅ Done | Route in `server/http/app.ts` |
| T8   | ✅ Done | Wiring in `server/index.ts` |
| T9   | ✅ Done | Transcript parser/inspector |
| T10  | ✅ Done | CLI base + `transcript` |
| T11  | ✅ Done | `poc-hook.mjs` capture |
| T12  | ✅ Done | `install`/`uninstall`/`report` |
| T13  | ✅ Done | `PermissionRegistry` cursor guard |
| T14  | ✅ Done | `hook.mjs` decision/observation |
| T15  | ✅ Done | `cursor-install.ts` |
| T16  | ✅ Done | `decision` harness |
| T17  | ✅ Done | tsconfig + npm scripts |
| T18  | ✅ Done | Runbook |

All 18 tasks marked `✅ Done`; dependent ordering in Phase Execution Map matches `Depends on` (cross-check table in `tasks.md:678-701`).

---

## Spec-Anchored Acceptance Criteria

### P1: Ingest mínimo e agente Cursor no escritório (CPOC-01..10)

| Criterion (WHEN X THEN Y) | Spec-defined outcome | `file:line` + assertion | Result |
| -------------------------- | -------------------- | ----------------------- | ------ |
| CPOC-01 sessionStart → create/update `provider:"cursor"` agent in room of `workspace_roots[0]`, `200 {ok:true}` | agent kind main, provider cursor, sessionId conversation_id, roomId `/projetos/demo`, 200 {ok:true} | `server/sources/cursor/source.test.ts:80` - `expect(ctx.hook(ev('sessionStart'))).toBe(true)` + `:81-90` `toMatchObject({provider:'cursor', roomId:'/projetos/demo'})`; route `server/http/http.test.ts:296-298` - `expect(res.status).toBe(200)` / `toEqual({ ok: true })` | ✅ PASS |
| CPOC-02 preToolUse with `tool_name` → translated `Activity` + `working` | status working, activity tool `Bash`, text truthy | `server/sources/cursor/source.test.ts:92-96` - `expect(a.status).toBe('working')`, `toMatchObject({tool:'Bash'})`; translation `server/sources/cursor/rollout.test.ts:81-83` | ✅ PASS |
| CPOC-03 stop → `idle` | status idle | `server/sources/cursor/source.test.ts:98-99` - `expect(ctx.agent()?.status).toBe('idle')`; `rollout.test.ts:106` `statusBorder('stop')` → `{status:'idle'}` | ✅ PASS |
| CPOC-04 sessionEnd → remove/offline | status offline + "encerrou" notice | `server/sources/cursor/source.test.ts:101-103` - `expect(...status).toBe('offline')`, notice includes 'encerrou' | ✅ PASS |
| CPOC-05 body without `event`/`hook_event_name` → `400` | HttpError 400 / HTTP 400 | `server/cursor/http.test.ts:52-54` - `toThrow(HttpError)` for `{}`,`{event:'x'}`,`{event:{}}`,`[]`; `server/http/http.test.ts:359-362` - `expect(r.status).toBe(400)` | ✅ PASS |
| CPOC-06 `HABBLAUD_CURSOR=0` → `200 {ok:false}`, no Office change | cursor flag false; `{ok:false}`; `health.cursorEvents:false` | `server/config.test.ts:23-25` - `expect(cfg({HABBLAUD_CURSOR:'0'}).cursor).toBe(false)` (and `'off'`); `server/http/http.test.ts:312-314` - `toEqual({ok:false})`, `cursorEvents===false`; wiring `server/index.ts:107` | ✅ PASS |
| CPOC-07 Claude/Codex behavior unchanged on cursor events | no external accounts; alias map regression-free | `server/sources/cursor/source.test.ts:200-204` - `expect(ctx.accounts.entries()).toEqual([])`, `entriesOf('cursor')===['cursor']`; `server/accounts/detect.test.ts:20-23` (claude/codex aliases); `client/src/ui/provider.test.ts:18-24` | ✅ PASS |
| CPOC-08 unknown `hook_event_name` → `200 {ok:false}`, no throw | route responds `200 {ok:false}` | source mechanism `server/sources/cursor/source.test.ts:137-139` - `expect(ctx.hook({hook_event_name:'desconhecido'...})).toBe(false)`; **route outcome** `server/cursor/http.test.ts:69-72` - `serve({ applyHookEvent: () => false })` then `toMatchObject({ status: 200, json: { ok: false } })` (Fix 1). Both branches pinned: live→true asserts `{ok:true}` at `:57-62` | ✅ PASS |
| CPOC-09 accept cursor events only from local connection | 403 for non-local Host / non-loopback | `server/http/http.test.ts:348-356` - `expect(r.status, host).toBe(403)` (Host `habblaud.lan`, `192.168.0.10`); `:372` `skipIf(!LAN)` loopback-address case | ✅ PASS |
| CPOC-10 beforeShellExecution → `shell`; afterShellExecution → `working` | statuses shell / working | `server/sources/cursor/source.test.ts:125-131` - `toBe('shell')` then `toBe('working')`; `rollout.test.ts:117-118` | ✅ PASS |

### P2: Harness de cobertura de eventos de hook (CPOC-11..16)

| Criterion (WHEN X THEN Y) | Spec-defined outcome | `file:line` + assertion | Result |
| -------------------------- | -------------------- | ----------------------- | ------ |
| CPOC-11 install writes/merges `~/.cursor/hooks.json` (or `--project`), preserves existing, backup | foreign hook kept, backup file equals original | `server/test/cursor-poc.test.ts:208-214` - `preToolUse[0]` toEqual `{command:'outro-hook'}`, backups length 1 and content equals `other`; `server/test/cursor-install.test.ts:201-206` | ✅ PASS |
| CPOC-12 hook stdin event → append JSON line `{ts, dir, event}` to capture dir | one line with string ts, dir, event fields | `server/test/cursor-poc.test.ts:141-147` - JSON.parse line, `typeof line.ts==='string'`, `line.dir==='/proj'`, `line.event.hook_event_name==='preToolUse'` | ✅ PASS |
| CPOC-13 `report` over capture dir → Markdown matrix "evento → dispara? (contagem) → campos" | table header + per-event rows with counts | `server/test/cursor-poc.test.ts:261-265` - contains `\| Evento \| Dispara? \| Contagem \| Campos \|`, `\| preToolUse \| sim \| 2 \|`, `\| sessionStart \| não \| 0 \|` | ✅ PASS |
| CPOC-14 `hooks.json` absent → create `{"version":1,"hooks":{}}` without failing | version 1, all events present | `server/test/cursor-poc.test.ts:189-194` - `saved.version===1`, names contain preToolUse/sessionStart; `cursor-install.test.ts:54-62`, `:181-190` | ✅ PASS |
| CPOC-15 empty capture dir → explanatory message, exit 0 | exit 0 + explanatory text | `server/test/cursor-poc.test.ts:271-272` - `expect(r.status).toBe(0)`, `/nenhum evento/i` | ✅ PASS |
| CPOC-16 `uninstall` removes only harness hooks, preserves others | foreign entries intact, harness entries gone | `server/test/cursor-poc.test.ts:243-245` - `preToolUse` toEqual foreign only, `ourEntries===[]`; `cursor-install.test.ts:120-129` | ✅ PASS |

### P2: Harness de descoberta do transcript (CPOC-17..23)

| Criterion (WHEN X THEN Y) | Spec-defined outcome | `file:line` + assertion | Result |
| -------------------------- | -------------------- | ----------------------- | ------ |
| CPOC-17 hook with `transcript_path` → copy value + stdin dump to capture dir | path in `transcripts.txt`, raw stdin dump file | `server/test/cursor-poc.test.ts:156-159` - `toContain(path)`, `readFileSync(dump)===raw` | ✅ PASS |
| CPOC-18 `transcript --path` → classify json/jsonl/sqlite/opaco + keys/fields with counts | format + key counts | `server/test/cursor-poc.test.ts:67-92`; `server/sources/cursor/transcript.test.ts:42-56`, `:71-98` | ✅ PASS |
| CPOC-19 JSONL → line count, distinct roles, tool-call fields present | lines 4, roles [user,assistant,tool], hasToolCalls true | `server/sources/cursor/transcript.test.ts:62-68` - `lines===4`, `roles` toEqual, `hasToolCalls===true`; CLI `cursor-poc.test.ts:68-73` | ✅ PASS |
| CPOC-20 SQLite → tables + counts without external binary | tables [messages:3, stats:1] via `node:sqlite` | `server/sources/cursor/transcript.test.ts:93-97` - `tables` toEqual; CLI `cursor-poc.test.ts:88-91` | ✅ PASS |
| CPOC-21 missing path → clear message, exit ≠ 0 | exit ≠ 0 + "não encontrado" | `server/test/cursor-poc.test.ts:103-105` - `expect(r.status).not.toBe(0)`, `/não encontrado/i` | ✅ PASS |
| CPOC-22 parser skeleton maps recognized lines to `Activity`, never throws for unknown formats | opaco no throw; unknown line → empty | `server/sources/cursor/transcript.test.ts:54-55` (opaco), `:124-129` - unknown/non-JSON → `{activities:[]}`; `:100-106` | ✅ PASS |
| CPOC-23 known fixture line → `Activity` with `kind` and `label` | kind `read`/`search`, label defined | `server/sources/cursor/transcript.test.ts:112-114` - `toMatchObject({kind:'read', label:'Lendo app.ts'})`; `:119-121` | ✅ PASS |

### P3: Hook de decisão e harness de bloqueio (CPOC-24..29)

| Criterion (WHEN X THEN Y) | Spec-defined outcome | `file:line` + assertion | Result |
| -------------------------- | -------------------- | ----------------------- | ------ |
| CPOC-24 decision hook input → register at `POST /api/permissions` with `provider:"cursor"` + await `/wait` | provider cursor, tool/title translated | `server/test/cursor-hook.test.ts:141-143` - `live.calls...hook_event_name` and `detail(id)` `toMatchObject({provider:'cursor', tool:'Shell', title:'Bash(npm test)'})`; registry `server/permissions/cursor.test.ts:70-74`; `registry.ts:284-293` | ✅ PASS |
| CPOC-25 allow/deny → hook prints `{"permission":"allow"\|"deny"}` exit 0 | exact stdout string incl. `user_message` on deny | `server/test/cursor-hook.test.ts:149-150` - `stdout==='{"permission":"allow"}\n'`; `:159-160` - `toEqual({permission:'deny', user_message:'Recusado...use pnpm'})`; `:266-268` `decisionOutput` | ✅ PASS |
| CPOC-26 timeout or Habblaud down → exit 0, no decision | exit 0, stdout empty | `server/test/cursor-hook.test.ts:211-214` - `toMatchObject({code:0, stdout:''})` after timeout; `:193-204` (down/unknown conv) | ✅ PASS |
| CPOC-27 hook never throws unhandled / never kills the session | invalid stdin & unusable events → exit 0, no output | `server/test/cursor-hook.test.ts:220-224` - `toMatchObject({code:0, stdout:''})` for `''`,`não é json`,`[]`,`{hook_event_name:5}`,unknown; `hook.mjs:245` "Nunca lança" | ✅ PASS |
| CPOC-28 harness with stub holding `N` s → measures ~`N` s + applies decision | measured ≥0.9 and <4 s, applied allow | `server/test/cursor-poc.test.ts:286-292` - `status===0`, `aplicou a decisão: {"permission":"allow"}`, measured in range | ✅ PASS |
| CPOC-29 `N` exceeds safe limit → report observed safe limit | exit ≠ 0 + "Limite seguro observado: 1 s" + "excede o limite seguro" | `server/test/cursor-poc.test.ts:303-307` - `expect(r.status).not.toBe(0)`, `/Limite seguro observado: 1 s/`, `/excede o limite seguro/` | ✅ PASS |

**Status**: ✅ All 29 ACs covered — every criterion maps to a `file:line` assertion that targets the spec-defined outcome.
No **Spec-precision gaps** were flagged: the spec is precise for all 29 ACs.

**Process/artifact gap (not code, recommendation only)**: `spec.md:209` still reads `Coverage: 29 total, 0 mapped to tasks, 29 unmapped ⚠️` and the Requirement Traceability table (`spec.md:175-203`) still lists every AC as `Implementing`, although `tasks.md` maps all 29 ACs. `spec.md` was not modified by the Verifier.

---

## Discrimination Sensor

**Scratch isolation**: dedicated `git worktree` at `/tmp/opencode/verif-cursor2` (detached HEAD `2e7cf02`, `node_modules` symlinked). The real worktree was never mutated; each mutation reverted with `git checkout -- <file>`; worktree removed with `git worktree remove --force`. Real-tree `git status --porcelain` was the baseline (only untracked `validation.md`) before and after (verified).

**Sensor depth**: P0-full (security-adjacent surface: local-only guard, permission decisions, hook surface) — 13 behavior-level mutations injected (≥5 required).

| Mutation | File:line | Description | Killed? |
| -------- | --------- | ----------- | ------- |
| M1  | `server/sources/cursor/rollout.ts:125` | `beforeShellExecution` border → `working` (removes `shell`) | ✅ Killed (2 failures: `rollout`/`source`) |
| M2  | `server/sources/cursor/source.ts:211` | Remove out-of-order guard `if (at < t.statusAt) return;` | ✅ Killed (`source.test.ts` out-of-order, 1 failure) |
| M3  | `server/permissions/registry.ts:169` | `hookOnly` no longer recognizes `cursor` | ✅ Killed (`cursor.test.ts`, 3 failures) |
| M4  | `mod/habblaud-cursor/hook.mjs:195` | `decisionOutput` returns `deny` for `allow` | ✅ Killed (`cursor-hook.test.ts`, 4 failures) |
| M5  | `mod/habblaud-cursor/hook.mjs:283` | Timeout path returns `allow` instead of `undefined` | ✅ Killed (`cursor-hook.test.ts`, 1 failure) |
| M6  | `server/cursor/http.ts:27` | `parseCursorEvent` drops `hook_event_name` validation | ✅ Killed (`cursor/http.test.ts`, 2 failures) |
| M7  | `server/sources/cursor/rollout.ts:93` | Disable `Shell`→`describeCommand`/`Bash` branch | ✅ Killed (2 failures: `rollout`/`source`) |
| M8  | `server/http/app.ts:355` | Route drops loopback/Host guard | ✅ Killed (`http.test.ts`, 2 failures) |
| M9  | `server/sources/cursor/source.ts:161` | `sessionEnd` no longer closes the agent | ✅ Killed (`source.test.ts` sessionEnd, 1 failure) |
| M10 | `server/cursor/http.ts:39` | Remove the `applyHookEvent` call, force `ok = true` | ✅ Killed (`cursor/http.test.ts`, 3 failures incl. call-recording) |
| M11 | `server/cursor/http.ts:39` | `=== true` → `!== false` | ⚪ Survived (equivalent under the `boolean` contract of `CursorLive.applyHookEvent`; no test can distinguish — not a gap) |
| M12 | `server/cursor/http.ts:37-44` | Call `applyHookEvent` **then force `ok = true`** | ✅ **Killed** (`server/cursor/http.test.ts:71`; also full suite 1 failed / 100 passed) — **was the prior surviving mutant; Fix 1 closed it** |
| M13 | `scripts/cursor-poc.ts:201` | `planInstall` keeps our entries (breaks idempotency / duplicates) | ✅ Killed (`cursor-poc.test.ts:219`, 1 failure) |

**Result**: 12 killed / 1 survived (M11 equivalent) → **PASS ✅** — no genuine gap.

**Fix 1 confirmation (adversarial)**: `server/cursor/http.test.ts:69-72` supplies a **present, non-throwing** `live` that returns `false` and asserts `toMatchObject({ status: 200, json: { ok: false } })`. Running M12 (`ok = true` forced after the call) fails exactly that test (`- {ok:false} + {ok:true}` at line 71) and the full 101-file suite (1 failed / 100 passed). The `{ok:true}` branch remains pinned independently at `:57-62`, so the test is not vacuous. The gap is closed.

---

## Interactive UAT Results

Not performed — backend/infrastructure feature (hooks, CLI harness, ingest route). The live Cursor-runtime parts are explicitly out of scope for this environment (`spec.md:42`) and are covered by the runbook `docs/analise/08-runbook-poc-cursor.md`.

---

## Code Quality

| Principle | Status |
| --------- | ------ |
| Minimum code | ✅ (Fix 1 added 5 lines: one focused test) |
| Surgical changes | ✅ (39 files additive; only `Provider` ripple touched existing Records) |
| No scope creep | ✅ (no `client/` redesign; out-of-scope list respected) |
| Matches patterns | ✅ (mirrors Codex: `sources/codex/*`, `codex/http.ts`, `hook.mjs`, `codex-install.ts`) |
| Spec-anchored outcome check (asserted values match spec) | ✅ (CPOC-08 route outcome now asserted) |
| Per-layer Coverage Expectation met (domain 1:1 ACs; routes happy+edge+error) | ✅ (route happy, no-source, no-apply, throw, 400/413/403/405/415) |
| Every test maps to a spec requirement — no unclaimed tests | ✅ (each new `*.test.ts` header cites its CPOC ACs) |
| Documented guidelines followed | ✅ — none dedicated (`AGENTS.md`/`CONTRIBUTING.md` absent); repo convention (colocated vitest + `server/test/` host scripts with fake HOME) followed per `tasks.md:19` |

---

## Edge Cases

- [x] Body exceeds size limit → `413`, event not applied: `server/cursor/http.test.ts:84-85`; `server/http/http.test.ts:363-365` (`calls` length 0).
- [x] `workspace_roots` absent/empty → `cwd` or default room: `server/sources/cursor/source.test.ts:106-116` (`/projetos/api`, then `cursor`).
- [x] Two out-of-order events same `conversation_id` → newest edge wins: `server/sources/cursor/source.test.ts:149-165` (older `stop` ignored, newer `stop` applied).
- [x] Hook stdin invalid JSON → exit 0, nothing on stdout: `server/test/cursor-poc.test.ts:162-167`; `server/test/cursor-hook.test.ts:220-224`.
- [x] Installer run twice → idempotent (no duplicate hooks, backup preserved): `server/test/cursor-poc.test.ts:216-220`; `server/test/cursor-install.test.ts:208-213`.

All five spec edge cases are handled and asserted.

---

## Gate Check

- **Gate command**: `npm run typecheck && npm test && npm run build` (`tasks.md:41`)
- **Result**: 1224 passed, 0 failed, 2 skipped — exit 0 (green)
- **Test files**: 101 passed
- **Test count before feature** (`d5f3718`): 91 files / 1116 passed / 2 skipped (1118)
- **Test count after feature** (`2e7cf02`): 101 files / 1224 passed / 2 skipped (1226)
- **Delta**: +10 files, +108 passed, +2 skipped unchanged (Fix 1 added the +1 test over the prior `baeeab8` count of 1223)
- **Skipped tests**: `server/test/statusline.test.ts` (`skipIf(!SH)`, Windows-only) and `server/messages/codex.test.ts` (`runIf(win32)`) — both pre-existing, outside the feature diff; no skips introduced by cursor-poc.
- **Failures**: none
- **Test Integrity Check**: no silent deletions — net +108 tests; no weakened assertions observed.

---

## Fix Plans (if issues found)

### Fix 1: Route does not assert `{ok:false}` for a present `live` returning `false` (CPOC-08) — ✅ RESOLVED

- **Prior root cause**: `handleCursorEvent` forwarded `deps.live.applyHookEvent(...) === true` into `{ok}` (`server/cursor/http.ts:39`), but no route test supplied a present `live` returning `false`; sensor mutant M12 survived.
- **Resolution** (`2e7cf02`): `server/cursor/http.test.ts:69-72` adds a case with `serve({ applyHookEvent: () => false })` asserting `200 {ok:false}`.
- **Verification**: sensor M12 re-injected and **KILLED** (targeted + full suite); gate green (+1 test). No residual gap.

### Recommendation 2 (housekeeping, non-code): refresh spec traceability — OPEN

- `spec.md:209` and the traceability table (`spec.md:175-203`) are stale (`0 mapped to tasks, 29 unmapped`, all `Implementing`) although `tasks.md` maps all 29 ACs. Recommendation only; `spec.md` intentionally not modified by the Verifier.
- **Priority**: Minor (planning artifact).

---

## Requirement Traceability Update

Recommendation only (Verifier is read-only; `spec.md` untouched).

| Requirement | Previous Status | Recommended New Status |
| ----------- | --------------- | ---------------------- |
| CPOC-01..29 | Implementing | ✅ Verified |

---

## Summary

**Overall**: ✅ Ready

**Spec-anchored check**: 29/29 ACs matched the spec-defined outcome; 0 gaps; 0 spec-precision gaps.
**Sensor**: 12/13 mutations killed (M11 equivalent mutant; M12 now killed — Fix 1 confirmed).
**Gate**: 1224 passed, 0 failed, 2 skipped (exit 0).

**What works**: Full P1 ingest + Office presence from simulated hooks, P2 hook-coverage harness, P2 transcript discovery harness, and P3 decision-blocking hook/harness are implemented, mirrored on the Codex precedent, and covered at the source/hook/CLI/route layers. The prior CPOC-08 route-level gap is closed. Build gate green (+108 tests over baseline) with no regressions or silent deletions.

**Issues found**: none blocking. Minor housekeeping: stale traceability in `spec.md` (Recommendation 2).

**Next steps**: Mark `CPOC-01..29` Verified in `spec.md` (recommendation only). No code fix required.

---

*Lessons (§10)*: this is a clean PASS — no surviving non-equivalent mutant (M12 killed; M11 is an equivalent mutant under the `boolean` contract, so it is not a weak-test signal), no spec-precision gap, no failed/uncovered AC, no `SPEC_DEVIATION`. Per [lessons.md](lessons.md) a clean run records nothing. The lessons store (`.specs/lessons.json` / `.specs/LESSONS.md`) does not exist in this fork and the Verifier mandate limited writes to this report; no lessons were invented.
