import { describe,it,expect } from 'vitest';
import { selectRuleVersions,assessSelectedRule,mergeProfileContext,type RuntimeRule } from '@reg/domain';
import { compileReview } from './index.js';
import { readyTestDocument,testExtraction } from '../test/fixture.js';
const base=compileReview(readyTestDocument(),testExtraction(),'2026-09-18').rules[0]!.rule;
const row=(version:number,date:string,extra:Partial<RuntimeRule>={}):RuntimeRule=>({
  rule:{...base,version,reviewStatus:'reviewed'},effectiveOn:date,scope:'company',cancelled:false,...extra});
describe('published rule lifecycle',()=>{
  it('retains V1 until V2 activation and shows V2 separately without tasks',()=>{
    const rows=[row(1,'2026-09-01'),row(2,'2027-09-01')];
    expect(selectRuleVersions(rows,'2026-09-18').map(s=>[s.rule.version,s.timeState])).toEqual([[1,'active'],[2,'upcoming']]);
    expect(selectRuleVersions(rows,'2027-09-01').map(s=>[s.rule.version,s.timeState])).toEqual([[2,'active']]);
    expect(assessSelectedRule(selectRuleVersions(rows,'2026-09-18')[1]!,{profileVersion:1,revenuePreviousYear:121,hasEpaymentAcceptanceAgreementAsOf2026_01_01:true,isExcludedProduct:false},'2026-09-18').actions).toEqual([]);
  });
  it('shows the next future date and lets a higher revision supersede another on that date',()=>{
    const sameDate=[row(1,'2026-09-01'),row(2,'2027-09-01'),row(3,'2027-09-01')];
    expect(selectRuleVersions(sameDate,'2026-09-18').map(s=>[s.rule.version,s.timeState])).toEqual([[1,'active'],[3,'upcoming']]);
    const chronological=[row(1,'2026-09-01'),row(2,'2027-09-01'),row(3,'2028-09-01')];
    expect(selectRuleVersions(chronological,'2026-09-18').map(s=>[s.rule.version,s.timeState])).toEqual([[1,'active'],[2,'upcoming']]);
  });
  it('never resurrects V1 when V2 is cancelled or expired',()=>{
    expect(selectRuleVersions([row(1,'2026-01-01'),row(2,'2026-09-01',{cancelled:true})],'2026-09-18').map(s=>s.timeState)).toEqual(['cancelled']);
    const expired=row(2,'2026-09-01');expired.rule={...expired.rule,validTo:'2026-09-18'};
    expect(selectRuleVersions([row(1,'2026-01-01'),expired],'2026-09-18').map(s=>s.timeState)).toEqual(['ended']);
    expired.rule={...expired.rule,validTo:null,legalStatus:'expired'};
    expect(selectRuleVersions([row(1,'2026-01-01'),expired],'2026-09-18').map(s=>s.timeState)).toEqual(['ended']);
  });
  it('does not reuse facts from a different outlet',()=>{
    const before={tradeObjectId:'A',tradeObjectRevenuePreviousYear:123,paymentLocationHasInternet:false};
    expect(mergeProfileContext(before,{tradeObjectId:'B'})).toEqual({
      tradeObjectId:'B',tradeObjectRevenuePreviousYear:null,paymentLocationHasInternet:null});
    expect(mergeProfileContext(before,{tradeObjectId:'B',paymentLocationHasInternet:false}).paymentLocationHasInternet).toBe(false);
    expect(mergeProfileContext(before,{tradeObjectId:'A'})).toEqual(before);
  });
  it('requires bound trade-object context and distinguishes false from missing',()=>{
    const selected={...row(1,'2026-09-01',{scope:'trade_object'}),timeState:'active' as const};
    expect(assessSelectedRule(selected,{profileVersion:1},'2026-09-18').missingFields).toEqual(['tradeObjectId']);
    const profile={profileVersion:1,tradeObjectId:'store-1',revenuePreviousYear:121,hasEpaymentAcceptanceAgreementAsOf2026_01_01:false,isExcludedProduct:false};
    expect(assessSelectedRule(selected,profile,'2026-09-18').verdict).toBe('not_applicable');
    expect(assessSelectedRule(selected,{...profile,hasEpaymentAcceptanceAgreementAsOf2026_01_01:null},'2026-09-18').verdict).toBe('needs_info');
  });
});
