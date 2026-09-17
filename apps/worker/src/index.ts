import { PgBoss } from 'pg-boss';
import { getConfig } from '@reg/config';
import { dispatchNotifications, runRegulatoryIngestion } from './jobs.js';

const config = getConfig();
const boss = new PgBoss(config.DATABASE_URL);
boss.on('error', (error) => console.error('[pg-boss]', error));
await boss.start();

await boss.createQueue('notification-dispatch', { retryLimit: 2, retryDelay: 30, retryBackoff: true });
await boss.createQueue('pravo-ingest', { retryLimit: 2, retryDelay: 120, retryBackoff: true, expireInSeconds: 600 });

await boss.work('notification-dispatch', async () => {
  await dispatchNotifications();
});
await boss.work('pravo-ingest', async () => {
  await runRegulatoryIngestion();
});

await boss.schedule('pravo-ingest', '15 5 * * *', null, { tz: 'Europe/Moscow' });

const kickNotifications = async () => {
  await boss.send('notification-dispatch', {}, { singletonSeconds: Math.max(30, config.NOTIFICATION_POLL_SECONDS) });
};
await kickNotifications();
const timer = setInterval(() => void kickNotifications().catch(console.error), config.NOTIFICATION_POLL_SECONDS * 1000);

const shutdown = async () => {
  clearInterval(timer);
  await boss.stop({ graceful: true });
  process.exit(0);
};
process.on('SIGTERM', () => void shutdown());
process.on('SIGINT', () => void shutdown());
console.log('Worker started: notification-dispatch + daily resilient pravo-ingest (multi-source)');
