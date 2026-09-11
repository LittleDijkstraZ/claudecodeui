/** Native Workflow phase metadata; indices join agents to phases within one run. */
export type WorkflowPhaseProgress = {
  type: 'workflow_phase';
  index: number;
  title: string;
  kind?: string;
};

/** Bounded, recorded agent progress from Claude's Workflow runtime, not a resumable task handle. */
export type WorkflowAgentProgress = {
  type: 'workflow_agent';
  index: number;
  label: string;
  state: 'start' | 'progress' | 'done' | 'error';
  phaseIndex?: number;
  phaseTitle?: string;
  agentId?: string;
  agentType?: string;
  isolation?: string;
  model?: string;
  fallbackModel?: string;
  queuedAt?: number;
  startedAt?: number;
  lastProgressAt?: number;
  attempt?: number;
  lastAttemptReason?: string;
  lastToolName?: string;
  lastToolSummary?: string;
  promptPreview?: string;
  resultPreview?: string;
  error?: string;
  tokens?: number;
  toolCalls?: number;
  durationMs?: number;
  cached?: boolean;
  blocked?: boolean;
};

/** One entry in Claude's latest full phase/agent snapshot; absent snapshots leave earlier data intact. */
export type WorkflowProgressEntry = WorkflowPhaseProgress | WorkflowAgentProgress;
