import { runRegulatoryIngestion } from './jobs.js';
console.log(JSON.stringify(await runRegulatoryIngestion(), null, 2));
