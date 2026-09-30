import { validateRegulatoryExtraction } from '@reg/llm';
import { prepareAutomaticReview, AUTO_GATE_VERSION, trustedOfficialUrl } from '@reg/review';
import { getPool } from './client.js';
import { ensureBuiltinFacts, listFactDefinitions, factDefinitionConflicts } from './facts.js';
import { createCandidateReview, getCandidateReview, saveCandidateReview } from './review.js';
import { publishReadyReviewRevision } from './publication.js';
import { enqueueExtraction } from './extraction-jobs.js';

const actor='system:autonomous-v1';
export async function automateCandidate(candidateId:string) {
  // A session advisory lock arbitrates workers; publication still takes its own
  // transaction/row locks. No SQL transaction spans an LLM network operation.
  const lock=await getPool().connect();
  const lockKey='automation:'+candidateId;
  let acquired=false;
  try {
    acquired=(await lock.query('SELECT pg_try_advisory_lock(hashtext($1)) AS ok',[lockKey])).rows[0].ok;
    if(!acquired)return {state:'busy'};
    const row=(await lock.query(`SELECT c.*,s.snapshot,d.source FROM legal_rule_candidates c
      JOIN source_documents d ON d.id=c.source_document_id LEFT JOIN source_snapshots s ON s.id=c.source_snapshot_id WHERE c.id=$1`,[candidateId])).rows[0];
    if(!row)return {state:'missing'};
    if(row.review_state!=='pending')return {state:row.review_state};
    const fail=async(issues:string[])=>{
      await lock.query(`INSERT INTO candidate_automation(candidate_id,state,gate_version,issues) VALUES($1,'needs_review',$2,$3)
        ON CONFLICT(candidate_id) DO UPDATE SET state='needs_review',gate_version=EXCLUDED.gate_version,issues=EXCLUDED.issues,updated_at=now()`,[candidateId,AUTO_GATE_VERSION,JSON.stringify(issues)]);
      return {state:'needs_review',issues};
    };
    if(!['gigachat','deepseek'].includes(row.provider)||String(row.source).startsWith('manual.'))return await fail(['NON_AUTOMATIC_SOURCE_OR_PROVIDER']);
    try {
      const extraction=validateRegulatoryExtraction({...row.draft,sourceSnapshot:row.snapshot});
      // New editions of an already published source require an explicit legal
      // relation, never a second unrelated set of active duties.
      const prior=await lock.query(`SELECT p.id FROM review_publications p JOIN legal_rule_candidates c ON c.id=p.candidate_id
        WHERE c.source_document_id=$1`,[row.source_document_id]);
      if(prior.rowCount)return await fail(['SOURCE_ALREADY_PUBLISHED_RELATION_REQUIRED']);
      await ensureBuiltinFacts(lock);
      const available=await listFactDefinitions(lock);
      const initial=prepareAutomaticReview(extraction,row.source_document_id,available,new Date().toISOString().slice(0,10));
      const conflicts=factDefinitionConflicts(extraction.automation?.factDefinitions??[],available);
      if(!initial.ready||conflicts.length)return await fail([...initial.issues,...conflicts]);
      let head=await getCandidateReview(candidateId);
      if(head&&head.actorId!==actor)return await fail(['HUMAN_REVIEW_IN_PROGRESS']);
      if(!head)head=await createCandidateReview(candidateId,actor);
      if(head.state!=='ready') {
        const prepared=prepareAutomaticReview(extraction,row.source_document_id,available,new Date().toISOString().slice(0,10),head.document);
        if(!prepared.ready)return await fail(prepared.issues);
        head=await saveCandidateReview(candidateId,{baseRevision:head.revision,state:'ready',reason:'Automatic structured validation; no human legal approval claimed.',document:prepared.document},actor);
      }
      const result=await publishReadyReviewRevision({candidateId,revision:head.revision,contentHash:head.contentHash,actorId:actor,reviewerNote:'Machine-validated publication: '+AUTO_GATE_VERSION});
      return {state:'published',eventId:result.eventId};
    }catch(error) {
      // Do not leak provider messages, SQL errors or model content into logs.
      const code=error instanceof Error&&/^[A-Z0-9_]+$/.test(error.message)?error.message:'AUTOMATION_GATE_FAILED';
      return await fail([code]);
    }
  }finally{if(acquired)await lock.query('SELECT pg_advisory_unlock(hashtext($1))',[lockKey]);lock.release();}
}
export async function processPendingAutomation(limit=5) {
  const rows=await getPool().query(`SELECT c.id FROM legal_rule_candidates c LEFT JOIN candidate_automation a ON a.candidate_id=c.id
    WHERE c.review_state='pending' AND (a.state IS NULL OR a.state='pending') ORDER BY c.created_at,c.id LIMIT $1`,[limit]);
  const results=[];for(const row of rows.rows)results.push(await automateCandidate(row.id));return results;
}
export async function enqueueAutomaticExtractions(limit=10) {
  // Pilot relevance remains a priority signal, never a hard exclusion of a new
  // industry. No source is discarded just because it uses a new business fact.
  const rows=await getPool().query(`SELECT d.id,d.official_url FROM source_documents d
    WHERE d.source NOT LIKE 'manual.%'
      AND d.official_url ~ '^https://([a-zA-Z0-9-]+[.])*(pravo[.]gov[.]ru|government[.]ru|nalog[.]gov[.]ru|cbr[.]ru|rospotrebnadzor[.]ru)(:443)?(/|$)'
      AND NOT EXISTS(SELECT 1 FROM extraction_jobs j WHERE j.source_document_id=d.id
      AND j.input->>'sourceRawHash'=d.raw_hash)
    ORDER BY d.relevance_score DESC,d.first_seen_at,d.id LIMIT $1`,[limit]);
  let enqueued=0;
  for(const row of rows.rows)if(trustedOfficialUrl(row.official_url)){await enqueueExtraction(row.id,{});enqueued++;}
  return enqueued;
}
