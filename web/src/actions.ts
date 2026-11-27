import type { Action, ContributorAction, TaskStatus } from '../../shared/types.ts';

interface ActionCopy {
  label: string;
  /** What will happen, shown before the operator confirms. Absent: runs on one click. */
  explain?: (status: TaskStatus) => string;
  danger?: boolean;
}

export const ACTIONS: Record<Action, ActionCopy> = {
  submit: { label: 'Submit for routing', explain: () => 'The engine will look for a contributor with matching expertise.' },
  reroute: {
    label: 'Route again',
    explain: (s) =>
      s === 'routing'
        ? 'Starts a new attempt and closes the pending one. If the old attempt answers later, it is ignored.'
        : s === 'offered'
          ? 'Withdraws the current offer and starts a new routing attempt that skips that person.'
          : 'Starts a new routing attempt.',
  },
  stop_routing: {
    label: 'Stop routing',
    explain: () => 'Closes the pending attempt without starting another. A later answer is ignored.',
  },
  assign: {
    label: 'Assign manually',
    explain: (s) =>
      s === 'routing'
        ? 'Offers the task to the person you pick and closes the pending attempt. A later answer is ignored.'
        : s === 'accepted' || s === 'in_progress'
          ? 'Takes the task away from the current contributor and offers it to the person you pick.'
          : 'Offers the task to the person you pick. They still need to accept.',
  },
  withdraw: {
    label: 'Withdraw assignment',
    explain: (s) =>
      s === 'in_progress'
        ? 'The contributor has started work. Withdrawing stops their assignment; the task will need attention.'
        : 'Removes the current contributor. The task will need attention.',
    danger: true,
  },
  cancel: {
    label: 'Cancel task',
    explain: () => 'Closes the task for good, including any pending routing or active assignment.',
    danger: true,
  },
  approve: { label: 'Approve work', explain: () => 'Completes the task and adds this result to their record.' },
  request_changes: { label: 'Request changes', explain: () => 'Returns the work to the same person with your feedback.' },
  unblock: { label: 'Clear blocker', explain: () => 'Records that what was blocking the work is resolved.' },
  accept: { label: 'Accept' },
  decline: { label: 'Decline', explain: () => 'The task returns to you for a decision.' },
  start: { label: 'Start work' },
  update: { label: 'Post update', explain: () => 'A progress report. The task state does not change.' },
  block: { label: 'Report blocker', explain: () => 'Flags the task for the operator until it is cleared.' },
  submit_work: { label: 'Submit work', explain: () => 'Hands the work in. It is complete only once approved.' },
  fail: { label: 'Report failure', explain: () => 'The assignment ends and the task returns to you for a decision.' },
};

export const isContributorAction = (a: Action): a is ContributorAction =>
  ['accept', 'decline', 'start', 'update', 'block', 'submit_work', 'fail'].includes(a);
