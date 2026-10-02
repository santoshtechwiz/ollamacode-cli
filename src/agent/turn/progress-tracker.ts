import { signatureOf, type ToolCallRecord } from './turn-state';

export type Phase =
  | 'OBSERVE'
  | 'DIAGNOSE'
  | 'ACT'
  | 'VERIFY'
  | 'COMPLETE';

export type EvidenceType =
  | 'observation'
  | 'diagnosis'
  | 'mutation'
  | 'verification';

export interface ProgressDecision {
  action: 'CONTINUE' | 'ACT' | 'VERIFY' | 'COMPLETE' | 'STOP';
  phase: Phase;
  reason: string;
  evidence: string[];
  /**
   * Whether the current round recorded any new evidence.
   * Progress is what the current round produced, not what
   * earlier rounds accumulated.
   */
  madeProgress: boolean;
}

interface Evidence {
  type: EvidenceType;
  callSignature: string;
  success: boolean;
}

export class ProgressTracker {
  private phase: Phase = 'OBSERVE';
  private readonly evidence: Evidence[] = [];
  private roundStart = 0;
  private bookkeeping = false;

  /** The round did housekeeping (task list, loading a schema) rather than work: not a stall, and never progress. */
  recordBookkeeping(): void {
    this.bookkeeping = true;
  }

  recordResult(
    call: ToolCallRecord,
    type: EvidenceType,
    success: boolean,
  ): void {
    this.evidence.push({
      type,
      callSignature: signatureOf(call),
      success,
    });

    this.transition(type, success);
  }

  /**
   * Marks the start of a round. Progress is judged per round:
   * only evidence recorded since the last call counts toward
   * the current decision.
   */
  beginRound(): void {
    this.roundStart = this.evidence.length;
    this.bookkeeping = false;
  }

  decide(): ProgressDecision {
    const evidence = this.recentEvidence();
    const madeProgress =
      this.evidence.length > this.roundStart;

    switch (this.phase) {
      case 'OBSERVE':
        return {
          action: 'CONTINUE',
          phase: this.phase,
          reason: 'Continue gathering information',
          evidence,
          madeProgress,
        };

      case 'DIAGNOSE':
        return {
          action: 'ACT',
          phase: this.phase,
          reason: 'Observation failed; take corrective action',
          evidence,
          madeProgress,
        };

      case 'ACT':
        return {
          action: 'CONTINUE',
          phase: this.phase,
          reason: 'Continue the current action',
          evidence,
          madeProgress,
        };

      case 'VERIFY':
        // VERIFY needs a genuine verification need: a mutation in
        // this round. Historical mutation evidence alone means the
        // round produced nothing new.
        if (!madeProgress) {
          // Marking a step done is not repeating it. A model that keeps its list current between
          // two changes has not stalled, and reading the round that closed a step as a repeat
          // would end the turn on the very bookkeeping the task list exists for.
          if (this.bookkeeping) {
            return {
              action: 'CONTINUE',
              phase: this.phase,
              reason:
                'The round only did housekeeping; the work it prepares is still to do',
              evidence,
              madeProgress,
            };
          }

          return {
            action: 'STOP',
            phase: this.phase,
            reason:
              'Model repeated previously successful tool calls without making progress',
            evidence,
            madeProgress,
          };
        }

        return {
          action: 'VERIFY',
          phase: this.phase,
          reason: 'Changes require verification',
          evidence,
          madeProgress,
        };

      case 'COMPLETE':
        return {
          action: 'COMPLETE',
          phase: this.phase,
          reason: 'Verification passed',
          evidence,
          madeProgress,
        };
    }
  }

  getPhase(): Phase {
    return this.phase;
  }

  getEvidence(): readonly Evidence[] {
    return this.evidence;
  }

  reset(): void {
    this.phase = 'OBSERVE';
    this.evidence.length = 0;
    this.roundStart = 0;
    this.bookkeeping = false;
  }

  private transition(type: EvidenceType, success: boolean): void {
    switch (type) {
      case 'observation':
        this.phase = success ? 'OBSERVE' : 'DIAGNOSE';
        return;

      case 'diagnosis':
        this.phase = success ? 'ACT' : 'DIAGNOSE';
        return;

      case 'mutation':
        this.phase = 'VERIFY';
        return;

      case 'verification':
        this.phase = success ? 'COMPLETE' : 'ACT';
        return;
    }
  }

  private recentEvidence(): string[] {
    return this.evidence.slice(-5).map(
      evidence =>
        `${evidence.type}:${evidence.callSignature.split(':')[0]}=${evidence.success ? 'ok' : 'fail'}`,
    );
  }
}