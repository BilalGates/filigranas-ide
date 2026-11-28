/** Execution provider identity. Models and reasoning are always discovered live. */
export const EXECUTION_PROVIDERS = [
  { value: 'claude', label: 'Claude Code', vendor: 'Anthropic', projectManager: true },
  { value: 'codex', label: 'Codex', vendor: 'OpenAI', projectManager: true },
  { value: 'agy', label: 'Antigravity', vendor: 'Google', projectManager: false },
] as const;
export type ExecutionProvider = typeof EXECUTION_PROVIDERS[number]['value'];
export type ManagerProvider = 'claude' | 'codex';
