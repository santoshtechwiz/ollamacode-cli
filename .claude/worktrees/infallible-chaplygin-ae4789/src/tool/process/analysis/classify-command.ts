import type { CommandClassification } from '../types';

const TEST_PATTERNS = [
  /\b(npm|pnpm|yarn)\s+(test|run\s+test)\b/i,
  /\bjest\b/i,
  /\bvitest\b/i,
  /\bmocha\b/i,
  /\bplaywright\s+test\b/i,
  /\bcypress\s+run\b/i,
  /\bdotnet\s+test\b/i,
  /\bcargo\s+test\b/i,
  /\bgo\s+test\b/i,
  /\bpytest\b/i,
  /\bpython\s+-m\s+pytest\b/i,
  /\bmvn\s+test\b/i,
  /\bgradle\s+test\b/i,
];

const LINT_PATTERNS = [
  /\b(npm|pnpm|yarn)\s+(lint|run\s+lint)\b/i,
  /\beslint\b/i,
  /\btslint\b/i,
  /\bstylelint\b/i,
  /\bdotnet\s+format\b/i,
  /\bcargo\s+clippy\b/i,
  /\bgolangci-lint\b/i,
  /\bflake8\b/i,
  /\bpylint\b/i,
  /\bmvn\s+checkstyle:check\b/i,
  /\bgradle\s+checkstyle\b/i,
];

const BUILD_PATTERNS = [
  /\b(npm|pnpm|yarn)\s+(build|run\s+build|ci)\b/i,
  /\bdotnet\s+(build|publish|restore|pack)\b/i,
  /\bmsbuild\b/i,
  /\bcargo\s+(build|check)\b/i,
  /\bgo\s+build\b/i,
  /\bmvn\s+(compile|package|install)\b/i,
  /\bgradle\s+(build|assemble)\b/i,
  /\bdocker\s+build\b/i,
  /\bnext\s+build\b/i,
  /\bvite\s+build\b/i,
  /\bwebpack\b/i,
  /\btsc\b(?!\s+--noEmit)/i,
];

const TYPECHECK_PATTERNS = [
  /\b(npm|pnpm|yarn)\s+(typecheck|type-check|run\s+typecheck)\b/i,
  /\btsc\s+(--noEmit|--build)\b/i,
  /\bdotnet\s+build\b/i,
  /\bcargo\s+check\b/i,
  /\bgolangci-lint\b/i,
  /\bmvn\s+compile\b/i,
];

const CHECK_PATTERNS = [
  /\b(npm|pnpm|yarn)\s+(check|run\s+check)\b/i,
  /\bdotnet\s+build\b/i,
  /\bcargo\s+check\b/i,
  /\bgo\s+vet\b/i,
];

const SERVER_PATTERNS = [
  /\b(npm|pnpm|yarn)\s+(start|run\s+(dev|start|serve|watch))\b/i,
  /\bvite\b/i,
  /\bnodemon\b/i,
  /\bnext\s+dev\b/i,
  /\bng\s+serve\b/i,
  /\bwebpack(?:-dev)?-server\b/i,
  /\bflask\s+run\b/i,
  /\b(uvicorn|gunicorn)\b/i,
  /\bmanage\.py\s+runserver\b/i,
  /\bgo\s+run\b/i,
  /\bcargo\s+(run|watch)\b/i,
  /\brails\s+s(?:erver)?\b/i,
  /\bphp\s+-S\b/i,
  /\bdotnet\s+run\b/i,
  /\bpython\s+-m\s+http\.server\b/i,
];

const QUERY_PATTERNS = [
  /^\s*(ls|dir|find|grep|rg|Get-ChildItem|gci|Get-Process|pgrep|pidof|ps|netstat|ss|sc\s+query)\b/i,
  /^\s*(cat|type|head|tail|less|more|Get-Content|gc)\b/i,
  /^\s*(git\s+(status|diff|log|show|blame|ls-files))\b/i,
];

const MUTATION_PATTERNS = [
  /\b(npm|pnpm|yarn)\s+(install|ci|add|remove)\b/i,
  /\bdotnet\s+(add|remove|restore)\b/i,
  /\bcargo\s+(add|remove|update|install)\b/i,
  /\bgo\s+(get|mod\s+(tidy|download))\b/i,
  /\bpip\s+install\b/i,
  /\bmvn\s+(dependency:resolve|install)\b/i,
  /\bgradle\s+dependencies\b/i,
  /\bgit\s+(add|commit|push|pull|merge|rebase|checkout|reset)\b/i,
];

