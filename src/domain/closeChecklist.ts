/**
 * Period-close checklist — the monthly ritual a seasoned accountant runs. Each
 * task is signed off by a named user, and the sign-off is recorded in the
 * immutable audit trail. This complements the evidence-ready close package:
 * the package proves the books are sound; the checklist proves the process ran.
 */

export interface CloseTask {
  key: string;
  label: { en: string; es: string };
  /** If set, the task can be auto-evaluated from system state (see evaluate). */
  auto?: 'trialBalance' | 'openHighFindings' | 'workingPapersTied';
}

export const DEFAULT_CLOSE_TASKS: readonly CloseTask[] = [
  { key: 'trial_balance', label: { en: 'Trial balance reviewed and ties', es: 'Balanza de comprobación revisada y cuadra' }, auto: 'trialBalance' },
  { key: 'bank_recs', label: { en: 'Bank reconciliations complete', es: 'Conciliaciones bancarias completas' } },
  { key: 'invoicing', label: { en: 'All sales invoiced (ZATCA)', es: 'All sales invoiced (ZATCA)' } },
  { key: 'accruals', label: { en: 'Accruals & depreciation posted', es: 'Causaciones y depreciación registradas' } },
  { key: 'working_papers', label: { en: 'Working papers tied out', es: 'Papeles de trabajo conciliados' }, auto: 'workingPapersTied' },
  { key: 'findings', label: { en: 'Control findings cleared', es: 'Hallazgos de control resueltos' }, auto: 'openHighFindings' },
  { key: 'taxes', label: { en: 'VAT position (ZATCA) reviewed', es: 'VAT position (ZATCA) reviewed' } },
  { key: 'statements', label: { en: 'Financial statements reviewed', es: 'Estados financieros revisados' } },
];

export interface ChecklistItemState {
  key: string;
  done: boolean;
  by?: string;
  at?: string;
  /** true when the item is auto-satisfied by system state (informational). */
  autoSatisfied?: boolean;
}

export interface AutoState {
  trialBalanceBalanced: boolean;
  openHighFindings: number;
  workingPapersUntied: number;
}

/** Evaluate the auto-satisfiable tasks from current system state. */
export function autoValue(task: CloseTask, s: AutoState): boolean | undefined {
  switch (task.auto) {
    case 'trialBalance': return s.trialBalanceBalanced;
    case 'openHighFindings': return s.openHighFindings === 0;
    case 'workingPapersTied': return s.workingPapersUntied === 0;
    default: return undefined;
  }
}

/** Merge stored sign-offs with the default task list and auto-evaluation. */
export function buildChecklist(
  stored: Record<string, { done: boolean; by?: string; at?: string }>,
  auto: AutoState,
  lang: 'en' | 'es' = 'en',
): { items: (ChecklistItemState & { label: string; auto: boolean })[]; done: number; total: number } {
  const items = DEFAULT_CLOSE_TASKS.map((task) => {
    const av = autoValue(task, auto);
    const manual = stored[task.key];
    const done = av !== undefined ? av : !!manual?.done;
    return {
      key: task.key,
      label: task.label[lang],
      auto: av !== undefined,
      autoSatisfied: av === true,
      done,
      by: manual?.by,
      at: manual?.at,
    };
  });
  return { items, done: items.filter((i) => i.done).length, total: items.length };
}
