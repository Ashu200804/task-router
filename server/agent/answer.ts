/**
 * Answers questions about a case from the data alone. It recognises a handful of question
 * types and says plainly when a question is outside them.
 */
import type { Answer, CaseReport, Evidence, Trigger } from '../../shared/types.ts';
import type { Run, ToolName } from './tools.ts';

export function answerByRules(run: Run, report: CaseReport, trigger: Trigger, question: string): Answer {
  const evidence: Evidence[] = [];
  const cite = (tool: ToolName, fact: string) => {
    const id = `A${evidence.length + 1}`;
    evidence.push({ id, tool, fact });
    return `[${id}]`;
  };
  const done = (text: string): Answer => ({ text, source: 'rules', note: null, evidence });
  const q = question.toLowerCase();

  const people = run.call('rank_candidates');
  const named = people.find((p) => q.includes(p.name.toLowerCase()) || new RegExp(`\\b${p.name.split(' ')[0]!.toLowerCase()}\\b`).test(q));
  if (named) {
    const why = named.blockers.length ? `is ruled out: ${named.blockers.join('; ')}` : 'meets every requirement';
    const factors = named.factors.map((f) => `${f.factor} ${f.points}/${f.max} (${f.note})`).join('; ');
    return done(`${named.name} ${why}. Score ${named.score}: ${factors}. ${cite('rank_candidates', `${named.name}: score ${named.score}, ${why}.`)}`);
  }
  if (/\b(who|someone|anyone|candidate|alternative|else)\b/.test(q)) {
    const top = people.filter((p) => !p.blockers.length).slice(0, 3);
    const list = (top.length ? top : people.slice(0, 3))
      .map((p) => `${p.name} (${p.score}${p.blockers.length ? `; ${p.blockers.join('; ')}` : ''})`)
      .join(', ');
    return done(
      `${top.length ? 'Best eligible' : 'Nobody meets every requirement. Closest by score'}: ${list}. ${cite('rank_candidates', `${top.length} shown as eligible.`)}`,
    );
  }
  if (/\b(histor|happen|log|timeline|before)/.test(q)) {
    const recent = run.call('get_history').slice(-6);
    return done(`${recent.map((e) => e.summary).join(' ')} ${cite('get_history', `The latest ${recent.length} events.`)}`);
  }
  if (/\b(engine|wait|stuck|slow)\b/.test(q) && trigger.startsWith('routing')) {
    const h = run.call('get_engine_health');
    return done(`${h.unanswered} of the last ${h.judged} judged requests are unanswered; about 1 in 5 is expected. Whether this one will answer cannot be known. ${cite('get_engine_health', `${h.unanswered}/${h.judged} unanswered.`)}`);
  }
  if (/\b(similar|pattern|often|again|recurring)\b/.test(q)) {
    const { tasks } = run.call('find_similar', { trigger });
    return done(`${tasks} other task(s) of this kind had the same problem in the last 7 days. ${cite('find_similar', `${tasks} similar.`)}`);
  }
  if (/\b(should|recommend|option|do|next|why|risk)\b/.test(q)) {
    const best = report.options.find((o) => o.recommended);
    const others = report.options.filter((o) => !o.recommended).map((o) => `${o.label} (${o.tradeoff})`);
    return done(
      best
        ? `Recommended: ${best.label}. Tradeoff: ${best.tradeoff} ${report.findings.map((f) => f.text).join(' ')}${others.length ? ` Alternatives: ${others.join('; ')}.` : ''}`
        : 'This case has no options.',
    );
  }
  return done(
    'I answer from the data about: a person by name, who else could do it, what happened, what to do next, similar cases, and (for routing problems) the engine. Try one of those.',
  );
}
