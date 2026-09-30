import { getConfig } from '@reg/config';
import { claimExtractionJob,completeExtractionJob,failExtractionJob,ensureBuiltinFacts,listFactDefinitions } from '@reg/db';
import { fetchReadableOfficialText,extractionErrorCode } from '@reg/ingestion';
import { createProvider,extractRegulatoryDraft } from '@reg/llm';

export async function processExtractionJob() {
  const job=await claimExtractionJob();
  if(!job)return false;
  try {
    const config=getConfig(), input={...job.input};
    if(!input.sourceText.trim()) {
      input.sourceText=await fetchReadableOfficialText({url:input.officialUrl,timeoutMs:config.INGESTION_TIMEOUT_MS,
        retries:config.INGESTION_RETRIES,userAgent:config.INGESTION_USER_AGENT});
      input.sourceTextOrigin='official-url-fetch';input.sourceRetrievedAt=new Date().toISOString();
    }
    const provider=createProvider({provider:config.LLM_PROVIDER,gigachatAuthKey:config.GIGACHAT_AUTH_KEY,
      gigachatScope:config.GIGACHAT_SCOPE,gigachatOauthUrl:config.GIGACHAT_OAUTH_URL,gigachatBaseUrl:config.GIGACHAT_BASE_URL,
      deepseekApiKey:config.DEEPSEEK_API_KEY,deepseekBaseUrl:config.DEEPSEEK_BASE_URL,model:config.LLM_MODEL,timeoutMs:config.LLM_TIMEOUT_MS});
    await ensureBuiltinFacts();
    const factCatalog=await listFactDefinitions();
    await completeExtractionJob(job,await extractRegulatoryDraft(provider,input,{autonomous:config.AUTONOMOUS_RULES_ENABLED,factCatalog}),provider);
  }catch(error) {await failExtractionJob(job,extractionErrorCode(error));}
  return true;
}
