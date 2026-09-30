import { describe,it,expect,vi } from 'vitest';
import { builtinFactDefinitions } from '@reg/domain';
import { materializeExtraction, extractRegulatoryDraft, assertExtractionLimits } from '@reg/llm';
import { prepareAutomaticReview, automaticReviewIssues, trustedOfficialUrl, compileReview, previewReview } from './index.js';
import { automaticFixture } from '../test/automatic-fixture.js';
const asOf='2026-09-18';
describe('S9.9 source-grounded automatic compilation',()=>{
  it('creates a new typed fact and compiles without an administrator',()=>{
    const f=automaticFixture(),p=prepareAutomaticReview(f.extraction,'synthetic-source',f.catalog,asOf);
    expect(p.issues).toEqual([]);expect(p.ready).toBe(true);expect(p.document.approvalMode).toBe('machine_validated');
    const c=compileReview(p.document,f.extraction,asOf);
    expect(c.rules).toHaveLength(1);expect(c.rules[0]!.rule.factModel?.requiredFacts).toHaveLength(2);
    expect(c.rules[0]!.rule.factModel?.definitions.some(d=>d.key===f.definition.key)).toBe(true);
    expect(f.catalog.some(d=>d.key===f.definition.key)).toBe(false);
  });
  it('keeps server-owned quotes and a deterministic rule identity',()=>{
    const f=automaticFixture(),a=prepareAutomaticReview(f.extraction,'same-source',f.catalog,asOf),b=prepareAutomaticReview(f.extraction,'same-source',f.catalog,asOf);
    expect(a.document.phases[0]!.ruleId).toBe(b.document.phases[0]!.ruleId);
    const c=compileReview(a.document,f.extraction,asOf);
    for(const e of c.rules[0]!.evidence)expect(e.quote).toBe(f.snapshot.segments[e.sourceSegmentIndex]!.text);
  });
  it('never accepts a lookalike official domain or manually supplied source',()=>{
    expect(trustedOfficialUrl('https://nalog.gov.ru.attacker.test/')).toBe(false);
    expect(trustedOfficialUrl('http://cbr.ru/')).toBe(false);
    expect(trustedOfficialUrl('https://user:secret@cbr.ru/')).toBe(false);
    const f=automaticFixture();f.extraction.sourceSnapshot.origin='request';
    expect(automaticReviewIssues(f.extraction)).toContain('UNTRUSTED_SOURCE_ORIGIN');
  });
  it('retains fallback for unresolved amendments/cross-references',()=>{
    const f=automaticFixture();f.draft.automation!.documentKind='amendment';f.draft.automation!.unresolvedReferences=['Base act is required'];
    const p=prepareAutomaticReview(materializeExtraction(f.draft,f.snapshot,f.catalog),'test',f.catalog,asOf);
    expect(p.ready).toBe(false);expect(p.issues).toContain('DOCUMENT_REQUIRES_LEGAL_CONTEXT');
  });
  it('blocks unsupported expression operators and missing fact definitions',()=>{
    const f=automaticFixture();f.draft.automation!.phases[0]!.requiredFacts[1]!.key='missing.definition';
    expect(()=>prepareAutomaticReview(materializeExtraction(f.draft,f.snapshot,f.catalog),'test',f.catalog,asOf)).toThrow('EXTRACTION_QUALITY_GATE_FAILED');
  });
  it('does not treat a model confidence label as legal verification',()=>{
    const f=automaticFixture();f.draft.uncertaintyNotes=['Cannot determine the covered entities.'];
    const p=prepareAutomaticReview(materializeExtraction(f.draft,f.snapshot,f.catalog),'test',f.catalog,asOf);
    expect(p.issues).toContain('UNRESOLVED_EXTRACTION');expect(p.ready).toBe(false);
  });
  it('performs one extraction call per document, with no company data in the prompt',async()=>{
    const f=automaticFixture();const provider={name:'test-fixture',model:'test',generateJson:vi.fn(async(_input:{system:string;user:string;jsonSchema?:Record<string,unknown>})=>structuredClone(f.draft))};
    const result=await extractRegulatoryDraft(provider,{sourceTitle:f.snapshot.sourceTitle,officialUrl:f.snapshot.officialUrl,sourceText:f.snapshot.sourceText,sourceTextOrigin:'staged-official-page'}, {autonomous:true,factCatalog:f.catalog});
    expect(provider.generateJson).toHaveBeenCalledTimes(1);expect(result.automation?.factDefinitions[0]?.key).toBe(f.definition.key);
    const prompt=JSON.parse(provider.generateJson.mock.calls[0]![0].user);
    expect(prompt).not.toHaveProperty('company');expect(prompt).not.toHaveProperty('profiles');expect(prompt).toHaveProperty('businessFactCatalog');
  });
  it('blocks tampering with automatic dates and action wording after compilation',()=>{
    const f=automaticFixture(),p=prepareAutomaticReview(f.extraction,'test',f.catalog,asOf);
    p.document.phases[0]!.actions[0]!.description='Invented replacement obligation';
    expect(automaticReviewIssues(f.extraction,p.document)).toContain('AUTOMATIC_REVISION_MODIFIED');
  });
  it('blocks altered automatic definition semantics',()=>{
    const f=automaticFixture(),p=prepareAutomaticReview(f.extraction,'test',f.catalog,asOf);
    p.document.factDefinitions![0]!.freshness={kind:'stable',maxAgeDays:null};
    p.document.factDefinitions![0]!.description='Altered definition';
    expect(automaticReviewIssues(f.extraction,p.document)).toContain('AUTOMATIC_FACT_DEFINITIONS_MODIFIED');
  });

});


describe('S9.9 dynamic review preview and limits',()=>{
  it('previews a typed new fact without writing a company profile',()=>{
    const f=automaticFixture(),p=prepareAutomaticReview(f.extraction,'preview',f.catalog,asOf),c=compileReview(p.document,f.extraction,asOf);
    const profile={profileVersion:1,legalForm:'LLC' as const};
    const positive=previewReview(c,{profile,asOf,factValues:{'facts.warehouse.archiveInUse':true}});
    const negative=previewReview(c,{profile,asOf,factValues:{'facts.warehouse.archiveInUse':false}});
    expect(positive[0]!.evaluation!.verdict).toBe('applies');expect(negative[0]!.evaluation!.verdict).toBe('not_applicable');
    expect(profile).not.toHaveProperty('facts');
  });
  it('rejects unknown preview paths and invalid values',()=>{
    const f=automaticFixture(),p=prepareAutomaticReview(f.extraction,'preview',f.catalog,asOf),c=compileReview(p.document,f.extraction,asOf);
    expect(()=>previewReview(c,{profile:{profileVersion:1},asOf,factValues:{'facts.unbound.path':true}})).toThrow('PREVIEW_UNKNOWN_FACT');
    expect(()=>previewReview(c,{profile:{profileVersion:1},asOf,factValues:{'facts.warehouse.archiveInUse':'yes'}})).toThrow('PREVIEW_INVALID_FACT_VALUE');
  });
  it('rejects excessively deep model JSON before recursive schema validation',()=>{
    let input:unknown={};for(let i=0;i<50;i++)input={child:input};
    expect(()=>assertExtractionLimits(input)).toThrow('EXTRACTION_RESOURCE_LIMIT');
    expect(()=>assertExtractionLimits({text:'x'.repeat(500001)})).toThrow('EXTRACTION_RESOURCE_LIMIT');
  });
});
