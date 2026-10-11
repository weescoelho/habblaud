# LESSONS - auto-maintained by scripts/lessons.py

> Machine-owned. Do NOT hand-edit. Changes are overwritten on the next `lessons.py` write.
> Canonical state lives in `.specs/lessons.json`. Edit lessons only via the script.
> promote_threshold=2 distinct features · window_days=45 · quarantine_threshold=2

## Confirmed (load these at Specify/Design)

Corroborated across multiple features. Safe to apply as guidance.

_none_

## Candidates (under observation - do NOT load as guidance yet)

Seen once or not yet corroborated. Tracked, not trusted.

### L-001 - Assert the exact rendered Activity text the design pins, not only that a substring of the argument appears
- signal: `surviving_mutant` · recurrence: 1 feature(s) · scope: `cursor/rollout` · harmful: 0
- features: cursor-transcript
- evidence: M12 (rollout.ts UpdateCurrentStep; rollout.test.ts:173-178) (cursor/rollout)
- last seen: 2026-10-11T17:34:38Z

### L-002 - Assert a derived timestamp precedence order (explicit value, then last seen, then fallback), not only that it is numeric
- signal: `surviving_mutant` · recurrence: 1 feature(s) · scope: `cursor/terminal` · harmful: 0
- features: cursor-transcript
- evidence: M18 (terminal.ts:113; terminal.test.ts:23) (cursor/terminal)
- last seen: 2026-10-11T17:34:38Z

## Quarantined (failed when applied - ignore)

A confirmed lesson that recurred alongside failure. Kept for the maintainer to review.

_none_
