function globToRegexSource(glob: string): string {
  let out = '';
  for (let i = 0; i < glob.length; i++) {
    const ch = glob[i];
    if (ch === '\\' && i + 1 < glob.length) {
      const next = glob[i + 1];
      out += `\\${next}`;
      i += 1;
      continue;
    }
    switch (ch) {
      case '*': {
        if (glob[i + 1] === '*') {
          i += 1;
          while (glob[i + 1] === '*') i += 1;
          if (glob[i + 1] === '/') {
            i += 1;
            out += '(?:.*/)?';
          } else {
            out += '.*';
          }
        } else {
          out += '[^/]*';
        }
        break;
      }
      case '?':
        out += '[^/]';
        break;
      case '[': {
        let end = -1;
        for (let j = i + 1; j < glob.length; j++) {
          if (glob[j] === ']' && j > i + 1) {
            end = j;
            break;
          }
        }
        if (end === -1) {
          out += '\\[';
        } else {
          let body = glob.slice(i + 1, end);
          if (body.startsWith('!') || body.startsWith('^')) {
            body = `^${body.slice(1).replace(/\\/g, '\\\\')}`;
          }
          out += `[${body}]`;
          i = end;
        }
        break;
      }
      case '{': {
        const end = glob.indexOf('}', i + 1);
        if (end === -1) {
          out += '\\{';
        } else {
          const alts = glob.slice(i + 1, end).split(',');
          out += `(?:${alts.map(globToRegexSource).join('|')})`;
          i = end;
        }
        break;
      }
      default:
        out += ch.replace(/[.+^${}()|[\]\\]/g, '\\$&');
    }
  }
  return out;
}

function splitTopLevel(pattern: string): string[] {
  const parts: string[] = [];
  let braceDepth = 0;
  let bracketDepth = 0;
  let current = '';
  for (const ch of pattern) {
    if (ch === '{' && bracketDepth === 0) braceDepth += 1;
    else if (ch === '}' && bracketDepth === 0) braceDepth = Math.max(0, braceDepth - 1);
    else if (ch === '[' && braceDepth === 0) bracketDepth += 1;
    else if (ch === ']' && braceDepth === 0) bracketDepth = Math.max(0, bracketDepth - 1);

    if (ch === ',' && braceDepth === 0 && bracketDepth === 0) {
      parts.push(current);
      current = '';
    } else {
      current += ch;
    }
  }
  parts.push(current);
  return parts.map((p) => p.trim()).filter(Boolean);
}

interface MatchOptions {
  caseSensitive?: boolean;
}

export function makeGlobMatcher(pattern: string | undefined | null, { caseSensitive = true }: MatchOptions = {}): (relPath: string) => boolean {
  if (!pattern || String(pattern).trim() === '') return () => true;

  const globs = splitTopLevel(String(pattern));

  const matchers = globs.map((glob) => {
    const dirPrefix = glob.endsWith('/') ? glob.slice(0, -1) : null;
    if (dirPrefix !== null) {
      const re = new RegExp(`^${globToRegexSource(dirPrefix)}(?:/.*)?$`, caseSensitive ? '' : 'i');
      return { re, anchored: true };
    }
    const anchored = glob.includes('/');
    const re = new RegExp(`^${globToRegexSource(glob)}$`, caseSensitive ? '' : 'i');
    return { re, anchored };
  });

  return (relPath) => {
    const rel = String(relPath).split('\\').join('/');
    const base = rel.slice(rel.lastIndexOf('/') + 1);
    return matchers.some(({ re, anchored }) => re.test(anchored ? rel : base));
  };
}

export function compilePattern(pattern: string, { caseSensitive = false }: MatchOptions = {}): { re: RegExp; } | { error: string; } {
  try {
    return { re: new RegExp(pattern, caseSensitive ? '' : 'i') };
  } catch (err) {
    return { error: `Invalid regular expression: ${ (err as Error).message}` };
  }
}

