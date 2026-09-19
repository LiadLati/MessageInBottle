// Runs a fixed set of representative letters through the configured model and prints what it
// answers, so the model's behaviour on Hebrew, Arabic, Russian, mixed languages, slang and irony
// can be judged BEFORE MIB_AI_AUTO_DECIDE is switched on. Nothing here touches the database.
//
//   pnpm --filter @mib/api ai:eval            (uses MIB_AI_ENDPOINT / MIB_AI_MODEL)
//
// A model fit for automatic decisions answers `accept` only on the clear violations, `reject`
// only on the clearly harmless letters, and `uncertain` on everything ambiguous — never the
// other way round. Read the output with that in mind; the expectations printed beside each
// sample are what a careful human reviewer would say.
import { loadEnvFiles } from '../lib/env.js';
import { loadConfig } from '../config.js';
import { createOllamaReviewer, parseReviewOutput } from '../services/ai-review.js';
import { AI_EVAL_SAMPLES } from '../services/ai-eval-samples.js';

loadEnvFiles();
const config = loadConfig();
const reviewer = createOllamaReviewer(config.ai);

console.log(`Model ${config.ai.model} at ${config.ai.endpoint}\n`);
let agreed = 0;
let unsafe = 0;
for (const sample of AI_EVAL_SAMPLES) {
  let verdict = 'no answer';
  let detail = '';
  try {
    const raw = await reviewer.review({
      text: sample.text,
      reasons: sample.reasons,
      explanations: sample.explanations ?? [],
    });
    const parsed = parseReviewOutput(raw);
    if (parsed) {
      verdict = parsed.verdict;
      detail = `${parsed.reason}${parsed.uncertainty ? ` · unsure: ${parsed.uncertainty}` : ''}${
        parsed.translation ? `\n      translation: ${parsed.translation}` : ''
      }`;
    } else {
      detail = `unparseable: ${String(raw).slice(0, 160)}`;
    }
  } catch (err) {
    detail = `model unreachable: ${err instanceof Error ? err.message : String(err)}`;
  }
  const ok = sample.acceptable.includes(verdict as (typeof sample.acceptable)[number]);
  // The dangerous errors: a clear violation called harmless, or a harmless letter called a
  // violation. Uncertainty is never dangerous.
  const dangerous =
    (sample.expected === 'accept' && verdict === 'reject') ||
    (sample.expected === 'reject' && verdict === 'accept');
  if (ok) agreed++;
  if (dangerous) unsafe++;
  console.log(
    `${ok ? 'OK  ' : dangerous ? 'BAD ' : 'meh '} [${sample.id}] ${sample.language} · expected ${sample.expected}, got ${verdict}`,
  );
  console.log(`      ${detail}\n`);
}
console.log(
  `${agreed}/${AI_EVAL_SAMPLES.length} within the acceptable answers, ${unsafe} dangerous disagreement(s).`,
);
console.log(
  unsafe === 0
    ? 'No dangerous disagreements. If the uncertain calls above look reasonable, MIB_AI_AUTO_DECIDE=true is defensible for this model.'
    : 'Do NOT enable MIB_AI_AUTO_DECIDE with this model: it called a clear case the wrong way.',
);
