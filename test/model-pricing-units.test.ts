import { test } from "node:test";
import assert from "node:assert/strict";

/**
 * Pricing is kept per TOKEN; models.dev quotes per MILLION.
 *
 * MEASURED on a real session (`command code goat` / `deepseek/deepseek-v4.1-flash`, 892.6M input
 * tokens, 99% cached): the raw models.dev numbers were multiplied by TOKENS, so a session worth ~$4.71
 * was reported as **$15,239,168** — off by exactly 1e6. The picker badge read `150000/M` for the same
 * reason. models.dev's own scale is confirmable from a model whose price is public knowledge:
 * `claude-sonnet-4-5` is `{input: 3, output: 15}`, i.e. $3/$15 per million, not per token.
 *
 * The normalisation happens once, at the models.dev boundary, so `costUsd` and the badge both keep the
 * convention they already had.
 */
const perToken = (perMillion: number): number => perMillion / 1e6;

const sessionCost = (
  p: { prompt: number; completion: number; cacheRead?: number },
  inTok: number,
  outTok: number,
  cachedIn: number,
): number => {
  const cached = Math.min(cachedIn, inTok);
  return (
    (inTok - cached) * p.prompt + outTok * p.completion + cached * (p.cacheRead ?? p.prompt * 0.1)
  );
};

test("a per-million quote is normalised to per-token (#cost)", () => {
  assert.equal(perToken(3), 3e-6, "claude-sonnet-4-5 input is $3/M");
  assert.equal(perToken(15), 15e-6);
  assert.equal(perToken(0.15), 1.5e-7, "deepseek-v4.1-flash input is $0.15/M");
});

test("the reported session is dollars, not millions of dollars (#cost)", () => {
  const p = { prompt: perToken(0.15), completion: perToken(0.6), cacheRead: perToken(0.003) };
  const cost = sessionCost(p, 892.6e6, 1.2e6, 892.6e6 * 0.99);
  assert.ok(cost > 1 && cost < 50, `must land in single-digit dollars, got $${cost}`);
  assert.ok(Math.abs(cost - 4.71) < 0.5, `~$4.71 expected, got $${cost.toFixed(2)}`);
});

test("the same usage at the RAW quote is the 1e6 error the operator saw (#cost)", () => {
  // this pins the DIAGNOSIS, not just the fix: feeding per-million values to the per-token formula is
  // what produced $15,239,168. If someone removes the /1e6, this test states the symptom.
  const raw = { prompt: 0.15, completion: 0.6 };
  const wrong = sessionCost(raw, 892.6e6, 1.2e6, 892.6e6 * 0.99);
  assert.ok(wrong > 1e7, `the bug produced tens of millions, got ${wrong}`);
  assert.ok(Math.abs(wrong / 1e6 - 4.71) > 10, "so the fix must be a clean 1e6, not an approximation");
});

test("the badge reads dollars per million, not raw per-token (#cost)", () => {
  const badge = (p?: number) =>
    p === undefined ? "" : `${p * 1e6 >= 10 ? Math.round(p * 1e6) : +(p * 1e6).toFixed(1)}/M`;
  assert.equal(badge(perToken(2.5)), "2.5/M", "not 2500000/M — the bug's signature");
  assert.equal(badge(perToken(0.6)), "0.6/M");
  assert.equal(badge(perToken(3)), "3/M", "`+x.toFixed(1)` drops a trailing .0");
  assert.equal(badge(perToken(15)), "15/M");
});

test("a published cache-read rate is used instead of the 10% guess (#cost)", () => {
  /**
   * Claude's published cache-read is exactly 10% of its input rate ($0.30 vs $3.00 per million), so
   * that pair cannot distinguish "used the rate" from "used the guess" — a fixture that agrees with the
   * fallback proves nothing. DeepSeek v4.1 Flash does distinguish them: $0.003/M read against
   * $0.15/M input is 2%, not 10%.
   */
  const usage = [1_000_000, 1000, 900_000] as const;
  const p = { prompt: perToken(0.15), completion: perToken(0.6), cacheRead: perToken(0.003) };
  const withRate = sessionCost(p, ...usage);
  const guessed = sessionCost({ prompt: p.prompt, completion: p.completion }, ...usage);
  assert.ok(withRate < guessed, `the published rate must win: $${withRate.toFixed(4)} vs $${guessed.toFixed(4)}`);
  assert.ok(Math.abs(withRate - 0.0183) < 0.001, `got $${withRate.toFixed(5)}`);
  // and when a provider publishes no cache rate, the guess still applies
  // 1000 cached tokens at 10% of a $1/M rate is $0.0001
  assert.ok(Math.abs(sessionCost({ prompt: 1e-6, completion: 2e-6 }, 1000, 0, 1000) - 1e-4) < 1e-9);
});
