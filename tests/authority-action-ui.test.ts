import { afterEach, describe, expect, it, vi } from 'vitest';
import { authorityPreparation, authorityReview, hash } from './fixtures/wallet-authority';
import { authorityReservation } from './fixtures/authority-owner-action';
import { authorityDigest, createAuthorityCloseReview, createAuthorityReview } from '../src/lib/wallet/authority';
import { getAddress, type Hex } from 'viem';
import { randomUUID } from 'node:crypto';
import { authorityActionUIDigest, authorityActionUISnapshot, assertAuthorityActionReservationFresh,
  parseAuthorityActionFenceUI, parseAuthorityActionReservationUI, parseAuthorityActionStateUI,
  runReservedAuthorityAction, type AuthorityActionAttemptView, type AuthorityActionReservation } from '../src/lib/wallet/authority-action-ui';
import { AuthorityActionError, AuthorityOwnerRejectedError, isAuthorityOwnerRejectedError, isUnsentAuthorityActionError } from '../src/lib/wallet/metamask';

afterEach(() => vi.useRealTimers());
function rehash(r: AuthorityActionReservation) { r.attempt.payloadDigest = authorityActionUIDigest(r.payload); r.attempt.snapshotDigest = authorityActionUISnapshot(r); return r; }
function envelope(a: AuthorityActionAttemptView) { return { actionAttempt: a, actionFence: { blocked: true, active: a, last: a } }; }
describe('authority owner-action wire validation (isolated, no chain requests)', () => {
  it('validates the actual server snapshot including pending nonce/block and captured CAS revision', async () => {
    const review = authorityReview(), r = authorityReservation(review, 'bootstrap');
    expect(await parseAuthorityActionReservationUI({ actionReservation: r }, review, 'bootstrap', undefined, 1)).toEqual(r);
    expect(await parseAuthorityActionReservationUI(r, review, 'bootstrap', undefined, 2)).toBeNull();
    r.attempt.ownerPendingNonce++;
    expect(await parseAuthorityActionReservationUI(r, review, 'bootstrap')).toBeNull();
  });
  it.each(['calldata', 'extra-gas', 'owner', 'phase', 'block', 'review'] as const)('rejects substituted %s even when outer digests are recalculated', async mutation => {
    const review = authorityReview(), r = authorityReservation(review, 'bootstrap');
    if (r.payload.kind !== 'calls') throw new Error('fixture');
    if (mutation === 'calldata') r.payload.calls[0].data = '0xdeadbeef';
    if (mutation === 'extra-gas') Object.assign(r.payload, { gas: '0xffff' });
    if (mutation === 'owner') r.attempt.owner = '0x1111111111111111111111111111111111111111';
    if (mutation === 'phase') r.attempt.phase = 'close';
    if (mutation === 'block') r.attempt.sourceBlock.timestamp = r.attempt.issuedAt + 1;
    if (mutation === 'review') r.review.allowances[0].finiteAmount = '101';
    expect(await parseAuthorityActionReservationUI(rehash(r), review, 'bootstrap')).toBeNull();
  });
  it('clones the reservation and expected review before SDK await', async () => {
    const review = authorityReview(), r = authorityReservation(review, 'bootstrap'), expected = structuredClone(r);
    const pending = parseAuthorityActionReservationUI(r, review, 'bootstrap');
    review.owner = '0x1111111111111111111111111111111111111111'; r.attempt.ownerPendingNonce++;
    expect(await pending).toEqual(expected);
  });
  it('matches server ASCII canonicalization and accepts maximum legitimate close payloads without cloning duplicate envelope reviews', async () => {
    expect(authorityActionUIDigest({ a: 1, Z: 2, z: { B: 1, b: 2 }, A: 3 })).toBe(authorityDigest({ a: 1, Z: 2, z: { B: 1, b: 2 }, A: 3 }));
    const now = Math.floor(Date.now() / 1000), p = authorityPreparation(now), example = p.terms.markets[0];
    p.terms.markets = Array.from({ length: 30 }, (_, i) => ({ ...example, baseToken: getAddress('0x' + (100 + i).toString(16).padStart(40, '0')) }));
    p.allowances = [p.allowances[0], ...p.terms.markets.map(m => ({ token: m.baseToken, current: '0', finiteAmount: m.maxBaseTotal }))];
    const review = createAuthorityReview({ id: randomUUID(), profileRevision: 1, preparation: p, now });
    const uids = Array.from({ length: 128 }, (_, i) => ('0x' + i.toString(16).padStart(64, '0') + review.owner.slice(2).toLowerCase() + 'ffffffff') as Hex);
    const close = createAuthorityCloseReview(review, { block: review.block, outstandingUids: uids, blockers: [], fenceReference: 'isolated-max' }, now);
    const r = authorityReservation(review, 'close', close);
    const response = { actionReservation: r, review, close, duplicatedPublicData: 'x'.repeat(250000) };
    expect(await parseAuthorityActionReservationUI(response, review, 'close', close)).toEqual(r);
  });
  it('permits fresh closing cleanup after the opening review expires, with its own exact deadline', async () => {
    const now = Math.floor(Date.now() / 1000), review = authorityReview(now);
    vi.useFakeTimers(); vi.setSystemTime((now + 601) * 1000);
    const close = createAuthorityCloseReview(review, { block: { number: '101', hash, timestamp: now + 601 }, outstandingUids: [], blockers: [], fenceReference: 'isolated' }, now + 601);
    const r = authorityReservation(review, 'close', close);
    expect(await parseAuthorityActionReservationUI(r, review, 'close', close)).toEqual(r);
    expect(() => assertAuthorityActionReservationFresh(r)).not.toThrow();
    vi.setSystemTime(close.reviewExpiresAt * 1000);
    expect(() => assertAuthorityActionReservationFresh(r)).toThrow('expired');
    expect(parseAuthorityActionFenceUI({ blocked: true, active: r.attempt, last: r.attempt })?.blocked).toBe(true);
  });
  it('keeps reserved/unknown fences blocked beyond expiry; terminal status requires actual receipt-shaped evidence', () => {
    const a = authorityReservation(authorityReview(), 'bootstrap').attempt;
    for (const status of ['reserved', 'unknown'] as const) {
      const current = { ...a, status };
      expect(parseAuthorityActionFenceUI({ blocked: true, active: current, last: current })?.blocked).toBe(true);
    }
    expect(parseAuthorityActionFenceUI({ blocked: false, active: a, last: a })).toBeNull();
    const confirmed = { ...a, status: 'confirmed' as const, resolution: { outcome: 'confirmed' as const, transactionHashes: [hash], evidenceDigest: hash, resolvedAt: a.issuedAt } };
    expect(parseAuthorityActionStateUI({ actionAttempt: confirmed, actionFence: { blocked: false, active: null, last: confirmed } })).toBeNull();
    confirmed.transactionHashes = [hash];
    expect(parseAuthorityActionStateUI({ actionAttempt: confirmed, actionFence: { blocked: false, active: null, last: confirmed } })?.actionAttempt?.status).toBe('confirmed');
  });
});

