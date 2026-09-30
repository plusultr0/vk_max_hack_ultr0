import { feedState, recentlyAdded, feedMatchesFilter } from './feed-logic.js';
import { getPool } from './client.js';
import { listImpacts } from './impacts.js';
import { recalculateCompanyAtomic } from './runtime.js';

export async function personalizedRegulatoryFeed(companyId:string,options:{filter?:string;offset?:number;limit?:number}={}) {
  const {impacts,refreshPending,refreshFailures}=await listImpacts(companyId);
  const metadata=await getPool().query(`SELECT l.rule_id,l.version,a.publication_date,
    s.created_at AS discovered_at,COALESCE(p.created_at,l.created_at) AS added_at
    FROM legal_rules l JOIN legal_acts a ON a.act_id=l.act_id
    LEFT JOIN review_publication_rules r ON r.rule_id=l.rule_id AND r.rule_version=l.version
    LEFT JOIN review_publications p ON p.id=r.publication_id
    LEFT JOIN source_snapshots s ON s.id=p.source_snapshot_id
    WHERE l.rule_id=ANY($1::text[])`,[impacts.map(i=>i.ruleId)]);
  const lookup=new Map(metadata.rows.map(r=>[r.rule_id+':'+r.version,r]));
  const now=Date.now();
  const items=impacts.filter(i=>i.isCurrent&&!['ended','cancelled'].includes(i.timeState)).map(impact=>{
    const meta=lookup.get(impact.ruleId+':'+impact.ruleVersion);
    const publishedAt=meta?.publication_date?new Date(meta.publication_date).toISOString().slice(0,10):null;
    const discoveredAt=meta?.discovered_at?new Date(meta.discovered_at).toISOString():null;
    const addedAt=meta?.added_at?new Date(meta.added_at).toISOString():null;
    const eventAt=addedAt??discoveredAt??publishedAt;
    const state=feedState(impact);
    return {impact,publishedAt,discoveredAt,addedAt,effectiveFrom:impact.effectiveFrom,eventAt,state,
      isRecent:recentlyAdded(addedAt,now)};
  });
  const filter=options.filter??'relevant';
  const filtered=items.filter(item=>feedMatchesFilter(item,filter))
    .sort((a,b)=>(b.eventAt??'').localeCompare(a.eventAt??'')||a.impact.id.localeCompare(b.impact.id));
  const offset=Math.max(0,options.offset??0),limit=Math.min(100,Math.max(1,options.limit??30));
  return {refreshPending,refreshFailures,items:filtered.slice(offset,offset+limit),total:filtered.length,nextOffset:offset+limit<filtered.length?offset+limit:null,
    coverage:{kind:'approved_rules_in_local_database',completeLegislationCoverage:false}};
}
export async function complianceBaseline(companyId:string,refresh=false) {
  if(refresh)await recalculateCompanyAtomic(companyId,'baseline');
  const {impacts,profileVersion,refreshPending,refreshFailures}=await listImpacts(companyId);
  const current=impacts.filter(i=>i.isCurrent&&i.timeState==='active');
  const relevant=current.filter(i=>i.verdict!=='not_applicable');
  return {profileVersion,refreshPending,refreshFailures,items:relevant,summary:{
    needsInfo:relevant.filter(i=>i.questions.length>0).length,
    actionRequired:relevant.filter(i=>i.complianceState==='action_required'&&i.actions.some(a=>!['completed','dismissed'].includes(a.executionStatus))).length,
    verify:relevant.filter(i=>!i.questions.length&&['not_assessed','unknown'].includes(i.complianceState)).length,
    selfReportedCompleted:relevant.filter(i=>i.actions.length>0&&i.actions.every(a=>a.executionStatus==='completed')).length,
    notApplicable:current.length-relevant.length,
  },coverage:{kind:'approved_rules_in_local_database',completeLegislationCoverage:false,activeRulesAssessed:current.length,
    warning:'\u041f\u0440\u043e\u0432\u0435\u0440\u043a\u0430 \u043f\u043e \u0437\u0430\u0433\u0440\u0443\u0436\u0435\u043d\u043d\u044b\u043c \u0442\u0440\u0435\u0431\u043e\u0432\u0430\u043d\u0438\u044f\u043c. \u042d\u0442\u043e \u043d\u0435 \u043f\u043e\u043b\u043d\u0430\u044f \u044e\u0440\u0438\u0434\u0438\u0447\u0435\u0441\u043a\u0430\u044f \u043f\u0440\u043e\u0432\u0435\u0440\u043a\u0430 \u0431\u0438\u0437\u043d\u0435\u0441\u0430.'}};
}
