import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { RegulatoryExtraction } from '@reg/llm';
import { getPool } from './client.js';
import { saveRuleCandidate } from './ingestion.js';
import { ReviewError } from './review.js';
import { seedHash } from './canonical.js';

export const ExtractionRequestSchema=z.object({ sourceText:z.string().trim().min(1).max(500000).optional() }).strict();
export async function enqueueExtraction(sourceId:string,value:unknown) {
  const body=ExtractionRequestSchema.parse(value);
  const source=(await getPool().query('SELECT * FROM source_documents WHERE id=$1',[sourceId])).rows[0];
  if(!source) throw new ReviewError('SOURCE_DOCUMENT_NOT_FOUND',404);
  const text=body.sourceText ?? source.raw?.text ?? '';
  const input={sourceTitle:source.title,officialUrl:source.official_url,sourceText:text,
    sourceTextOrigin:body.sourceText || source.raw?.sourceKind==='manual-official' ? 'request' : 'staged-official-page',
    sourceRetrievedAt:new Date(source.last_seen_at).toISOString()};
  const result=await getPool().query(`INSERT INTO extraction_jobs(id,source_document_id,request_key,input)
    VALUES($1,$2,$3,$4) ON CONFLICT(request_key) DO UPDATE SET request_key=EXCLUDED.request_key RETURNING id,status,candidate_id`,
  [randomUUID(),sourceId,'extraction:'+sourceId+':'+seedHash({input,hash:source.raw_hash}),JSON.stringify(input)]);
  return result.rows[0];
}
export async function getExtractionJob(id:string) {
  return (await getPool().query(`SELECT id,source_document_id,status,attempts,started_at,finished_at,
    candidate_id,last_error,available_at FROM extraction_jobs WHERE id=$1`,[id])).rows[0] ?? null;
}
export async function claimExtractionJob() {
  await getPool().query(`UPDATE extraction_jobs SET status='failed',last_error='EXTRACTION_ATTEMPTS_EXHAUSTED',
    finished_at=now(),lease_until=NULL,claim_token=NULL
    WHERE status='processing' AND lease_until<now() AND attempts>=3`);
  const token=randomUUID();
  return (await getPool().query(`WITH picked AS(SELECT id FROM extraction_jobs
    WHERE attempts<3 AND ((status IN ('pending','failed') AND available_at<=now())
      OR (status='processing' AND lease_until<now()))
    ORDER BY created_at FOR UPDATE SKIP LOCKED LIMIT 1)
    UPDATE extraction_jobs j SET status='processing',attempts=attempts+1,started_at=now(),finished_at=NULL,
      claim_token=$1,lease_until=now()+interval '10 minutes' FROM picked WHERE j.id=picked.id RETURNING j.*`,[token])).rows[0] ?? null;
}
export async function completeExtractionJob(job:any,draft:RegulatoryExtraction,provider:{name:string;model?:string}) {
  const db=await getPool().connect();
  try {
    await db.query('BEGIN');
    const owned=await db.query("SELECT id FROM extraction_jobs WHERE id=$1 AND claim_token=$2 AND status='processing' FOR UPDATE",[job.id,job.claim_token]);
    if(!owned.rowCount){await db.query('COMMIT');return null;}
    const id=await saveRuleCandidate({sourceDocumentId:job.source_document_id,provider:provider.name,model:provider.model,draft},db);
    await db.query("UPDATE extraction_jobs SET status='processed',candidate_id=$2,finished_at=now(),lease_until=NULL,claim_token=NULL,last_error=NULL WHERE id=$1",[job.id,id]);
    await db.query('COMMIT');return id;
  }catch(error){await db.query('ROLLBACK');throw error;}finally{db.release();}
}
export async function failExtractionJob(job:any) {
  await getPool().query(`UPDATE extraction_jobs SET status='failed',last_error='EXTRACTION_FAILED',finished_at=now(),
    lease_until=NULL,claim_token=NULL,available_at=now()+interval '2 minutes' WHERE id=$1 AND claim_token=$2`,[job.id,job.claim_token]);
}
