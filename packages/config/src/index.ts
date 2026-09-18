import { z } from 'zod';

const ConfigSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  DATABASE_URL: z.string().min(1).default('postgresql://regcontrol:regcontrol@localhost:5432/regcontrol'),
  API_PORT: z.coerce.number().int().positive().default(3000),
  API_HOST: z.string().default('0.0.0.0'),
  BOT_PORT: z.coerce.number().int().positive().default(3001),
  BOT_HOST: z.string().default('0.0.0.0'),

  MAX_API_BASE_URL: z.string().url().default('https://platform-api2.max.ru'),
  MAX_BOT_TOKEN: z.string().optional(),
  MAX_BOT_USERNAME: z.string().optional(),
  MAX_WEBHOOK_SECRET: z.string().optional(),
  MAX_WEBHOOK_URL: z.string().url().optional(),
  MAX_MINI_APP_URL: z.string().url().optional(),
  MAX_INIT_DATA_MAX_AGE_SECONDS: z.coerce.number().int().positive().default(3600),
  SESSION_SECRET: z.string().min(16).default('dev-only-change-me-please'),
  SESSION_TTL_SECONDS: z.coerce.number().int().positive().default(60 * 60 * 24 * 7),
  ALLOW_DEV_AUTH: z.preprocess((value) => typeof value === 'string' ? ['1','true','yes','on'].includes(value.toLowerCase()) : value, z.boolean()).default(true),

  LLM_PROVIDER: z.enum(['mock', 'gigachat', 'deepseek']).default('mock'),
  GIGACHAT_AUTH_KEY: z.string().optional(),
  GIGACHAT_SCOPE: z.string().default('GIGACHAT_API_PERS'),
  GIGACHAT_BASE_URL: z.string().url().default('https://api.giga.chat/v1'),
  GIGACHAT_OAUTH_URL: z.string().url().default('https://ngw.devices.sberbank.ru:9443/api/v2/oauth'),
  DEEPSEEK_API_KEY: z.string().optional(),
  DEEPSEEK_BASE_URL: z.string().url().default('https://api.deepseek.com'),
  LLM_MODEL: z.string().optional(),
  LLM_TIMEOUT_MS: z.coerce.number().int().positive().default(45000),

  PRAVO_OPEN_DATA_URL: z.string().url().default('https://publication.pravo.gov.ru/OpenData/7710349494-legalacts-90'),
  GOVERNMENT_DOCS_URL: z.string().url().default('https://government.ru/docs/all/'),
  FNS_CHANGES_URL: z.string().url().default('https://www.nalog.gov.ru/new2026/'),
  CBR_LEGAL_ACTS_URL: z.string().url().default('https://www.cbr.ru/na/'),
  CBR_DIGITAL_RUBLE_URL: z.string().url().default('https://www.cbr.ru/PSystem/dr/dr_for_business/accepting_payments_dr/'),
  ROSPOTREBNADZOR_NEWS_URL: z.string().url().default('https://zpp.rospotrebnadzor.ru/news/federal/'),
  INGESTION_ENABLE_PRAVO: z.preprocess((value) => typeof value === 'string' ? ['1','true','yes','on'].includes(value.toLowerCase()) : value, z.boolean()).default(true),
  INGESTION_ENABLE_GOVERNMENT: z.preprocess((value) => typeof value === 'string' ? ['1','true','yes','on'].includes(value.toLowerCase()) : value, z.boolean()).default(true),
  INGESTION_ENABLE_FNS: z.preprocess((value) => typeof value === 'string' ? ['1','true','yes','on'].includes(value.toLowerCase()) : value, z.boolean()).default(true),
  INGESTION_ENABLE_CBR: z.preprocess((value) => typeof value === 'string' ? ['1','true','yes','on'].includes(value.toLowerCase()) : value, z.boolean()).default(true),
  INGESTION_ENABLE_ROSPOTREBNADZOR: z.preprocess((value) => typeof value === 'string' ? ['1','true','yes','on'].includes(value.toLowerCase()) : value, z.boolean()).default(true),
  INGESTION_USER_AGENT: z.string().default('max-regulatory-control-hackathon/0.9'),
  INGESTION_TIMEOUT_MS: z.coerce.number().int().positive().default(20000),
  INGESTION_RETRIES: z.coerce.number().int().min(0).max(5).default(2),
  ADMIN_TOKEN: z.string().optional(),
  REVIEW_UI_ORIGIN: z.string().url().optional(),
  NOTIFICATION_POLL_SECONDS: z.coerce.number().int().positive().default(60),
});

export type AppConfig = z.infer<typeof ConfigSchema>;

export function getConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const config = ConfigSchema.parse(env);
  if (config.NODE_ENV === 'production' && config.SESSION_SECRET === 'dev-only-change-me-please') {
    throw new Error('SESSION_SECRET must be explicitly configured in production');
  }
  return config;
}

export function requireSecret(value: string | undefined, name: string): string {
  if (!value) throw new Error(`${name} is required for this operation`);
  return value;
}
