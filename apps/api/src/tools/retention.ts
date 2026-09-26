// Reports what the evidence retention policy would remove, and — with --apply — carries it
// out. The server runs the same thing on a timer; this is for inspecting it by hand.
//
//   pnpm --filter @mib/api retention:plan              dry run: what is redactable and why not
//   pnpm --filter @mib/api retention:plan -- --apply   redact now
//
// The shipped policy redacts a case's content evidence seven days after it becomes final.
// A dry run never changes anything, so it is safe to run against production data.
import { loadEnvFiles } from '../lib/env.js';
import { loadConfig } from '../config.js';
import { createDb, runMigrations } from '../db/client.js';
import { applyRetention, planRetention } from '../services/retention.js';

const args = process.argv.slice(2).filter((a) => a !== '--');
const apply = args.includes('--apply');

loadEnvFiles();
const config = loadConfig();
const { db } = createDb(config.databasePath);
runMigrations(db);
const now = Date.now();
const policy = config.retention;
console.log('Evidence retention policy');
console.log(`  automatic redaction : ${policy.enabled ? 'ENABLED' : 'disabled'}`);
console.log(`  after the decision: ${policy.afterDecisionMs / 86_400_000} days\n`);

const plan = planRetention(db, now, policy);
console.log(`${plan.cases.length} case(s) examined.`);
for (const [hold, count] of Object.entries(plan.held).sort((a, b) => b[1] - a[1]))
  console.log(`  held  ${String(count).padStart(4)}  ${hold}`);
console.log(`  redactable ${plan.redactable.length}`);

if (!apply) {
  console.log('\nDry run — nothing was changed. Pass --apply to carry this out.');
  process.exit(0);
}
const result = applyRetention(db, now, policy);
if (!result.applied) {
  console.log(`\nRefused: ${result.reason}`);
  process.exit(1);
}
console.log(`\nRedacted ${result.redacted.length} case(s).`);
