import { getConfig } from '@reg/config';
import { createProvider, extractRegulatoryDraft } from '@reg/llm';

const config = getConfig();
const provider = createProvider({
  provider: config.LLM_PROVIDER,
  gigachatAuthKey: config.GIGACHAT_AUTH_KEY,
  gigachatScope: config.GIGACHAT_SCOPE,
  gigachatOauthUrl: config.GIGACHAT_OAUTH_URL,
  gigachatBaseUrl: config.GIGACHAT_BASE_URL,
  deepseekApiKey: config.DEEPSEEK_API_KEY,
  deepseekBaseUrl: config.DEEPSEEK_BASE_URL,
  model: config.LLM_MODEL,
  timeoutMs: config.LLM_TIMEOUT_MS,
});
const result = await extractRegulatoryDraft(provider, {
  sourceTitle: 'Smoke test source',
  officialUrl: 'https://example.test/source',
  sourceTextOrigin: 'synthetic',
  sourceText: 'Организации, которые осуществляют дистанционную продажу товаров, обязаны разместить на сайте сведения о продавце. Требование применяется с 1 января 2027 года.',
});
console.log(JSON.stringify({ provider: provider.name, model: provider.model, result }, null, 2));
