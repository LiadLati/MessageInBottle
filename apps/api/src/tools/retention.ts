// Reports what an evidence retention policy would remove, and — only when the policy is
// explicitly enabled and --apply is passed — carries it out.
//
//   pnpm --filter @mib/api retention:plan              what the current policy would remove
//   pnpm --filter @mib/api retention:plan -- --apply   actually redact (needs MIB_RETENTION_ENABLED=true)
//
// With the shipped defaults nothing is ever redactable: both windows are unset, so every
// settled case is held under `no_policy`. That is deliberate — see docs/ARCHITECTURE.md for
// the recommended values and the two product decisions they wait on.
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
const days = (ms: number | null) => (ms === null ? 'never (unset)' : `${ms / 86_400_000} days`);

console.log('Evidence retention policy');
console.log(`  automatic deletion : ${policy.enabled ? 'ENABLED' : 'disabled'}`);
console.log(`  rejected cases     : ${days(policy.rejectedAfterMs)}`);
console.log(`  accepted cases     : ${days(policy.acceptedAfterMs)}`);
console.log(`  appeal deadline    : ${days(policy.appealWindowMs)}\n`);

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