function matchPatterns(command: string, patterns: RegExp[]): boolean {
  return patterns.some((p) => p.test(command));
}

function extractSubcommand(command: string): string | undefined {
  const parts = command.trim().split(/\s+/);
  if (parts.length >= 2) {
    return parts[1];
  }
  return undefined;
}

function extractTargets(command: string): string[] {
  const targets: string[] = [];
  const projectFilePatterns = [
    /package\.json/gi,
    /tsconfig\.json/gi,
    /\.csproj/gi,
    /\.sln/gi,
    /Cargo\.toml/gi,
    /go\.mod/gi,
    /pom\.xml/gi,
    /build\.gradle/gi,
    /pyproject\.toml/gi,
    /requirements\.txt/gi,
    /setup\.py/gi,
    /\.test\.(ts|js|tsx|jsx)/gi,
    /\.spec\.(ts|js|tsx|jsx)/gi,
    /test[/\\]/gi,
    /spec[/\\]/gi,
    /jest\.config/gi,
    /vitest\.config/gi,
    /\.eslintrc/gi,
    /eslint\.config/gi,
  ];

  for (const pattern of projectFilePatterns) {
    const matches = command.match(pattern);
    if (matches) {
      targets.push(...matches);
    }
  }

  return [...new Set(targets)];
}

export function classifyCommand(command: string): CommandClassification {
  if (matchPatterns(command, TEST_PATTERNS)) {
    return {
      category: 'test',
      confidence: 'high',
      ecosystem: detectEcosystem(command),
      subcommand: extractSubcommand(command),
      targets: extractTargets(command),
    };
  }

  if (matchPatterns(command, LINT_PATTERNS)) {
    return {
      category: 'lint',
      confidence: 'high',
      ecosystem: detectEcosystem(command),
      subcommand: extractSubcommand(command),
      targets: extractTargets(command),
    };
  }

  if (matchPatterns(command, BUILD_PATTERNS)) {
    return {
      category: 'build',
      confidence: 'high',
      ecosystem: detectEcosystem(command),
      subcommand: extractSubcommand(command),
      targets: extractTargets(command),
    };
  }

  if (matchPatterns(command, TYPECHECK_PATTERNS)) {
    return {
      category: 'typecheck',
      confidence: 'high',
      ecosystem: detectEcosystem(command),
      subcommand: extractSubcommand(command),
      targets: extractTargets(command),
    };
  }

  if (matchPatterns(command, CHECK_PATTERNS)) {
    return {
      category: 'check',
      confidence: 'high',
      ecosystem: detectEcosystem(command),
      subcommand: extractSubcommand(command),
      targets: extractTargets(command),
    };
  }

  if (matchPatterns(command, SERVER_PATTERNS)) {
    return {
      category: 'server',
      confidence: 'high',
      ecosystem: detectEcosystem(command),
      subcommand: extractSubcommand(command),
      targets: extractTargets(command),
    };
  }

  if (matchPatterns(command, QUERY_PATTERNS)) {
    return {
      category: 'query',
      confidence: 'medium',
      ecosystem: detectEcosystem(command),
      subcommand: extractSubcommand(command),
      targets: extractTargets(command),
    };
  }

  if (matchPatterns(command, MUTATION_PATTERNS)) {
    return {
      category: 'mutation',
      confidence: 'medium',
      ecosystem: detectEcosystem(command),
      subcommand: extractSubcommand(command),
      targets: extractTargets(command),
    };
  }

  return {
    category: 'unknown',
    confidence: 'low',
    ecosystem: detectEcosystem(command),
    subcommand: extractSubcommand(command),
    targets: extractTargets(command),
  };
}

function detectEcosystem(command: string): CommandClassification['ecosystem'] {
  const lower = command.toLowerCase();
  if (/\b(npm|pnpm|yarn|node|npx|tsc|jest|vitest|eslint|vite|next|webpack)\b/.test(lower)) return 'npm';
  if (/\b(dotnet|msbuild|nuget)\b/.test(lower)) return 'dotnet';
  if (/\b(cargo|rustc)\b/.test(lower)) return 'cargo';
  if (/\b(go|golang)\b/.test(lower)) return 'go';
  if (/\b(mvn|maven)\b/.test(lower)) return 'maven';
  if (/\b(gradle|gradlew)\b/.test(lower)) return 'gradle';
  if (/\b(python|pip|pytest|uvicorn|gunicorn|flask|django)\b/.test(lower)) return 'python';
  return 'generic';
}