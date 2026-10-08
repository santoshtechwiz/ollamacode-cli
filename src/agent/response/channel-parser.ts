import { REASONING_OPEN_RE, REASONING_CLOSE_RE, findFirstMatch, danglingTagPrefix } from './tags';

interface ChannelSplit {
  answer: string;
  reasoning: string;
}

interface ChannelParser {
  push: (chunk: string) => ChannelSplit;
  flush: () => ChannelSplit;
  inReasoning: () => boolean;
}

/** Structural reasoning/answer boundary: provider events bypass it, inline tags split here. Untagged prose is the answer. */
export function createChannelParser(initial: boolean = false): ChannelParser {
  let carry = '';
  let inside = Boolean(initial);

  function push(chunk: string): ChannelSplit {
    let text = carry + String(chunk ?? '');
    carry = '';
    let answer = '';
    let reasoning = '';

    for (;;) {
      if (!inside) {
        const open = findFirstMatch(text, REASONING_OPEN_RE);
        const close = findFirstMatch(text, REASONING_CLOSE_RE);

        // Closer before opener: the chat template prefilled the opener, so only the closer streams back.
        if (close && (!open || close.index < open.index)) {
          reasoning += text.slice(0, close.index);
          text = text.slice(close.index + close.length);
          continue;
        }

        if (open) {
          answer += text.slice(0, open.index);
          text = text.slice(open.index + open.length);
          inside = true;
          continue;
        }
        const hold = danglingTagPrefix(text);
        answer += hold ? text.slice(0, text.length - hold) : text;
        carry = hold ? text.slice(text.length - hold) : '';
        break;
      }

      const close = findFirstMatch(text, REASONING_CLOSE_RE);
      if (close) {
        reasoning += text.slice(0, close.index);
        text = text.slice(close.index + close.length);
        inside = false;
        continue;
      }
      const hold = danglingTagPrefix(text);
      reasoning += hold ? text.slice(0, text.length - hold) : text;
      carry = hold ? text.slice(text.length - hold) : '';
      break;
    }

    return { answer, reasoning };
  }

  function flush(): ChannelSplit {
    const held = carry;
    carry = '';
    if (!held) return { answer: '', reasoning: '' };
    if (inside) return { answer: '', reasoning: held };
    // A held tag-shaped fragment never completed: quarantine, don't display.
    if (danglingTagPrefix(held) === held.length && held.length > 0) {
      return { answer: '', reasoning: held };
    }
    return { answer: held, reasoning: '' };
  }

  return { push, flush, inReasoning: () => inside };
}
