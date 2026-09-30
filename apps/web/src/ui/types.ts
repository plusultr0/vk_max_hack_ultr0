export type FactQuestion = {
  field:string;text:string;inputType:string;options?:{value:string;label:string}[];
  hint?:string;placeholder?:string;min?:number|null;max?:number|null;unit?:string;
  definitionVersion?:number;status?:'fresh'|'stale'|'missing';currentValue?:unknown;
  displayValue?:string;confirmationText?:string;confirmedAt?:string|null;expectedObservationId?:string|null;
  period?:{start:string|null;end:string|null;asOf:string|null};
};
export type FactAnswer={field:string;value?:unknown;confirm?:boolean;expectedObservationId?:string|null};
export type Action={id:string;actionKey?:string;title:string;description:string;deadline:string|null;executionStatus:string;reviewRequired:boolean};
export type Impact={
  id:string;isCurrent:boolean;timeState:'active'|'upcoming'|'ended'|'cancelled';profileVersion:number;
  ruleId:string;ruleVersion:number;verdict:'applies'|'not_applicable'|'needs_info';reviewState:'auto'|'reviewed'|'needs_review';
  complianceState:'unknown'|'compliant'|'action_required'|'not_assessed';clarificationState?:string|null;effectiveFrom:string|null;
  reviewReasons:string[];questions:FactQuestion[];editableQuestions?:FactQuestion[];actions:Action[];
  explanation?:{facts:{label:string;value:string;status:string}[];requirement:string};
  rule:{userTitle:string;summary:string;category:string;legalStatus:string;checkedAt:string;validFrom?:string|null;
    approvalMode?:'human'|'machine_validated';evidenceRefs:{id:string;url:string;label:string;note?:string|null}[]};
};
export type ImpactList={profileVersion:number|null;impacts:Impact[];refreshPending?:boolean;refreshFailures?:number};
export type ProfileState={warnings?:string[];confirmed:Record<string,unknown>|null;draft:{data:Record<string,unknown>;answeredFields:string[];baseProfileVersion:number};
  progress:{answered:number;total:number;percent:number;canConfirm:boolean;missing:string[]}};
export type Feed={refreshPending?:boolean;refreshFailures?:number;items:{impact:Impact;publishedAt:string|null;discoveredAt:string|null;addedAt:string|null;effectiveFrom:string|null;isRecent:boolean}[];total:number;nextOffset:number|null};
export type BusinessCheck={actionId?:string|null;executionStatus?:string|null;checkKey:string;version:number;kind:'document'|'setting'|'action';title:string;help:string;impactId:string;ruleId:string;ruleVersion:number;
  sources:{id:string;url:string;label:string}[];basisHash:string;state:string;needsRecheck:boolean;canAnswer:boolean;clarification:string;answeredAt:string|null};
export type CheckList={items:BusinessCheck[];summary:{total:number;present:number;missing:number;clarify:number;unchecked:number;unknown:number;upcoming:number};
  coverage:{warning:string};refreshPending?:boolean;refreshFailures?:number};

export type AuditEvent={id:string;event_type:string;created_at:string};
export type AuditPage={items:AuditEvent[];nextCursor:string|null};
export type ProfileHistoryEntry={id:string;profile_version:number;confirmed_at:string;
  changes:{field:string;before:unknown;after:unknown;hadBefore:boolean;hasAfter:boolean}[]};
export type ProfileHistoryPage={items:ProfileHistoryEntry[];nextVersion:number|null};
