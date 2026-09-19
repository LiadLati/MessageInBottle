// Runs the evaluation set through the configured model and prints what it answers, so its
// behaviour on Hebrew, Arabic, Russian, mixed scripts, slang, irony and adversarial text can
// be judged BEFORE MIB_AI_AUTO_DECIDE is ever switched on. Nothing here touches the database.
//
//   pnpm --filter @mib/api ai:eval                 one pass over every sample
//   pnpm --filter @mib/api ai:eval -- --repeat 3   three passes, to see whether it is stable
//   pnpm --filter @mib/api ai:eval -- --json       machine-readable output
//
// A passing run is necessary, not sufficient. It says the model did not get these particular
// letters dangerously wrong; it does not say the model is fit to suspend people's accounts
// without a human. Read the reasoning it gives, add letters from your own community, and treat
// enabling automatic decisions as a deliberate decision rather than the result of a green tick.
import { loadEnvFiles } from '../lib/env.js';
import { loadConfig } from '../config.js';
import { createOllamaReviewer, parseReviewOutput } from '../services/ai-review.js';
import { AI_EVAL_SAMPLES, type AiEvalSample } from '../services/ai-eval-samples.js';

const argv = process.argv.slice(2).filter((a) => a !== '--');
const flag = (name: string): string | undefined => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 ? argv[i + 1] : undefined;
};
const asJson = argv.includes('--json');
const repeat = Math.max(1, Number(flag('repeat') ?? 1));

loadEnvFiles();
const config = loadConfig();
const reviewer = createOllamaReviewer(config.ai);

interface Answer {
  verdict: string;
  reason: string;
  uncertainty: string | null;
  translation: string | null;
  error: string | null;
}

async function ask(sample: AiEvalSample): Promise<Answer> {
  const blank: Answer = {
    verdict: 'no answer',
    reason: '',
    uncertainty: null,
    translation: null,
    error: null,
  };
  try {
    const raw = await reviewer.review({
      text: sample.text,
      reasons: sample.reasons,
      explanations: sample.explanations ?? [],
    });
    const parsed = parseReviewOutput(raw);
    if (!parsed) return { ...blank, error: `unparseable: ${String(raw).slice(0, 200)}` };
    return {
      verdict: parsed.verdict,
      reason: parsed.reason,
      uncertainty: parsed.uncertainty ?? null,
      translation: parsed.translation ?? null,
      error: null,
    };
  } catch (err) {
    return { ...blank, error: err instanceof Error ? err.message : String(err) };
  }
}

// Reachability first, so an unreachable model is one clear line rather than 30 identical ones.
const probe = await ask(AI_EVAL_SAMPLES[0]!);
if (probe.error && probe.verdict === 'no answer' && !probe.error.startsWith('unparseable')) {
  console.error(`Cannot reach a model at ${config.ai.endpoint} (${config.ai.model}).`);
  console.error(`  ${probe.error}\n`);
  console.error('Start one and try again, for example:');
  console.error('  ollama serve &');
  console.error(`  ollama pull ${config.ai.model}`);
  console.error('\nNothing was evaluated, so nothing can be concluded about this model.');
  process.exit(2);
}

interface Row {
  sample: AiEvalSample;
  answers: Answer[];
  verdicts: string[];
  stable: boolean;
  ok: boolean;
  dangerous: boolean;
}

const rows: Row[] = [];
for (const sample of AI_EVAL_SAMPLES) {
  const answers: Answer[] = [];
  for (let i = 0; i < repeat; i++) answers.push(await ask(sample));
  const verdicts = answers.map((a) => a.verdict);
  const stable = new Set(verdicts).size === 1;
  // Every pass must be acceptable: one bad answer in three is still a bad answer.
  const ok = verdicts.every((v) => (sample.acceptable as readonly string[]).includes(v));
  const dangerous = verdicts.some(
    (v) =>
      (sample.expected === 'accept' && v === 'reject') ||
      (sample.expected === 'reject' && v === 'accept'),
  );
  rows.push({ sample, answers, verdicts, stable, ok, dangerous });
}

const agreed = rows.filter((r) => r.ok).length;
const unsafe = rows.filter((r) => r.dangerous);
const unstable = rows.filter((r) => !r.stable);
const unanswered = rows.filter((r) => r.answers.some((a) => a.error !== null));

if (asJson) {
  console.log(
    JSON.stringify(
      {
        model: config.ai.model,
        endpoint: config.ai.endpoint,
        repeat,
        samples: rows.length,
        agreed,
        dangerous: unsafe.map((r) => r.sample.id),
        unstable: unstable.map((r) => r.sample.id),
        rows: rows.map((r) => ({
          id: r.sample.id,
          language: r.sample.language,
          expected: r.sample.expected,
          verdicts: r.verdicts,
          answers: r.answers,
        })),
      },
      null,
      2,
    ),
  );
  process.exit(unsafe.length === 0 && unstable.length === 0 ? 0 : 1);
}

console.log(`Model ${config.ai.model} at ${config.ai.endpoint} · ${repeat} pass(es) per sample\n`);
for (const r of rows) {
  const mark = r.ok ? (r.stable ? 'OK  ' : 'FLIP') : r.dangerous ? 'BAD ' : 'meh ';
  console.log(
    `${mark} [${r.sample.id}] ${r.sample.language} · expected ${r.sample.expected}, got ${r.verdicts.join(', ')}`,
  );
  console.log(`      why it is here: ${r.sample.note}`);
  const a = r.answers[0]!;
  if (a.error) console.log(`      ${a.error}`);
  else {
    console.log(`      model: ${a.reason}`);
    if (a.uncertainty) console.log(`      unsure: ${a.uncertainty}`);
    if (a.translation) console.log(`      translation: ${a.translation}`);
  }
  console.log();
}

console.log(`${agreed}/${rows.length} samples answered within the acceptable range.`);
console.log(
  `${unsafe.length} dangerous disagreement(s): ${unsafe.map((r) => r.sample.id).join(', ') || 'none'}`,
);
if (repeat > 1)
  console.log(
    `${unstable.length} sample(s) answered differently between passes: ${unstable.map((r) => r.sample.id).join(', ') || 'none'}`,
  );
if (unanswered.length)
  console.log(`${unanswered.length} sample(s) the model failed to answer at all.`);

console.log('');
const blocking: string[] = [];
if (unsafe.length) blocking.push('it called a clear case the wrong way');
if (unstable.length) blocking.push('it did not give the same answer twice');
if (unanswered.length) blocking.push('it failed to answer some letters');
if (repeat < 3) blocking.push('it has not been run with --repeat 3');

if (blocking.length) {
  console.log('Do NOT enable MIB_AI_AUTO_DECIDE with this model:');
  for (const b of blocking) console.log(`  · ${b}`);
} else {
  console.log('No dangerous or unstable answers on this set. That is the floor, not the bar.');
  console.log('Before enabling MIB_AI_AUTO_DECIDE, also:');
  console.log('  · read the reasoning above — a right answer for a wrong reason will not hold;');
  console.log('  · add letters from your own users, in the languages they actually write;');
  console.log('  · remember that `uncertain` always goes to a person, whatever this setting is.');
  console.log('Leaving it off costs you admin time. Turning it on costs someone their account.');
}
process.exit(unsafe.length === 0 && unstable.length === 0 && unanswered.length === 0 ? 0 : 1);
