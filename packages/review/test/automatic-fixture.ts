import { FactDefinitionSchema, builtinFactDefinitions } from '@reg/domain';
import { createSourceSnapshot, materializeExtraction, type RegulatoryDraft } from '@reg/llm';

// Invented fixture on a deliberately non-existent official-looking URL.
// Never seed/publish this into a real database. It tests mechanics, not law.
export function automaticFixture() {
  const definition=FactDefinitionSchema.parse({key:'warehouse.archiveInUse',semanticKey:'warehouse.archiveInUse',version:1,
    title:'Archive warehouse',description:'Whether an archive warehouse is operated by this company.',
    type:'boolean',scope:'company',question:'Does the company operate an archive warehouse?',options:[],
    freshness:{kind:'event',maxAgeDays:30},periodic:false,origin:'model'});
  const snapshot=createSourceSnapshot({sourceTitle:'S9.9 synthetic test, not a law',
    officialUrl:'https://publication.pravo.gov.ru/synthetic-tests/s99',sourceTextOrigin:'staged-official-page',
    sourceText:'Synthetic example, NOT an actual law. From 01.01.2026 limited liability companies (LLC) operating an archive warehouse must establish an access register. The register is required from the start of this fictional phase. No other conditions or exceptions are specified in this test.'});
  const expressions=[{op:'eq' as const,field:'legalForm',value:'LLC',scope:'company' as const,sourceSegmentIndexes:[0]},
    {op:'eq' as const,field:'facts.warehouse.archiveInUse',value:true,scope:'company' as const,sourceSegmentIndexes:[0]}];
  const draft:RegulatoryDraft={title:snapshot.sourceTitle,summary:'Synthetic archive obligation.',uncertaintyNotes:[],dateNotes:[],
    phases:[{title:'Archive access register',subjectRole:'Limited liability company operating an archive warehouse',
      validFrom:{date:'2026-01-01',sourceSegmentIndexes:[0]},validTo:{date:null,sourceSegmentIndexes:[]},sourceSegmentIndexes:[0],
      conditions:expressions.map(e=>({fieldHint:e.field,operatorHint:e.op,valueHint:e.value,text:'Explicit synthetic scope condition.',sourceSegmentIndexes:[0]})),
      exceptions:[],affectedProcesses:['archive'],uncertaintyNotes:[],
      actionDrafts:[{title:'Establish a register',description:'Create the fictional access register for this test.',deadline:{kind:'phase_start'},sourceSegmentIndexes:[0]}]}],
    automation:{documentKind:'normative',coverage:'complete',unresolvedReferences:[],factDefinitions:[definition],
      phases:[{phaseIndex:0,category:'other',scope:'company',conditionJoin:'and',conditionExpressions:expressions,exceptionExpressions:[],
        endReason:'No end date is specified in the synthetic source.',requiredFacts:[
          {field:'legalForm',key:'company.legalForm',definitionVersion:1,purposes:['targeting','applicability'],period:{kind:'none'},maxAgeDays:null},
          {field:'facts.warehouse.archiveInUse',key:definition.key,definitionVersion:1,purposes:['applicability'],period:{kind:'none'},maxAgeDays:null},
        ]}]}};
  const catalog=builtinFactDefinitions();
  return {definition,snapshot,draft,catalog,extraction:materializeExtraction(draft,snapshot,catalog)};
}
