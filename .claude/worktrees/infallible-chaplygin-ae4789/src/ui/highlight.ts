import { colorEnabled, cyan, green, yellow, magenta, gray } from './ansi';

const STRING_RULES = [
  { re: /^"(?:[^"\\\n]|\\.)*"?/, color: green },
  { re: /^'(?:[^'\\\n]|\\.)*'?/, color: green },
  { re: /^`(?:[^`\\]|\\.)*`?/, color: green },
];

const NUMBER_RULE = { re: /^\b\d[\d_]*(?:\.\d+)?\b/, color: yellow };

const kw = (words: string): RegExp => new RegExp(`^\\b(?:${words.split(' ').join('|')})\\b`);

const LANGUAGES = {
  js: [
    { re: /^\/\/.*/, color: gray },
    { re: /^\/\*[\s\S]*?(?:\*\/|$)/, color: gray },
    ...STRING_RULES,
    {
      re: kw(
        'const let var function return if else for while do break continue class extends new this typeof instanceof async await try catch finally throw switch case default import export from as of in delete void yield static get set'
      ),
      color: magenta,
    },
    { re: kw('true false null undefined NaN Infinity'), color: yellow },
    NUMBER_RULE,
  ],
  json: [
    { re: /^"(?:[^"\\\n]|\\.)*"(?=\s*:)/, color: cyan },
    ...STRING_RULES,
    { re: kw('true false null'), color: yellow },
    NUMBER_RULE,
  ],
  python: [
    { re: /^#.*/, color: gray },
    { re: /^(?:"""|''')[\s\S]*?(?:"""|'''|$)/, color: green },
    ...STRING_RULES,
    {
      re: kw(
        'def class return if elif else for while break continue import from as pass raise try except finally with lambda yield global nonlocal assert del in is not and or await async'
      ),
      color: magenta,
    },
    { re: kw('True False None self'), color: yellow },
    NUMBER_RULE,
  ],
  shell: [
    { re: /^#.*/, color: gray },
    ...STRING_RULES,
    { re: /^\s-{1,2}[A-Za-z][\w-]*/, color: yellow },
    { re: /^\$\{?[A-Za-z_][\w]*\}?/, color: cyan },
    {
      re: kw(
        'if then else elif fi for while do done case esac function return export source cd echo exit set unset local sudo'
      ),
      color: magenta,
    },
    NUMBER_RULE,
  ],
  powershell: [
    { re: /^#.*/, color: gray },
    ...STRING_RULES,
    { re: /^\s-{1,2}[A-Za-z][\w-]*/, color: yellow },
    { re: /^\$[A-Za-z_][\w:]*/, color: cyan },
    {
      re: kw(
        'if else elseif foreach for while do function return param begin process end try catch finally throw switch break continue'
      ),
      color: magenta,
    },
    NUMBER_RULE,
  ],
};

const ALIASES = {
  javascript: 'js',
  js: 'js',
  jsx: 'js',
  ts: 'js',
  typescript: 'js',
  tsx: 'js',
  mjs: 'js',
  cjs: 'js',
  node: 'js',
  json: 'json',
  json5: 'json',
  py: 'python',
  python: 'python',
  python3: 'python',
  sh: 'shell',
  bash: 'shell',
  zsh: 'shell',
  shell: 'shell',
  console: 'shell',
  terminal: 'shell',
  cmd: 'shell',
  bat: 'shell',
  powershell: 'powershell',
  ps: 'powershell',
  ps1: 'powershell',
  pwsh: 'powershell',
} as const;

export function highlightLine(line: string, lang: string): string {
  const text = String(line ?? '');
  const rules = LANGUAGES[ALIASES[ (lang as keyof typeof ALIASES)]];
  if (!colorEnabled() || !rules || text === '') return text;

  let out = '';
  let i = 0;
  while (i < text.length) {
    const rest = text.slice(i);
    let matched = false;
    for (const rule of rules) {
      const m = rule.re.exec(rest);
      if (m && m[0].length > 0) {
        out += rule.color(m[0]);
        i += m[0].length;
        matched = true;
        break;
      }
    }
    if (!matched) {
      out += text[i];
      i += 1;
    }
  }
  return out;
}

export function langFromPath(path: string | null | undefined): string {
  const ext = /\.([A-Za-z0-9]+)$/.exec(String(path ?? ''))?.[1]?.toLowerCase();
  return ext && ALIASES[ (ext as keyof typeof ALIASES)] ? ext : '';
}

