import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ResetCreditService, type ResetTarget } from '../lib/runtime/reset-credits.js';
import { removeWithRetry } from './helpers/remove-with-retry.js';

let dir: string;
beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), 'reset-exhaustion-')); });
afterEach(async () => { await removeWithRetry(dir, { recursive: true, force: true }); });
const target = (id: string): ResetTarget => ({ key: id, accountId: id });
const start = 1_800_000_000_000;
function fixture() {
 let now = start;
 let allowed: boolean | null = true;
 let credits = 1;
 const payload = (t: ResetTarget, permission = allowed) => ({ accountId: t.accountId,
  ordinaryUsageAllowed: permission, rateLimitResetCredits: { availableCount: credits },
  rateLimits: { planType: 'pro', primary: { usedPercent: 100, resetsAt: now / 1000 + 3600 }, secondary: {} } });
 const read = vi.fn(async (t: ResetTarget) => payload(t));
 const consume = vi.fn(async () => { allowed = true; credits -= 1; return { outcome: 'reset' }; });
 const io = { read, consume, now: () => now };
 const service = new ResetCreditService(join(dir, 'state.json'), io);
 return { service, read, consume, payload, io,
  advance: (ms = 100) => { now += ms; }, exhaust: () => { allowed = false; },
  setCredits: (value: number) => { credits = value; },
  evidence: (id = 'a') => ({ ...target(id), observedAt: now }),
 };
}

describe('new exhaustion after a healthy native reset check', () => {
 it('rechecks all targets and resets immediately on fresh exhaustion evidence', async () => {
  const f = fixture(); await f.service.setPolicy('last-resort');
  await f.service.automatic([target('a'), target('b')]);
  f.advance(); f.exhaust();
  expect(await f.service.automatic([target('a'), target('b')], [f.evidence()])).toEqual({ key: 'a', outcome: 'reset' });
  expect(f.read.mock.calls.map(([t]) => t.key)).toEqual(['a', 'b', 'a', 'b', 'a']);
  expect(f.consume).toHaveBeenCalledTimes(1);
 });

 it.each([
  ['same observation', { observedAt: start }],
  ['future observation', { observedAt: start + 101 }],
  ['stale observation', { observedAt: start - 60_001 }],
  ['non-finite observation', { observedAt: Number.NaN }],
  ['infinite observation', { observedAt: Number.POSITIVE_INFINITY }],
  ['wrong scope', { key: 'other' }],
  ['wrong native account', { accountId: 'other' }],
 ])('does not bypass for %s', async (_name, patch) => {
  const f = fixture(); await f.service.setPolicy('last-resort'); await f.service.automatic([target('a')]);
  f.advance(); f.exhaust();
  expect(await f.service.automatic([target('a')], [{ ...f.evidence(), ...patch }])).toBeNull();
  expect(f.read).toHaveBeenCalledTimes(1); expect(f.consume).not.toHaveBeenCalled();
 });

 it('requires a recorded healthy native baseline', async () => {
  const f = fixture(); f.exhaust(); f.setCredits(0); await f.service.setPolicy('last-resort');
  await f.service.automatic([target('a')]); f.advance(); f.setCredits(1);
  expect(await f.service.automatic([target('a')], [f.evidence()])).toBeNull();
  expect(f.read).toHaveBeenCalledTimes(1); expect(f.consume).not.toHaveBeenCalled();
 });

 it('uses evidence only to reread, and never rereads the same evidence twice', async () => {
  const f = fixture(); await f.service.setPolicy('last-resort'); await f.service.automatic([target('a')]);
  f.advance(); const evidence = [f.evidence()];
  expect(await f.service.automatic([target('a')], evidence)).toBeNull();
  expect(f.read).toHaveBeenCalledTimes(2); expect(f.consume).not.toHaveBeenCalled();
  f.advance(); f.exhaust();
  expect(await f.service.automatic([target('a')], evidence)).toBeNull();
  expect(f.read).toHaveBeenCalledTimes(2); expect(f.consume).not.toHaveBeenCalled();
 });

 it.each(['healthy', 'unknown', 'failed'] as const)('still refuses spending when another fresh target read is %s', async kind => {
  const f = fixture(); const targets = [target('a'), target('b')];
  await f.service.setPolicy('last-resort'); await f.service.automatic(targets); f.advance(); f.exhaust();
  f.read.mockImplementation(async t => {
   if (t.key !== 'b') return f.payload(t);
   if (kind === 'failed') throw Error('synthetic failed native read');
   return f.payload(t, kind === 'healthy' ? true : null);
  });
  expect(await f.service.automatic(targets, [f.evidence()])).toBeNull();
  expect(f.read).toHaveBeenCalledTimes(4); expect(f.consume).not.toHaveBeenCalled();
 });

 it('preserves the five-minute redemption guard even with newer exhaustion', async () => {
  const f = fixture(); f.exhaust(); await f.service.setPolicy('last-resort');
  await f.service.automatic([target('a')]); f.advance(); f.exhaust(); f.setCredits(1);
  expect(await f.service.automatic([target('a')], [f.evidence()])).toBeNull();
  expect(f.consume).toHaveBeenCalledTimes(1); expect(f.read).toHaveBeenCalledTimes(2);
 });

 it('preserves manual policy with newer exhaustion', async () => {
  const f = fixture(); await f.service.setPolicy('last-resort'); await f.service.automatic([target('a')]);
  await f.service.setPolicy('manual'); f.advance(); f.exhaust();
  expect(await f.service.automatic([target('a')], [f.evidence()])).toBeNull();
  expect(f.read).toHaveBeenCalledTimes(1); expect(f.consume).not.toHaveBeenCalled();
 });

 it('coalesces concurrent new evidence across services into one redemption', async () => {
  const f = fixture(); await f.service.setPolicy('last-resort'); await f.service.automatic([target('a')]);
  f.advance(); f.exhaust(); const other = new ResetCreditService(join(dir, 'state.json'), f.io);
  await Promise.all([f.service.automatic([target('a')], [f.evidence()]), other.automatic([target('a')], [f.evidence()])]);
  expect(f.consume).toHaveBeenCalledTimes(1); expect(f.read).toHaveBeenCalledTimes(3);
 });

 it.each([true, false])('reevaluates a joined negative check only for newer evidence: %s', async newer => {
  const f = fixture(); await f.service.setPolicy('last-resort');
  let release!: () => void; let entered!: () => void;
  const gate = new Promise<void>(r => { release = r; }); const started = new Promise<void>(r => { entered = r; });
  let parked = false;
  f.read.mockImplementation(async t => {
   if (t.key === 'b' && !parked) { parked = true; entered(); await gate; }
   return f.payload(t, t.key === 'b' ? false : undefined);
  });
  const targets = [target('a'), target('b')];
  const first = f.service.automatic(targets); await started;
  // Let the already-resolved first target be timestamped before the later observation.
  await Promise.resolve(); await Promise.resolve();
  f.advance(); f.exhaust();
  const second = f.service.automatic(targets, [{ ...f.evidence(), observedAt: newer ? f.io.now() : start }]);
  release(); expect(await first).toBeNull();
  expect(await second).toEqual(newer ? { key: 'a', outcome: 'reset' } : null);
  expect(f.consume).toHaveBeenCalledTimes(newer ? 1 : 0);
  expect(f.read).toHaveBeenCalledTimes(newer ? 5 : 2);
 });
});
