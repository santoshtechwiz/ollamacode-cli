/**
 * Minimal typed planning contract.
 *
 * Turn owns the agent lifecycle. Planning only answers "What should be done
 * next?" — it never executes tools, never loops, never retries internally.
 */

export type PlanStepType = 'inspect' | 'edit' | 'run' | 'verify';

export type PlanStepStatus = 'pending' | 'completed' | 'failed';

export interface PlanStep {
  readonly id: string;
  readonly description: string;
  readonly type: PlanStepType;
  status: PlanStepStatus;
}

export interface Plan {
  readonly id: string;
  readonly goal: string;
  readonly steps: readonly PlanStep[];
  /** The plan as the model wrote it, shown to the person once for approval. */
  readonly text?: string;
  /** The files the model listed as the plan's scope, checked against disk; absent when it wrote the plan only in words. */
  readonly files?: { readonly create: readonly string[]; readonly edit: readonly string[]; readonly del: readonly string[] };
}

export type PlanningResult =
  | {
      readonly kind: 'PLAN';
      readonly plan: Plan;
    }
  | {
      readonly kind: 'NO_PLAN';
      readonly reason: string;
    }
  | {
      readonly kind: 'CLARIFICATION';
      readonly reason: string;
    };

export type PlanningReason =
  | 'INITIAL'
  | 'NEW_INFORMATION'
  | 'VERIFICATION_FAILED'
  | 'BLOCKED';

export interface Observation {
  readonly text: string;
}

export interface PlanningContext {
  readonly goal: string;
  readonly observations: readonly Observation[];
  readonly reason: PlanningReason;
  /** User feedback when replanning (e.g. plan was not approved). */
  readonly feedback?: string;
  /** Stack-declared test commands, used only for the verification hint. */
  readonly stacks?: readonly { readonly test?: readonly string[] }[];
}

export interface Planner {
  /** The plan the model presented, read into the typed plan Turn executes. */
  /** `files`: the scope the model listed with the plan, when it listed one. */
  fromPresented(context: PlanningContext, presented: string, files?: readonly string[] | null, steps?: readonly string[] | null): Promise<PlanningResult>;
}
