import { TOOL_ERROR_CODE } from '../../../protocol';
import { defineTool } from '../../../tool/core/defineTool';
import { ok, fail } from '../../../tool/core/tool-result';

const MAX_QUESTIONS_PER_TURN = 1;

export default defineTool({
  name: 'ask_user',
  profiles: ['core', 'always'],
  category: 'agent',
  activity: 'Waiting for your answer',
  label: 'Ask User',
  description:
    'Ask the user one short question when the request is missing something you cannot safely guess — ' +
    'a project name, where files should go, or which language or framework to use. ' +
    'Prefer this over assuming. Do not use it for things you can find out with a tool.',
  parameters: {
    type: 'object',
    properties: {
      question: { type: 'string', description: 'One specific question, in plain language' },
      options: {
        type: 'array',
        description: 'Optional list of choices to offer instead of free text',
      },
    },
    required: ['question'],
  },
  volatile: true,

  preview(args) {
    return `ask: ${String(args?.question ?? '').slice(0, 120)}`;
  },
  async execute(args, ctx) {
    const question = String(args.question ?? '').trim();
    if (!question) {
      return fail('question must not be empty', { code: TOOL_ERROR_CODE.EINVAL });
    }

    const state = ctx?.state;
    const asked = state?.questionsAsked ?? 0;
    if (asked >= MAX_QUESTIONS_PER_TURN) {
      return ok({
        kind: 'text',
        display: `Question limit reached after ${asked} question(s). Continue using a sensible default and state the assumption.`,
        data: { questionLimitReached: true, questionsAsked: asked },
      });
    }

    if (typeof ctx?.ask !== 'function') {
      if (state) state.questionsAsked = asked + 1;
      return ok({
        kind: 'text',
        display: 'No interactive terminal is available. Continue with a conservative default and state the assumption.',
        data: { assumed: true, interactiveUnavailable: true, question },
      });
    }

    const options = Array.isArray(args.options)
      ? args.options.map((o: unknown) => String(o)).filter((o: string) => o.trim() !== '')
      : [];

    if (state) state.questionsAsked = asked + 1;

    let answer;
    try {
      answer = await ctx.ask(question, options);
    } catch {
      return ok({
        kind: 'text',
        display: 'The question was unavailable. Continue with a conservative default and state the assumption.',
        data: { assumed: true, questionUnavailable: true, question },
      });
    }

    const text = String(answer ?? '').trim();
    if (!text) {
      return ok({
        kind: 'text',
        display: 'The question was cancelled. Continue with a conservative default and state the assumption.',
        data: { assumed: true, cancelled: true, question },
      });
    }

    return ok({
      kind: 'text',
      display: `The user answered: ${text}`,
      data: { question, answer: text },
    });
  },
});
