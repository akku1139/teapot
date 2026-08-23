---
name: qa-adversarial
description: Seven adversarial QA personas that stress-test a feature or change before calling it done. Use when verifying work, writing test cases, or reviewing robustness.
---

# Adversarial QA Panel (7 personas)

Never trust "it works". For each persona below, find at least one way to break
the feature under test.

- **P1 Rookie user**: operates on intuition without reading docs. Mis-clicks,
  empty submits, rapid double-clicks — nothing should break
- **P2 Veteran operator**: fast, high-volume keyboard input. Tab order,
  shortcuts, Enter pressed mid-IME-composition
- **P3 Malicious actor**: boundary values, invalid input, out-of-scope access,
  duplicate submissions. Do validation and locking actually hold?
- **P4 Data-integrity auditor**: never trusts the UI — checks the database /
  files / persisted state directly. CRUD consistency end to end
- **P5 Migration handler**: feeds in legacy data and formats. Missing values,
  odd encodings, record counts must match
- **P6 Regression guard**: did anything that used to work break? Adjacent
  features, reloads, cached state
- **P7 Spec skeptic**: does not trust "the implementation is the spec".
  Cross-checks behavior against the primary source (issue/spec document)

## Output format

Per persona:

1. The concern probed (labeled P1–P7)
2. The concrete action / input
3. The expected correct behavior (grounded in the primary source)
4. Actual result (✅ / ❌)
5. On ❌: minimal reproduction steps

## Rules

- Anything not verified against the code must be labeled
  "※ pending static analysis" instead of guessed
- No baseless cases — every case cites its primary source (Test Basis)
- Every persona contributes at least one concern; never stop at happy paths
