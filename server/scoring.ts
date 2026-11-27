/**
 * Who should get a task, and why.
 *
 * Two steps, as a manager would take them. Hard requirements decide who can take it at all.
 * Then the rest are ranked on five factors, each shown with its reason, weighted by how
 * urgent the work is. The result advises: routing proposes, people accept, operators override.
 *
 * Deliberately limited to facts about the work. Nothing personal is an input.
 */
import type { BlockerCode, Branch, Candidate, Expertise, Priority, Profile, Requirements, ScoreFactor, WorkRecord } from '../shared/types.ts';

export interface Person {
  id: string;
  name: string;
  branch: Branch;
  available: boolean;
  expertise: Expertise[];
  profile: Profile;
  record: WorkRecord;
  loadHours: number;
}

export interface Need extends Requirements {
  branch: Branch;
  expertise: Expertise;
  priority: Priority;
}

type Factor = ScoreFactor['factor'];

/** Points available per factor. Urgent work leans on track record; low priority spreads load. */
export const WEIGHTS: Record<Priority, Record<Factor, number>> = {
  high: { 'Skill fit': 25, Quality: 25, Reliability: 30, Capacity: 10, Responsiveness: 10 },
  normal: { 'Skill fit': 30, Quality: 20, Reliability: 20, Capacity: 20, Responsiveness: 10 },
  low: { 'Skill fit': 20, Quality: 15, Reliability: 15, Capacity: 35, Responsiveness: 15 },
};

/** Below this many finished tasks, say that the numbers are thin. */
export const ENOUGH_HISTORY = 5;

/**
 * A rate pulled towards a neutral prior while there is little evidence, so a newcomer is not
 * ranked as perfect after one success or hopeless after one failure.
 */
export function smoothed(successes: number, total: number, prior = 0.75, weight = 5): number {
  return (successes + prior * weight) / (total + weight);
}

const percent = (n: number, of: number) => (of ? `${Math.round((n / of) * 100)}% (${n}/${of})` : 'no history yet');

/** Why this person cannot be routed this task. Empty if they can. */
export function check(person: Person, need: Need): { code: BlockerCode; text: string }[] {
  const level = person.profile.levels[need.expertise] ?? 0;
  const found: { code: BlockerCode; text: string }[] = [];
  const add = (code: BlockerCode, text: string) => found.push({ code, text });
  if (!person.available) add('unavailable', 'unavailable');
  if (person.branch !== need.branch) add('branch', `in ${person.branch}, not ${need.branch}`);
  if (!person.expertise.includes(need.expertise)) add('expertise', `${need.expertise} is not listed`);
  else if (level < need.minLevel) add('level', `${need.expertise} level ${level}, needs ${need.minLevel}`);
  if (need.certification && !person.profile.certifications.includes(need.certification)) {
    add('certification', `lacks ${need.certification}`);
  }
  if (person.loadHours + need.estimateHours > person.profile.weeklyHours) {
    add('capacity', `over capacity (${round(person.loadHours)}h held + ${need.estimateHours}h > ${person.profile.weeklyHours}h)`);
  }
  return found;
}

export const blockers = (person: Person, need: Need): string[] => check(person, need).map((b) => b.text);

export function evaluate(person: Person, need: Need, excluded?: string, raisedIt = false): Candidate {
  const { record: r, profile } = person;
  const weights = WEIGHTS[need.priority];

  const level = profile.levels[need.expertise] ?? 0;
  const matched = need.skills.filter((s) => profile.skills.includes(s));
  const skillShare = need.skills.length ? matched.length / need.skills.length : 1;
  const fit = 0.7 * (level / 5) + 0.3 * skillShare;

  const rating = smoothed(r.ratingSum / 5, r.ratingCount);
  const quality = (rating + smoothed(r.firstPass, r.completed)) / 2;

  const finished = r.completed + r.failed;
  const reliability = 0.6 * smoothed(r.onTime, r.completed) + 0.4 * smoothed(r.completed, finished, 0.9);

  const free = profile.weeklyHours - person.loadHours;
  const capacity = Math.max(0, Math.min(1, (free - need.estimateHours) / profile.weeklyHours));

  const hours = r.responses ? r.responseMs / r.responses / 3_600_000 : null;
  const speed = hours === null ? 0.5 : 1 / (1 + hours / 8);
  const responsiveness = (smoothed(r.accepted, r.accepted + r.declined) + speed) / 2;

  const factor = (name: Factor, share: number, note: string): ScoreFactor => ({
    factor: name,
    max: weights[name],
    points: round(share * weights[name]),
    note,
  });
  const factors = [
    factor(
      'Skill fit',
      fit,
      `level ${level}/5${need.skills.length ? `, ${matched.length}/${need.skills.length} skills` : ''}`,
    ),
    factor(
      'Quality',
      quality,
      `${r.ratingCount ? `rated ${(r.ratingSum / r.ratingCount).toFixed(1)}/5` : 'not rated yet'}, first-pass ${percent(r.firstPass, r.completed)}`,
    ),
    factor('Reliability', reliability, `on time ${percent(r.onTime, r.completed)}, ${r.failed} failed`),
    factor('Capacity', capacity, `${round(Math.max(0, free))}h free of ${profile.weeklyHours}h`),
    factor(
      'Responsiveness',
      responsiveness,
      `accepts ${percent(r.accepted, r.accepted + r.declined)}${hours === null ? '' : `, replies in ${round(hours)}h`}`,
    ),
  ];

  const reasons: { code: BlockerCode; text: string }[] = [
    ...(raisedIt ? [{ code: 'requester' as const, text: 'raised this task' }] : []),
    ...(excluded ? [{ code: 'history' as const, text: `previously ${excluded} this task` }] : []),
    ...check(person, need),
  ];

  return {
    contributorId: person.id,
    name: person.name,
    title: profile.title,
    branch: person.branch,
    blockers: reasons.map((r) => r.text),
    codes: reasons.map((r) => r.code),
    levelGap: person.expertise.includes(need.expertise) ? Math.max(0, need.minLevel - level) : 0,
    score: round(factors.reduce((sum, f) => sum + f.points, 0)),
    factors,
    lowData: r.completed < ENOUGH_HISTORY,
    loadHours: round(person.loadHours),
    weeklyHours: profile.weeklyHours,
  };
}

/** Eligible people first, then by score. */
export const ranked = (candidates: Candidate[]) =>
  candidates.sort(
    (a, b) => Number(a.blockers.length > 0) - Number(b.blockers.length > 0) || b.score - a.score || a.name.localeCompare(b.name),
  );

const round = (n: number) => Math.round(n * 10) / 10;
