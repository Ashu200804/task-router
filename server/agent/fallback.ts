/**
 * When the normal rules find nobody, or routing cannot be relied on: a fixed ladder of
 * fallbacks, from bending nothing to bending one rule. Same data in, same answer out.
 *
 * Certification and expertise are never set aside, and never two rules at once.
 */
import type { BlockerCode, Candidate } from '../../shared/types.ts';

export const CAPACITY_STRETCH = 1.2;

export interface Rung {
  name: 'eligible' | 'stretch_capacity' | 'one_level_below' | 'ask_again' | 'other_branch';
  relaxes: string[];
  tradeoff: string;
  accepts: (c: Candidate, estimateHours: number) => boolean;
}

const only = (c: Candidate, code: BlockerCode) => c.codes.length === 1 && c.codes[0] === code;

export const LADDER: Rung[] = [
  {
    name: 'eligible',
    relaxes: [],
    tradeoff: 'Meets every requirement.',
    accepts: (c) => c.codes.length === 0,
  },
  {
    name: 'stretch_capacity',
    relaxes: ['weekly capacity, by at most 20%'],
    tradeoff: 'Needs their agreement to extra hours; other work may slip.',
    accepts: (c, hours) => only(c, 'capacity') && c.loadHours + hours <= c.weeklyHours * CAPACITY_STRETCH,
  },
  {
    name: 'one_level_below',
    relaxes: ['minimum level, by one'],
    tradeoff: 'Plan for closer review of the result.',
    accepts: (c) => only(c, 'level') && c.levelGap === 1,
  },
  {
    name: 'ask_again',
    relaxes: ['routing’s rule not to return to someone who declined or had it withdrawn'],
    tradeoff: 'Only sensible if their reason no longer applies. Ask first.',
    // A failed attempt is not retried this way: something went wrong that asking will not fix.
    accepts: (c) => only(c, 'history') && !c.blockers[0]!.startsWith('previously failed'),
  },
  {
    name: 'other_branch',
    relaxes: ['same-branch rule'],
    tradeoff: 'Check time zones, data residency and the other branch’s priorities.',
    accepts: (c) => only(c, 'branch'),
  },
];

export interface Choice {
  rung: Rung;
  candidate: Candidate;
}

/** The best person on each rung that has anyone, in ladder order. */
export function staffingChoices(candidates: Candidate[], estimateHours: number, exclude?: string): Choice[] {
  return LADDER.flatMap((rung) => {
    const best = candidates
      .filter((c) => c.contributorId !== exclude && rung.accepts(c, estimateHours))
      .sort((a, b) => b.score - a.score || a.contributorId.localeCompare(b.contributorId))[0];
    return best ? [{ rung, candidate: best }] : [];
  });
}
