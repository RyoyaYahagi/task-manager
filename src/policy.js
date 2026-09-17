// Agent permission policy. Humans are unrestricted.
export const DEFAULT_POLICY = {
  agent: {
    can_delete_task: false,
    can_purge: false,
    can_close_directly: true,
    can_edit_human_notes: false,
    can_delete_files: false,
    can_edit_human_criteria: false,
    can_revert_others: false,
  },
};

export class PolicyError extends Error {
  constructor(message, rule) {
    super(message);
    this.status = 403;
    this.code = 'forbidden';
    this.rule = rule;
  }
}

export function normalizePolicy(policy) {
  return { agent: { ...DEFAULT_POLICY.agent, ...(policy?.agent || {}) } };
}

/** Throws PolicyError when `actor` is an agent and the rule is disabled. */
export function assertAllowed(policy, actor, rule, message) {
  if (actor.kind !== 'agent') return;
  if (policy.agent[rule] === true) return;
  throw new PolicyError(message || `agents are not allowed: ${rule}`, rule);
}
