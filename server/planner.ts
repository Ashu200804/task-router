/**
 * Proposes how to split a brief into pieces of work, one per skill needed, in a sensible order.
 *
 * This is a rule book, not understanding: it looks for words that signal a kind of work and
 * applies the matching playbook. Every step says which words triggered it, and nothing is
 * created until a manager has reviewed and edited the plan. A language model could replace
 * `split` behind the same shape, with the same review step.
 */
import { DEPARTMENTS, type Contributor, type Expertise, type Plan, type PlanStep, type Priority, type Branch } from '../shared/types.ts';
import { evaluate, ranked } from './scoring.ts';

interface Playbook {
  expertise: Expertise;
  signals: string[];
  /** Steps run after all steps of the closest earlier phase. */
  steps: (Omit<PlanStep, 'key' | 'dependsOn' | 'reason' | 'expertise' | 'description'> & { phase: number; description: string })[];
}

const step = (
  phase: number,
  title: string,
  description: string,
  minLevel: number,
  estimateHours: number,
  skills: string[] = [],
  certification: string | null = null,
) => ({ phase, title, description, minLevel, estimateHours, skills, certification });

const PLAYBOOKS: Playbook[] = [
  {
    expertise: 'data analysis',
    signals: ['data', 'dashboard', 'analytics', 'analysis', 'analyse', 'analyze', 'metric', 'kpi', 'churn', 'forecast'],
    steps: [
      step(1, 'Gather and check the data', 'Collect the source data, note gaps and agree definitions.', 2, 6, ['sql']),
      step(2, 'Analyse and report findings', 'Answer the question asked, with charts and caveats.', 3, 8, ['reporting']),
    ],
  },
  {
    expertise: 'finance',
    signals: ['budget', 'cost', 'pricing', 'price', 'invoice', 'revenue', 'audit', 'financial', 'finance', 'spend', 'vendor'],
    steps: [step(2, 'Assess the financial impact', 'Model costs and benefits and reconcile the figures used.', 3, 8, ['modelling'])],
  },
  {
    expertise: 'healthcare',
    signals: ['patient', 'clinical', 'trial', 'dosage', 'medical', 'health', 'hospital'],
    steps: [step(2, 'Clinical review', 'Check clinical safety and correctness.', 4, 6, [], 'Clinical licence')],
  },
  {
    expertise: 'legal',
    signals: ['contract', 'compliance', 'privacy', 'regulatory', 'regulation', 'legal', 'gdpr', 'licensing'],
    steps: [step(3, 'Legal and compliance review', 'Flag obligations, risks and required approvals.', 3, 6, ['contracts'])],
  },
  {
    expertise: 'operations',
    signals: ['process', 'roll out', 'launch', 'supplier', 'warehouse', 'logistics', 'onboarding', 'migration', 'pilot', 'returns'],
    steps: [step(4, 'Plan the rollout', 'Define process changes, owners, timeline and how success is checked.', 3, 8, ['process design'])],
  },
];

const mentions = (text: string, signal: string) =>
  new RegExp(`\\b${signal.replace(' ', '[ -]?')}(s|es|ing)?\\b`, 'i').test(text);

/** The kinds of work a text mentions, strongest first, counted by distinct signal words. */
export function classify(brief: { name: string; goal: string }) {
  const text = `${brief.name}. ${brief.goal}`;
  return PLAYBOOKS.map((book) => ({
    expertise: book.expertise,
    words: book.signals.filter((s) => mentions(text, s)),
    first: book.steps[0]!,
  }))
    .filter((k) => k.words.length)
    .sort((a, b) => b.words.length - a.words.length);
}

/** The proposed steps, in dependency order. */
export function split(brief: { name: string; goal: string }): PlanStep[] {
  const text = `${brief.name}. ${brief.goal}`;
  const found = PLAYBOOKS.flatMap((book) => {
    const hits = book.signals.filter((s) => mentions(text, s));
    if (!hits.length) return [];
    const reason = `The description mentions ${hits.slice(0, 3).map((h) => `“${h}”`).join(', ')}.`;
    return book.steps.map((s) => ({ ...s, expertise: book.expertise, reason }));
  }).sort((a, b) => a.phase - b.phase);

  const steps: (PlanStep & { phase: number })[] = [];
  for (const [i, s] of found.entries()) {
    const earlier = steps.filter((other) => other.phase < s.phase);
    const previous = Math.max(0, ...earlier.map((other) => other.phase));
    steps.push({ ...s, key: `s${i + 1}`, dependsOn: earlier.filter((o) => o.phase === previous).map((o) => o.key) });
  }
  return steps.map(({ phase: _, ...s }) => s);
}

/** Longest chain of hours ending at each step. Steps must be in dependency order. */
function finishHours(steps: PlanStep[]): Map<string, number> {
  const finish = new Map<string, number>();
  for (const s of steps) {
    finish.set(s.key, s.estimateHours + Math.max(0, ...s.dependsOn.map((k) => finish.get(k) ?? 0)));
  }
  return finish;
}

/** Spreads the project deadline over the steps in proportion to where they sit in the chain. */
export function scheduleSteps(steps: PlanStep[], now: number, dueAt: number | null): Map<string, number> {
  if (dueAt === null) return new Map();
  const finish = finishHours(steps);
  const longest = Math.max(...finish.values());
  return new Map([...finish].map(([key, hours]) => [key, Math.round(now + ((dueAt - now) * hours) / longest)]));
}

/** Eight hour days, five days in seven. */
export const workingHours = (from: number, to: number) => Math.max(0, ((to - from) / 86_400_000) * (5 / 7) * 8);

/** Adds who could do each step, and what looks wrong with the plan. */
export function review(
  steps: PlanStep[],
  context: { branch: Branch; priority: Priority; dueAt: number | null; now: number },
  people: Contributor[],
): Plan {
  const warnings: string[] = [];
  if (!steps.length) {
    warnings.push('Nothing in the description matched a known kind of work. Add the steps yourself.');
  }
  const planned = steps.map((s) => {
    const need = { ...s, branch: context.branch, priority: context.priority };
    const candidates = ranked(people.filter((p) => p.branch === context.branch).map((p) => evaluate(p, need)));
    if (!candidates.some((c) => c.blockers.length === 0)) {
      warnings.push(`Nobody in ${context.branch} can take “${s.title}” right now.`);
    }
    return { ...s, team: `${context.branch} · ${DEPARTMENTS[s.expertise]}`, candidates: candidates.slice(0, 4) };
  });
  if (context.dueAt !== null && steps.length) {
    const needed = Math.max(...finishHours(steps).values());
    const available = workingHours(context.now, context.dueAt);
    if (needed > available) {
      warnings.push(
        `The longest chain of steps needs ${Math.round(needed)} working hours; about ${Math.round(available)} remain before the deadline.`,
      );
    }
  }
  return { steps: planned, warnings };
}
