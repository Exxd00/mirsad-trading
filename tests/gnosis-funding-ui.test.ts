import { describe, expect, it, vi } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { encodeFunctionData, erc20Abi, keccak256, stringToHex, type Hex } from 'viem';
import { assertGnosisFundingReservationFresh, gnosisFundingUIDigest, parseGnosisFundingAuditUI, parseGnosisFundingAttemptResultUI,
  parseGnosisFundingReservationUI } from '../src/lib/wallet/gnosis-funding-ui';
import { fundingDigest } from '../src/lib/wallet/gnosis-funding-service';
import { emptyFundingFence, fundingAt, fundingOwner, fundingReservation, fundingResolved } from './fixtures/gnosis-funding-ui';
import type { GnosisFundingReservation } from '../src/lib/wallet/gnosis-funding-attempts';
import { FundingReviewAvailability } from '../src/components/WalletFundingReview';

function rehash(r: GnosisFundingReservation) {
  const { digest: _r, ...review } = r.review; r.review.digest = keccak256(stringToHex(JSON.stringify(review)));
  r.freshProof.reviewDigest = r.review.digest; const { digest: _p, ...proof } = r.freshProof; r.freshProof.digest = fundingDigest(proof);
  Object.assign(r.attempt, { reviewDigest: r.review.digest, proofDigest: r.freshProof.digest });
  const a = r.attempt; a.snapshotDigest = fundingDigest({ id: a.id, owner: a.owner, phase: a.phase, reviewDigest: a.reviewDigest,
    proofDigest: a.proofDigest, issuedAt: a.issuedAt, expiresAt: a.expiresAt, review: r.review, freshProof: r.freshProof, transaction: r.transaction });
}
describe('owner funding browser DTO validation (recorded quote, synthetic proof only)', () => {
  it('explains a missing or expired review without rendering financial controls or issuing a request',async()=>{
    const fetcher=vi.spyOn(globalThis,'fetch').mockImplementation(()=>{throw new Error('No automatic request from availability messaging');});
    try{
      const r=await fundingReservation();
      const missing=renderToStaticMarkup(createElement(FundingReviewAvailability,{audit:{review:null,status:'blocked'},fresh:false}));
      expect(missing).toContain('لم يتوفر عرض تمويل صالح');expect(missing).toContain('لا يظهر مربع مراجعة المبلغ والرسوم');
      const expired=renderToStaticMarkup(createElement(FundingReviewAvailability,{audit:{review:r.review,status:'reviewable'},fresh:false}));
      expect(expired).toContain('انتهت صلاحية عرض التمويل');expect(expired).toContain('معطّلة');
      expect(missing+expired).not.toMatch(/<(?:input|button)\b/);
      expect(renderToStaticMarkup(createElement(FundingReviewAvailability,{audit:{review:r.review,status:'reviewable'},fresh:true}))).toBe('');
      expect(fetcher).not.toHaveBeenCalled();
    }finally{fetcher.mockRestore();}
  });
  it.each(['approve', 'fund'] as const)('accepts a server-compatible %s snapshot and strips outer CSRF metadata', async phase => {
    const r = await fundingReservation(phase), parsed = parseGnosisFundingReservationUI({ ...r, csrfToken: 'never-forwarded' }, fundingOwner, phase);
    expect(parsed).toEqual(r); expect(parsed).not.toHaveProperty('csrfToken');
    expect(gnosisFundingUIDigest({ b: 2, a: 1 })).toBe(fundingDigest({ a: 1, b: 2 }));
    expect(() => assertGnosisFundingReservationFresh(parsed!, fundingAt + 14)).not.toThrow();
    expect(() => assertGnosisFundingReservationFresh(parsed!, fundingAt + 15)).toThrow('wallet_gnosis_funding_stale');
  });
  it('normalizes arbitrary JSON property order without weakening the review digest', async () => {
    const r = await fundingReservation(), reorder = (v: unknown): unknown => Array.isArray(v) ? v.map(reorder) : v && typeof v === 'object'
      ? Object.fromEntries(Object.entries(v).reverse().map(([k, x]) => [k, reorder(x)])) : v;
    expect(parseGnosisFundingReservationUI(reorder(r), fundingOwner, 'fund')).toEqual(r);
  });
  it('refuses a legacy history identity even when the entire owner request is consistently rehashed', async () => {
    const r = await fundingReservation();
    expect(parseGnosisFundingReservationUI(r, fundingOwner, 'fund')).toEqual(r);
    r.freshProof.history.identity = 'gnosis-reference:v1:' + 'a'.repeat(64);
    rehash(r);
    expect(parseGnosisFundingReservationUI(r, fundingOwner, 'fund')).toBeNull();
  });
  it('rejects account, phase, fresh-proof, transaction and unknown-field changes', async () => {
    const r = await fundingReservation();
    expect(parseGnosisFundingReservationUI(r, '0x' + 'b'.repeat(40), 'fund')).toBeNull();
    expect(parseGnosisFundingReservationUI(r, fundingOwner, 'approve')).toBeNull();
    for (const mutate of [(x: GnosisFundingReservation) => { x.freshProof.sourceBalanceRaw = '0'; },
      (x: GnosisFundingReservation) => { x.attempt.snapshotDigest = ('0x' + 'c'.repeat(64)) as Hex; },
      (x: GnosisFundingReservation) => { Object.assign(x.transaction, { gas: '0xffffff' }); },
      (x: GnosisFundingReservation) => { x.transaction.value = '0x1' as '0x0'; }]) {
      const changed = structuredClone(r); mutate(changed); expect(parseGnosisFundingReservationUI(changed, fundingOwner, 'fund')).toBeNull();
    }
  });
  it('reconstructs finite approval instead of trusting a self-consistent unlimited review', async () => {
    const r = await fundingReservation('approve'); r.review.approval.amountRaw = ((1n << 256n) - 1n).toString();
    r.review.approval.data = encodeFunctionData({ abi: erc20Abi, functionName: 'approve', args: [r.review.approval.spender, (1n << 256n) - 1n] });
    r.transaction.data = r.review.approval.data; rehash(r);
    expect(parseGnosisFundingReservationUI(r, fundingOwner, 'approve')).toBeNull();
  });
  it('rejects self-consistently rehashed calldata, chain, backing or history changes', async () => {
    for (const mutate of [(r: GnosisFundingReservation) => { r.review.transaction.data = (r.review.transaction.data + '00') as Hex; r.transaction.data = r.review.transaction.data; },
      (r: GnosisFundingReservation) => { r.review.approval.spender = '0x' + 'b'.repeat(40) as Hex; },
      (r: GnosisFundingReservation) => { r.freshProof.history.count = 999 as 1000; },
      (r: GnosisFundingReservation) => { r.freshProof.expiresAt += 1; r.attempt.expiresAt += 1; }]) {
      const r = await fundingReservation(); mutate(r); rehash(r); expect(parseGnosisFundingReservationUI(r, fundingOwner, 'fund')).toBeNull();
    }
  });
  it('accepts dated blocked audits but never allows owner review without proof and a free fence', async () => {
    const r = await fundingReservation(), audit = { version: 1, owner: fundingOwner, sourceChainId: 1, destinationChainId: 100,
      status: 'reviewable', readAt: fundingAt, expiresAt: r.review.expiresAt, review: r.review, freshProof: r.freshProof,
      blockers: [], executionApproved: false, ownerReviewAllowed: true, unverified: ['destination-gas-arrival'], fence: emptyFundingFence() };
    expect(parseGnosisFundingAuditUI(audit, fundingOwner)?.ownerReviewAllowed).toBe(true);
    expect(parseGnosisFundingAuditUI({ ...audit, freshProof: null }, fundingOwner)).toBeNull();
    expect(parseGnosisFundingAuditUI({ ...audit, fence: { ...audit.fence, blocked: true } }, fundingOwner)).toBeNull();
    expect(parseGnosisFundingAuditUI({ ...audit, status: 'blocked', expiresAt: fundingAt, freshProof: null, ownerReviewAllowed: false,
      blockers: ['wallet_gnosis_funding_history_required'] }, fundingOwner)?.status).toBe('blocked');
    const failed={...audit,status:'blocked',expiresAt:fundingAt,review:null,freshProof:null,ownerReviewAllowed:false,
      blockers:['wallet_gnosis_funding_route_unavailable','wallet_gnosis_funding_route_step_id_mismatch']};
    expect(parseGnosisFundingAuditUI(failed,fundingOwner)?.blockers).toEqual(failed.blockers);
    expect(parseGnosisFundingAuditUI({...failed,ownerReviewAllowed:true},fundingOwner)).toBeNull();
  });
  it('requires canonical receipt resolution and coherent durable fences', async () => {
    const r = await fundingReservation(), done = fundingResolved(r);
    expect(parseGnosisFundingAttemptResultUI(done, fundingOwner)).toEqual(done);
    expect(parseGnosisFundingAttemptResultUI({ fence: emptyFundingFence(), csrfToken: 'stripped' }, fundingOwner)).toEqual({ attempt: null, fence: emptyFundingFence() });
    expect(parseGnosisFundingAttemptResultUI({ ...done, attempt: { ...done.attempt, resolution: null } }, fundingOwner)).toBeNull();
    expect(parseGnosisFundingAttemptResultUI({ ...done, fence: emptyFundingFence() }, fundingOwner)).toBeNull();
    expect(parseGnosisFundingAttemptResultUI(done, '0x' + 'd'.repeat(40))).toBeNull();
  });
  it('requires the documented narrow resolved block DTO and explicit unsent proof', async () => {
    const r = await fundingReservation(), done = fundingResolved(r);
    const full = { ...done, attempt: { ...done.attempt, resolution: { ...done.attempt.resolution!,
      receiptBlock: { ...done.attempt.resolution!.receiptBlock, parentHash: r.freshProof.sourceBlock.parentHash },
      finalizedBlock: { ...done.attempt.resolution!.finalizedBlock, parentHash: r.freshProof.sourceBlock.parentHash } } } };
    expect(parseGnosisFundingAttemptResultUI(full, fundingOwner)).toBeNull();
    expect(parseGnosisFundingAttemptResultUI(done, fundingOwner)).toEqual(done);
    const unsent = { attempt: { ...r.attempt, status: 'owner-cancelled-unsent' }, fence: emptyFundingFence() };
    expect(parseGnosisFundingAttemptResultUI(unsent, fundingOwner)).toBeNull();
    expect(parseGnosisFundingAttemptResultUI({ ...unsent, attempt: { ...unsent.attempt, unsentAttestationProof: r.freshProof.digest } }, fundingOwner)?.attempt?.status)
      .toBe('owner-cancelled-unsent');
  });
  it('rejects rehashed nonce reversal and fractional or missing pending nonce in the actual proof DTO', async () => {
    for (const nonce of [-1, 1, 2.1, undefined]) {
      const r = await fundingReservation(); Object.assign(r.freshProof, { sourcePendingNonce: nonce }); rehash(r);
      expect(parseGnosisFundingReservationUI(r, fundingOwner, 'fund')).toBeNull();
    }
  });
});
