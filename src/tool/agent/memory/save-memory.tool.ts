import { TOOL_ERROR_CODE } from '../../../protocol';
import { defineTool } from '../../../tool/core/defineTool';
import { ok, fail } from '../../../tool/core/tool-result';
import {
  addFact,
  forgetEntry,
  loadMemory,
  summarizeMemory,
  updateMemory,
} from '../../../context/memory';

export default defineTool({
  name: 'save_memory',
  profiles: ['core'],
  risky: true,
  category: 'agent',
  activity: 'Saving a memory',
  label: 'Save Memory',
  description:
    'Remember durable knowledge about this project across sessions. Use for confirmed conventions, stack facts and user preferences — not for transient task state. ' +
    'Always pass action: to store one, {"action":"remember","text":"<the user\'s own sentence>","type":"convention"}; to show what is stored, {"action":"list"}; to drop an entry, {"action":"forget","index":2} from a list.',
  parameters: {
    type: 'object',
    properties: {
      action: {
        type: 'string',
        enum: ['remember', 'forget', 'list'],
        description: 'remember adds text; forget removes entry n from list; list shows what is stored',
      },
      text: { type: 'string', description: 'The fact or convention to remember (required for remember)' },
      index: { type: 'number', description: 'Entry number from list to remove (required for forget)' },
      type: { type: 'string', enum: ['convention', 'fact'], description: 'Explicit type classification (for remember). Convention = rule/preference, fact = observable truth.' },
    },
    required: ['action'],
  },
  preview(args) {
    return `save_memory ${args?.action ?? ''} ${args?.text ?? args?.index ?? ''}`.trim();
  },
  async execute(rawArgs, ctx) {
    const root = ctx?.state?.root ?? ctx?.root;
    if (!root) {
      return fail('No workspace root is available to hold project memory', { code: TOOL_ERROR_CODE.EUNKNOWN });
    }

    const args = rawArgs;

    if (args.action === 'list') {
      const mem = loadMemory(root);
      const lines: string[] = [];
      mem.conventions.forEach((c, i) => lines.push(`${i + 1}. [convention] ${c}`));
      mem.facts.forEach((f, i) =>
        lines.push(`${mem.conventions.length + i + 1}. [fact] ${f.text}`)
      );
      return ok({
        kind: 'text',
        display: lines.length
          ? `Project memory:\n${lines.join('\n')}`
          : 'Project memory is empty. Remember conventions and durable facts with action "remember".',
        data: { conventions: mem.conventions, facts: mem.facts.map((f) => f.text) },
      });
    }

    if (args.action === 'remember') {
      if (!args.text || !String(args.text).trim()) {
        // A placeholder in an example gets copied verbatim — the model stored the literal
        // "<the convention or fact>" instead of the user's sentence. A filled-in example shows
        // the shape and what belongs in it.
        return fail('remember needs the text to store', {
          code: TOOL_ERROR_CODE.EINVAL,
          hint: 'save_memory {"action":"remember","text":"this project uses pnpm, not npm","type":"convention"} — put the user\'s own sentence in text, not a placeholder',
        });
      }
      let storedAs = '';
      const mem = updateMemory(root, (m) => {
        const explicitType = args.type === 'convention' || args.type === 'fact' ? args.type : null;
        storedAs =
          explicitType ??
          (/\b(always|never|prefer|must|use |avoid )/i.test(String(args.text)) ? 'convention' : 'fact');
        if (storedAs === 'convention') {
          if (!m.conventions.includes(String(args.text).trim())) m.conventions.push(String(args.text).trim());
        } else {
          addFact(m, String(args.text), 'agent');
        }
      });
      return ok({
        kind: 'text',
        display: `Remembered as ${storedAs}: "${String(args.text).trim()}" — it will be available in future sessions. ${summarizeMemory(mem)}`,
        data: { storedAs },
      });
    }

    if (!Number.isInteger(args.index)) {
      return fail('forget needs the entry index shown by action "list"', {
        code: TOOL_ERROR_CODE.EINVAL,
        hint: 'Call save_memory {"action":"list"} first to get entry numbers.',
      });
    }
    let kind: any = null;
    updateMemory(root, (m) => {
      kind = forgetEntry(m, Number(args.index));
    });
    if (!kind) {
      return fail(`No memory entry ${args.index}`, {
        code: TOOL_ERROR_CODE.ENOENT,
        hint: 'Call save_memory {"action":"list"} first to get valid entry numbers.',
      });
    }
    const mem = loadMemory(root);
    return ok({
      kind: 'text',
      display: `Removed ${kind} ${args.index}. ${summarizeMemory(mem)}`,
      data: { removed: kind },
    });
  },
});