describe('authority reservation → wallet → metadata lifecycle', () => {
  function fixture() {
    const review = authorityReview(), r = authorityReservation(review, 'bootstrap'); let mounted = true;
    const post = vi.fn(async (body: Record<string, unknown>): Promise<unknown> => body.action === 'reserve-action'
      ? { actionReservation: r } : envelope({ ...r.attempt, status: 'references-recorded', callBatchIds: ['0x1234'] }));
    const ownerAction = vi.fn(async () => ({ kind: 'batch' as const, value: '0x1234' }));
    return { review, r, post, ownerAction, unmount: () => { mounted = false; }, run: () => runReservedAuthorityAction({
      review, phase: 'bootstrap', expectedRevision: 1, post, ownerAction, isCurrent: () => mounted,
      isUnsent: isUnsentAuthorityActionError, isRejected: isAuthorityOwnerRejectedError }) };
  }
  it('reserves before the prompt, and records a valid returned batch against captured identity after unmount', async () => {
    const f = fixture(); f.ownerAction.mockImplementation(async () => { expect(f.post.mock.calls[0][0].action).toBe('reserve-action'); f.unmount(); return { kind: 'batch', value: '0x1234' }; });
    await expect(f.run()).resolves.toEqual({ kind: 'batch', value: '0x1234' });
    expect(f.post.mock.calls.map(([b]) => b.action)).toEqual(['reserve-action', 'record-action']);
    expect(f.post.mock.calls[1][0]).toEqual({ action: 'record-action', attemptId: f.r.attempt.id, snapshotDigest: f.r.attempt.snapshotDigest, callBatchIds: ['0x1234'] });
  });
  it('does not prompt from an unmounted view after reserve; explicitly cancels its locally known unsent attempt', async () => {
    const f = fixture(); f.unmount(); await expect(f.run()).rejects.toThrow('view_changed');
    expect(f.ownerAction).not.toHaveBeenCalled();
    expect(f.post.mock.calls.map(([b]) => b.action)).toEqual(['reserve-action', 'cancel-unsent-action']);
  });
  it.each(['unsent', 'rejected', 'unknown', 'forged-unsent'] as const)('classifies %s without turning provider ambiguity into a retry', async kind => {
    const f = fixture(); const error = kind === 'unsent' ? new AuthorityActionError('changed-account', false) : kind === 'rejected'
      ? new AuthorityOwnerRejectedError() : Object.assign(new Error('provider'), { requestIssued: kind === 'forged-unsent' ? false : true, code: '4001' });
    f.ownerAction.mockRejectedValue(error); await expect(f.run()).rejects.toBe(error);
    expect(f.post.mock.calls[1][0].action).toBe(kind === 'unsent' ? 'cancel-unsent-action' : kind === 'rejected' ? 'reject-action' : 'unknown-action');
    expect(f.ownerAction).toHaveBeenCalledTimes(1);
  });
  it('does not resend or discard a known batch when metadata persistence fails', async () => {
    const f = fixture(); f.post.mockImplementation(async body => { if (body.action === 'reserve-action') return { actionReservation: f.r }; throw new Error('HTTP401'); });
    await expect(f.run()).rejects.toThrow('HTTP401');
    expect(f.ownerAction).toHaveBeenCalledTimes(1);
    expect(f.post.mock.calls[1][0]).toMatchObject({ action: 'record-action', callBatchIds: ['0x1234'] });
  });
  it('never invokes the owner callback when the server reservation fails binding', async () => {
    const f = fixture(); f.r.attempt.snapshotDigest = hash;
    await expect(f.run()).rejects.toThrow('reservation_invalid'); expect(f.ownerAction).not.toHaveBeenCalled();
  });
});
