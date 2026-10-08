import type { ShellExecutionResult, CommandClassification, Diagnostic, VerificationMetadata } from '../types';

const FILE_LOCK_PATTERNS = [
  /MSB3021|MSB3027/i,
  /being used by another process/i,
  /access (?:to the path .* )?is denied/i,
  /text file busy|ETXTBSY/i,
  /\bE(?:TXTBSY|BUSY|ACCES|PERM)\b/i,
];

const PORT_IN_USE_PATTERNS = [
  /EADDRINUSE/i,
  /address already in use/i,
];

function detectInfraFailure(
  execution: ShellExecutionResult
): 'file-lock' | 'port-in-use' | 'none' {
  const combined = `${execution.stdout}\n${execution.stderr}`;

  if (FILE_LOCK_PATTERNS.some((p) => p.test(combined))) {
    return 'file-lock';
  }

  if (PORT_IN_USE_PATTERNS.some((p) => p.test(combined))) {
    return 'port-in-use';
  }

  return 'none';
}

export function createVerificationMetadata(input: {
  execution: ShellExecutionResult;
  classification: CommandClassification;
  diagnostics: Diagnostic[];
}): VerificationMetadata {
  const { execution, classification, diagnostics } = input;

  const infraFailure = detectInfraFailure(execution);

  const intentMap: Record<CommandClassification['category'], VerificationMetadata['intent']> = {
    test: 'test',
    lint: 'lint',
    build: 'build',
    typecheck: 'typecheck',
    check: 'check',
    server: 'none',
    script: 'none',
    query: 'none',
    mutation: 'none',
    unknown: 'none',
  };

  const intent = intentMap[classification.category] ?? 'none';

  const hasErrorDiagnostics = diagnostics.some(
    (d) => d.severity === 'error' || d.severity === 'failure'
  );

  const passed =
    execution.exitCode === 0 &&
    !hasErrorDiagnostics &&
    infraFailure === 'none' &&
    !execution.timedOut &&
    !execution.cancelled &&
    !execution.spawnError;

  const primaryDiagnostic = diagnostics.find(
    (d) => d.severity === 'error' || d.severity === 'failure'
  );

  return {
    intent,
    passed,
    exitCode: execution.exitCode,
    diagnostics,
    primaryDiagnostic,
    classification,
    infraFailure,
    recoveryAttempted: false,
    recoverySucceeded: null,
  };
}

export function updateVerificationWithRecovery(
  verification: VerificationMetadata,
  recoveryAttempted: boolean,
  recoverySucceeded: boolean | null
): VerificationMetadata {
  return {
    ...verification,
    recoveryAttempted,
    recoverySucceeded,
    passed: recoverySucceeded === true ? true : verification.passed,
    infraFailure: recoverySucceeded === true ? 'none' : verification.infraFailure,
  };
}