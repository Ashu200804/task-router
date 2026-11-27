/**
 * Diagnoses one problem. Each kind of problem has a playbook: which tools to consult, what
 * to conclude from the results, and which options to offer, best first. No model is
 * involved. Every conclusion names the evidence behind it and says how sure it is.
 */
import {
  OPERATOR_ACTIONS,
  type Candidate,
  type CaseOption,
  type CaseReport,
  type Certainty,
  type Evidence,
  type Finding,
  type TaskSummary,
  type Trigger,
} from '../../shared/types.ts';
import { staffingChoices, type Choice } from './fallback.ts';
import type { Run, ToolName } from './tools.ts';

/** Which problem a task has now, most urgent first. */
export function triggerFor(task: TaskSummary): Trigger | null {
  if (task.status === 'completed' || task.status === 'cancelled') return null;
  if (task.status === 'needs_attention') return task.attentionReason;
  if (task.overdueSince !== null) return 'routing_overdue';
  if (task.blocker) return 'blocked';
  if (task.assigneeUnavailable) return 'holder_unavailable';
  if (task.pastDueSince !== null) return 'past_due';
  if (task.quietSince !== null) return 'no_report';
  return null;
}

type Draft = Omit<CaseOption, 'id' | 'recommended'>;
const minutes = (ms: number) => Math.round(ms / 60_000);
const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`;

class Notes {
  evidence: Evidence[] = [];
  findings: Finding[] = [];
  /** Records a fact read through a tool and returns its id. */
  fact(tool: ToolName, fact: string): string {
    const id = `E${this.evidence.length + 1}`;
    this.evidence.push({ id, tool, fact });
    return id;
  }
  say(certainty: Certainty, text: string, ...evidence: string[]) {
    this.findings.push({ certainty, text, evidence });
  }
}

export function investigate(run: Run, trigger: Trigger, now: number): CaseReport {
  const notes = new Notes();
  const task = run.call('get_task');
  const history = run.call('get_history');
  const holder = task.assignee?.name;
  const options: Draft[] = [];
  let headline = '';
  let draftMessage: string | null = null;

  const lead = run.call('get_team_lead');
  // The lead is no help with a problem they are part of.
  const involved = holder ?? (task.status === 'needs_attention' ? run.call('get_assignments').at(-1)?.contributorName : undefined);
  const leadName = lead?.available && lead.name !== involved ? lead.name : null;
  const can = (action: 'assign' | 'reroute') => OPERATOR_ACTIONS[task.status].includes(action) && !task.waitingOn.length;

  /** Options for getting someone onto the task, from the fallback ladder. */
  const staffing = (): { choices: Choice[]; people: Candidate[] } => {
    const people = run.call('rank_candidates');
    const choices = staffingChoices(people, task.requirements.estimateHours, task.assignee?.contributorId);
    const inBranch = people.filter((p) => p.branch === task.branch);
    const eligible = inBranch.filter((p) => !p.codes.length).length;
    const e = notes.fact(
      'rank_candidates',
      `${eligible} of ${plural(inBranch.length, 'person')} in ${task.branch} meet every requirement for this task.`,
    );
    if (!eligible) {
      const count = new Map<string, number>();
      for (const p of inBranch) for (const code of p.codes) count.set(code, (count.get(code) ?? 0) + 1);
      const reasons = [...count].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).map(([c, n]) => `${c} (${n})`);
      const gap = inBranch.every((p) => p.codes.includes('expertise'));
      notes.say(
        'inferred',
        gap
          ? `No one in ${task.branch} lists ${task.expertise}. This is a coverage gap that routing again will not fix.`
          : `People are ruled out by: ${reasons.join(', ') || 'there is nobody in the branch'}.`,
        e,
      );
    }
    return { choices, people };
  };
  const assignOptions = (choices: Choice[], why: string) => {
    if (!can('assign')) return;
    for (const { rung, candidate: c } of choices.slice(0, 3)) {
      options.push({
        label: `Offer to ${c.name} (score ${c.score}${c.codes.length ? `; ${c.blockers.join('; ')}` : ''})`,
        command: {
          action: 'assign',
          contributorId: c.contributorId,
          reason: `${why}${rung.relaxes.length ? ` Sets aside: ${rung.relaxes.join(', ')}.` : ''}`,
        },
        relaxes: rung.relaxes,
        tradeoff: `${rung.tradeoff}${c.lowData ? ' Little work history to go on.' : ''}`,
      });
    }
  };
  const reroute = (tradeoff: string) =>
    can('reroute') &&
    options.push({ label: 'Route again', command: { action: 'reroute', reason: 'Assistant case: retry routing.' }, relaxes: [], tradeoff });
  const manual = (label: string, tradeoff: string) => options.push({ label, relaxes: [], tradeoff });
  const askLead = (about: string) => {
    manual(
      leadName
        ? `Ask ${leadName} (team lead) for help`
        : 'Escalate above the team: its lead is away, involved already, or not recorded',
      'Takes a person’s time, but can solve what the system cannot.',
    );
    if (leadName) {
      draftMessage = `Hi ${leadName}, ${task.id} “${task.title}” (${task.priority} priority, ${task.branch}) ${about} Could you help decide the next step?`;
    }
  };
  const similar = () => {
    const { tasks } = run.call('find_similar', { trigger });
    if (tasks >= 2) {
      const e = notes.fact('find_similar', `${tasks} other ${task.branch} ${task.expertise} tasks had the same problem in 7 days.`);
      notes.say('inferred', 'This looks like a pattern, not a one-off. Fixing the cause matters more than this task.', e);
    }
  };
  const lastNote = (type: string) => [...history].reverse().find((e) => e.type === type);

  switch (trigger) {
    case 'no_match': {
      headline = 'Routing found nobody for this task';
      const { attempts } = run.call('get_routing_attempts');
      notes.say('recorded', 'The latest routing attempt returned no match.', notes.fact('get_routing_attempts', `${plural(attempts.length, 'attempt')}; the latest ended “no match”.`));
      const { choices } = staffing();
      if (choices[0]?.rung.name === 'eligible') {
        notes.say('inferred', 'Someone is eligible now, so circumstances changed after the attempt or the engine missed them.');
        reroute('Gives routing the current picture.');
      }
      assignOptions(choices, 'Assistant case: no match found.');
      askLead('has no eligible person.');
      manual('Revisit the requirements (level, certification, estimate)', 'Changes what is being asked; check with whoever raised it.');
      break;
    }
    case 'declined':
    case 'failed': {
      const verb = trigger === 'declined' ? 'declined' : 'failed';
      const assignments = run.call('get_assignments');
      const same = assignments.filter((a) => a.status === verb);
      const last = same.at(-1);
      headline = trigger === 'declined' ? `${last?.contributorName} declined the task` : `${last?.contributorName}’s assignment failed`;
      const e = notes.fact('get_assignments', `${last?.contributorName} ${verb}; reason given: ${last?.endReason ? `“${last.endReason}”` : 'none'}. ${plural(same.length, 'assignment')} ${verb} so far.`);
      notes.say('recorded', last?.endReason ? `The stated reason is “${last.endReason}”.` : 'No reason was given.', e);
      if (!last?.endReason) notes.say('unknown', 'Why it happened is not recorded. Asking them is the only way to know.');
      const { choices } = staffing();
      if (same.length >= 2) {
        notes.say('inferred', 'More than one person has not been able to take this on. The task itself may need to change.', e);
        manual('Check the description and requirements before offering it again', 'Slower now; avoids another refusal.');
      }
      if (choices[0]?.rung.name === 'eligible') reroute('Skips everyone who already declined or failed.');
      assignOptions(choices, `Assistant case: previous assignment ${verb}.`);
      askLead(`was ${verb}.`);
      similar();
      break;
    }
    case 'contributor_unavailable':
    case 'over_capacity':
    case 'withdrawn':
    case 'routing_stopped': {
      headline = {
        contributor_unavailable: 'The chosen person is not available',
        over_capacity: 'Everyone routing chose had filled up',
        withdrawn: 'The assignment was withdrawn',
        routing_stopped: 'Routing was stopped',
      }[trigger];
      const last = history.at(-1)!;
      notes.say('recorded', last.summary, notes.fact('get_history', `${last.summary}${last.note ? ` Reason: “${last.note}”.` : ''}`));
      const { choices } = staffing();
      if (choices[0]?.rung.name === 'eligible') reroute('Uses current availability and workloads.');
      assignOptions(choices, `Assistant case: ${trigger.replaceAll('_', ' ')}.`);
      askLead('needs someone to take it.');
      break;
    }
    case 'routing_error': {
      headline = 'Routing broke down for this task';
      const { errors } = run.call('get_routing_attempts');
      const error = errors.at(-1);
      const e = notes.fact(
        'get_routing_attempts',
        error
          ? `Attempt ${error.attempt}: the “${error.kind}” step failed after ${error.tries} failed attempt(s) with “${error.error}”.`
          : 'No failed job is stored any more; see the history.',
      );
      notes.say('recorded', error ? `The error was “${error.error}”.` : 'The error details are only in the history.', e);
      if (error) {
        notes.say(
          'inferred',
          error.kind === 'apply'
            ? 'The engine answered, but the answer could not be used. That points at the engine or its data.'
            : 'The request could not be sent. That points at this request’s data or the connection to the engine.',
          e,
        );
      }
      notes.say('unknown', 'Whether a retry would succeed cannot be known from here.');
      const { choices } = staffing();
      assignOptions(choices, 'Assistant case: routing error, assigned by ranking instead.');
      reroute('May hit the same fault.');
      manual('Report the error to whoever maintains routing', 'Prevents a repeat; does not move this task.');
      similar();
      break;
    }
    case 'routing_overdue': {
      headline = 'Routing has not answered';
      const sent = task.pendingRequest?.sentAt ?? null;
      const waited = now - (sent ?? task.pendingRequest!.requestedAt);
      const e = notes.fact(
        'get_task',
        sent === null ? `The request has been queued ${minutes(waited)} min and not yet sent.` : `The request was sent ${minutes(waited)} min ago with no answer.`,
      );
      const health = run.call('get_engine_health');
      const h = notes.fact('get_engine_health', `${health.unanswered} of the last ${health.judged} requests old enough to judge are unanswered.`);
      notes.say(sent === null ? 'recorded' : 'unknown', sent === null ? 'The delay is in our own queue, not the engine.' : 'It may still arrive, or it may never. Nothing can tell these apart.', e);
      const degraded = health.judged >= 5 && health.unanswered / health.judged > 0.4;
      if (degraded) notes.say('inferred', 'Far more than the usual 20% are going unanswered. The engine appears to be having trouble.', h);
      else notes.say('inferred', 'The unanswered share does not suggest a wider engine problem.', h);
      const { choices } = staffing();
      if (sent === null) manual('Wait: the queue will send it', 'Check system health if this continues.');
      if (degraded) assignOptions(choices, 'Assistant case: engine unresponsive, assigned by ranking instead.');
      reroute('Closes this attempt; a late answer to it will be ignored.');
      if (!degraded) assignOptions(choices, 'Assistant case: routing overdue, assigned by ranking instead.');
      if (sent !== null) manual('Keep waiting', 'Costs time. If no answer is coming, nothing will happen.');
      break;
    }
    case 'blocked': {
      headline = `${holder} is blocked`;
      const note = lastNote('blocked');
      const e = notes.fact('get_history', `${holder} reported: “${task.blocker}” ${note ? `${minutes(now - note.at)} min ago` : ''}.`);
      notes.say('recorded', `The stated blocker is “${task.blocker}”.`, e);
      const waiting = run.call('get_dependencies').filter((d) => d.status !== 'completed' && d.status !== 'cancelled');
      if (waiting.length) {
        notes.say('inferred', `Unfinished prerequisites may be part of it: ${waiting.map((d) => d.id).join(', ')}.`, notes.fact('get_dependencies', `Waiting on ${waiting.map((d) => `${d.id} (${d.status})`).join(', ')}.`));
      }
      notes.say('unknown', 'Whether someone else would be stopped by the same thing is not recorded.');
      askLead(`is blocked: “${task.blocker}”.`);
      manual(`Resolve it, then use “Clear blocker” on the task`, 'Keeps the work and the person.');
      const { choices } = staffing();
      assignOptions(choices.slice(0, 1), `Assistant case: reassigned after blocker “${task.blocker}”.`);
      if (options.at(-1)?.command) options.at(-1)!.tradeoff += ` ${task.progress}% reported progress starts again.`;
      break;
    }
    case 'holder_unavailable':
    case 'past_due':
    case 'no_report': {
      headline = { holder_unavailable: `${holder} is away and still holds this`, past_due: 'The due date has passed', no_report: `No recent report from ${holder}` }[trigger];
      const e = notes.fact('get_task', `State ${task.status.replaceAll('_', ' ')}, held by ${holder ?? 'nobody'}, ${task.progress}% reported, last activity ${minutes(now - task.lastActivityAt)} min ago.`);
      notes.say('recorded', headline + '.', e);
      if (trigger !== 'holder_unavailable') notes.say('unknown', 'Why is not recorded. The holder or their lead can say.', e);
      const nearlyDone = task.progress >= 70 || task.status === 'in_review';
      if (nearlyDone) {
        notes.say('inferred', 'Most of the work is reported done, so moving it would likely cost more than waiting.', e);
        manual('Keep it with them and follow up', 'No work is lost; the date may move further.');
      }
      if (trigger === 'holder_unavailable') askLead('is held by someone who is away.');
      else {
        manual(`Ask ${holder ?? 'the holder'} for an update`, 'Cheapest way to learn what is wrong.');
        if (holder) draftMessage = `Hi ${holder}, could you post an update on ${task.id} “${task.title}”? ${trigger === 'past_due' ? 'It is past its due date.' : 'We have not had a report recently.'} Is anything in the way?`;
      }
      const { choices } = staffing();
      assignOptions(choices.slice(0, 2), `Assistant case: ${trigger.replaceAll('_', ' ')}.`);
      break;
    }
  }

  return {
    headline,
    findings: notes.findings,
    evidence: notes.evidence,
    // The assistant never recommends setting a rule aside. It offers that; a person chooses it.
    options: options.map((o, i) => ({
      ...o,
      id: `o${i + 1}`,
      recommended: i === options.findIndex((other) => !other.relaxes.length),
    })),
    draftMessage,
  };
}
