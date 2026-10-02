export function buildClaudeMdPrompt({ stacks, commands, exists, retry = false }: any): string {
  const detected = stacks.length ? stacks.join(', ') : 'not auto-detected — figure it out from the files';
  const commandLines = Object.entries(commands)
    .map(([verb, cmd]: any) => `${verb}: ${cmd}`)
    .join(', ');
  const retryPreamble = retry
    ? [
        'A previous attempt at this exact task explored the project but never called write_file, so nothing ' +
          'was saved — try again. Keep exploration to the minimum needed (steps below), then make sure this ' +
          'response actually ends with a write_file call. Describing the content is not the deliverable.',
        '',
      ]
    : [];
  return [
    ...retryPreamble,
    'Write a OLLAMACODE.md file. This is a documentation task, not a code-review or test-running task — ' +
      'do not run the test suite or evaluate whether the code works; only describe the project.',
    '',
    `Detected stack: ${detected}`,
    commandLines ? `Detected commands: ${commandLines}` : 'No commands were auto-detected — check package.json/pyproject.toml/etc. yourself.',
    '',
    'Steps, in order:',
    '1. Explore the project (list_directory, find every nested project manifest, read package.json/pyproject.toml or equivalent, ' +
      'and grep_content for scripts/configuration) — do not guess what is there.',
    '2. Compose a short, scannable OLLAMACODE.md with four sections: Projects (each project directory and stack), Commands ' +
      '(exact test/build/lint/run commands for every project, verified from config files), Architecture (the main ' +
      'directories/modules and what each is responsible for), and Conventions (only ones with real evidence — linter ' +
      'config, consistent existing patterns, an existing CONVENTIONS.md — never invented).',
    '3. Call write_file with path "OLLAMACODE.md" and that content. The task is not finished until this call has been ' +
      'made — exploring the files is only step 1, not the deliverable.',
    '',
    exists
      ? 'A OLLAMACODE.md already exists — read it first (step 1), keep anything still accurate, and in step 3 change it with edit_file instead of write_file (write_file only creates files).'
      : 'No OLLAMACODE.md exists yet — write_file creates it.',
  ].join('\n');
}

export const MEMORY_BLOCK_HEADER =
  'PROJECT MEMORY — persistent knowledge about this workspace, kept across sessions. ' +
  'Honor the conventions; trust the facts over your own guesses.';
