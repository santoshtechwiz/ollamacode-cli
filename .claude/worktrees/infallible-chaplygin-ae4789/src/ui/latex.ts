import { escapeRegExp } from '../core/text-utils';

const TEXT_COMMANDS = [
  '\\text', '\\mathrm', '\\mathbf', '\\mathit', '\\mathsf',
  '\\mathtt', '\\mathcal', '\\operatorname',
];

const BRACE_COMMANDS = ['\\frac', '\\dfrac', '\\tfrac', '\\sqrt', '\\surd', '\\boxed'];

/** Operator names LaTeX sets upright: shown as the plain word (`\\log n` → `log n`). */
const OPERATORS = [
  'log', 'ln', 'lg', 'exp', 'sin', 'cos', 'tan', 'cot', 'sec', 'csc', 'arcsin', 'arccos', 'arctan',
  'sinh', 'cosh', 'tanh', 'max', 'min', 'sup', 'inf', 'lim', 'limsup', 'liminf', 'arg', 'det', 'dim',
  'ker', 'deg', 'gcd', 'lcm', 'Pr', 'mod',
];

/** Spacing commands: a space, or nothing for the negative one. */
const SPACING: Array<[string, string]> = [['\\quad', ' '], ['\\qquad', ' '], ['\\,', ' '], ['\\;', ' '], ['\\:', ' '], ['\\!', '']];

const SYMBOLS = new Map([
  ['\\mathbb{R}', 'ℝ'],
  ['\\mathbb{N}', 'ℕ'],
  ['\\mathbb{Z}', 'ℤ'],
  ['\\mathbb{Q}', 'ℚ'],
  ['\\mathbb{C}', 'ℂ'],
  ['\\mathbb{P}', 'ℙ'],
  ['\\alpha', 'α'], ['\\beta', 'β'], ['\\gamma', 'γ'], ['\\delta', 'δ'],
  ['\\epsilon', 'ε'], ['\\zeta', 'ζ'], ['\\eta', 'η'], ['\\theta', 'θ'],
  ['\\iota', 'ι'], ['\\kappa', 'κ'], ['\\lambda', 'λ'], ['\\mu', 'μ'],
  ['\\nu', 'ν'], ['\\xi', 'ξ'], ['\\omicron', 'ο'], ['\\pi', 'π'],
  ['\\rho', 'ρ'], ['\\sigma', 'σ'], ['\\tau', 'τ'], ['\\upsilon', 'υ'],
  ['\\phi', 'φ'], ['\\chi', 'χ'], ['\\psi', 'ψ'], ['\\omega', 'ω'],
  ['\\Gamma', 'Γ'], ['\\Delta', 'Δ'], ['\\Theta', 'Θ'], ['\\Lambda', 'Λ'],
  ['\\Xi', 'Ξ'], ['\\Pi', 'Π'], ['\\Sigma', 'Σ'], ['\\Upsilon', 'Υ'],
  ['\\Phi', 'Φ'], ['\\Psi', 'Ψ'], ['\\Omega', 'Ω'],
  ['\\varphi', 'φ'], ['\\varepsilon', 'ε'], ['\\vartheta', 'θ'],
  ['\\subset', '⊂'], ['\\supset', '⊃'], ['\\subseteq', '⊆'], ['\\supseteq', '⊇'],
  ['\\in', '∈'], ['\\notin', '∉'], ['\\ni', '∋'],
  ['\\cup', '∪'], ['\\cap', '∩'], ['\\setminus', '\\'],
  ['\\cdot', '·'], ['\\times', '×'], ['\\pm', '±'], ['\\mp', '∓'],
  ['\\infty', '∞'], ['\\forall', '∀'], ['\\exists', '∃'],
  ['\\implies', '⇒'], ['\\impliedby', '⇐'], ['\\iff', '⇔'],
  ['\\to', '→'], ['\\rightarrow', '→'], ['\\leftarrow', '←'], ['\\mapsto', '↦'],
  ['\\le', '≤'], ['\\leq', '≤'], ['\\ge', '≥'], ['\\geq', '≥'],
  ['\\ne', '≠'], ['\\neq', '≠'], ['\\approx', '≈'], ['\\equiv', '≡'],
  ['\\sqrt', '√'], ['\\sum', '∑'], ['\\prod', '∏'], ['\\int', '∫'],
  ['\\partial', '∂'], ['\\nabla', '∇'],
  ['\\emptyset', '∅'], ['\\varnothing', '∅'],
  ['\\land', '∧'], ['\\lor', '∨'], ['\\wedge', '∧'], ['\\vee', '∨'],
  ['\\lnot', '¬'], ['\\neg', '¬'],
  ['\\mid', '∣'], ['\\nmid', '∤'], ['\\parallel', '∥'], ['\\perp', '⊥'],
  ['\\sim', '∼'], ['\\simeq', '≃'], ['\\cong', '≅'], ['\\propto', '∝'],
  ['\\angle', '∠'],
  ['\\oplus', '⊕'], ['\\otimes', '⊗'], ['\\odot', '⊙'], ['\\ominus', '⊖'],
  ['\\oslash', '⊘'], ['\\div', '÷'], ['\\circ', '∘'], ['\\bullet', '•'],
  ['\\ast', '∗'], ['\\star', '⋆'], ['\\prime', '′'],
  ['\\dots', '…'], ['\\ldots', '…'], ['\\cdots', '⋯'], ['\\dotsb', '…'],
  ['\\vdots', '⋮'],
  ['\\hbar', 'ℏ'], ['\\ell', 'ℓ'], ['\\degree', '°'],
  ['\\langle', '⟨'], ['\\rangle', '⟩'],
  ['\\{', '{'], ['\\}', '}'], ['\\(', '('], ['\\)', ')'],
  ['\\[', '['], ['\\]', ']'],
  ['\\&', '&'], ['\\%', '%'], ['\\$', '$'], ['\\#', '#'], ['\\_', '_'],
  ...OPERATORS.map((name): [string, string] => [`\\${name}`, name]),
  // The binary mod is set as the same word.
  ['\\bmod', 'mod'],
]);

const SUPERSCRIPTS = new Map([
  ['0', '⁰'], ['1', '¹'], ['2', '²'], ['3', '³'], ['4', '⁴'],
  ['5', '⁵'], ['6', '⁶'], ['7', '⁷'], ['8', '⁸'], ['9', '⁹'],
  ['+', '⁺'], ['-', '⁻'], ['=', '⁼'], ['(', '⁽'], [')', '⁾'],
  ['a', 'ᵃ'], ['b', 'ᵇ'], ['c', 'ᶜ'], ['d', 'ᵈ'], ['e', 'ᵉ'], ['f', 'ᶠ'],
  ['g', 'ᵍ'], ['h', 'ʰ'], ['i', 'ⁱ'], ['j', 'ʲ'], ['k', 'ᵏ'], ['l', 'ˡ'],
  ['m', 'ᵐ'], ['n', 'ⁿ'], ['o', 'ᵒ'], ['p', 'ᵖ'], ['r', 'ʳ'], ['s', 'ˢ'],
  ['t', 'ᵗ'], ['u', 'ᵘ'], ['v', 'ᵛ'], ['w', 'ʷ'], ['x', 'ˣ'], ['y', 'ʸ'], ['z', 'ᶻ'],
]);

const SUBSCRIPTS = new Map([
  ['0', '₀'], ['1', '₁'], ['2', '₂'], ['3', '₃'], ['4', '₄'],
  ['5', '₅'], ['6', '₆'], ['7', '₇'], ['8', '₈'], ['9', '₉'],
  ['+', '₊'], ['-', '₋'], ['=', '₌'], ['(', '₍'], [')', '₎'],
  ['a', 'ₐ'], ['e', 'ₑ'], ['h', 'ₕ'], ['i', 'ᵢ'], ['j', 'ⱼ'],
  ['k', 'ₖ'], ['l', 'ₗ'], ['m', 'ₘ'], ['n', 'ₙ'], ['o', 'ₒ'],
  ['p', 'ₚ'], ['r', 'ᵣ'], ['s', 'ₛ'], ['t', 'ₜ'], ['u', 'ᵤ'], ['v', 'ᵥ'], ['x', 'ₓ'],
]);

function scriptTransform(inner: string, map: Map<string, string>) {
  return inner
    .split('')
    .map((c) => map.get(c) ?? c)
    .join('');
}

function findCommand(out: string, cmd: string, from: number, bare: boolean): number {
  let idx = out.indexOf(cmd, from);
  while (idx !== -1 && bare) {
    const prev = out[idx - 1];
    if (prev !== ':' && prev !== '\\' && !/\w/.test(prev ?? '')) return idx;
    idx = out.indexOf(cmd, idx + 1);
  }
  return idx;
}

function replaceSymbol(out: string, cmd: string, replacement: string, bare: boolean) {
  // Commands end at a non-letter: \le must not match inside \left.
  if (!bare) return out.replace(new RegExp(`${escapeRegExp(cmd)}(?![a-zA-Z])`, 'g'), () => replacement);
  return out.replace(new RegExp(`(?<![:\\w\\\\])${escapeRegExp(cmd)}(?![a-zA-Z])`, 'g'), () => replacement);
}

function readBalanced(str: string, startIdx: number): { inner: string; end: number; } | null {
  if (str[startIdx] !== '{') return null;
  let depth = 0;
  let i = startIdx;
  while (i < str.length) {
    if (str[i] === '{') depth++;
    else if (str[i] === '}') {
      depth--;
      if (depth === 0) {
        return { inner: str.slice(startIdx + 1, i), end: i + 1 };
      }
    }
    i++;
  }
  return null;
}

function replaceCommandWithBraces(out: string, cmd: string, replacer: (inner: string) => string, bare: boolean = false) {
  let result = '';
  let i = 0;
  while (i < out.length) {
    const idx = findCommand(out, cmd, i, bare);
    if (idx === -1) {
      result += out.slice(i);
      break;
    }
    result += out.slice(i, idx);
    const braceStart = idx + cmd.length;
    const balanced = readBalanced(out, braceStart);
    if (!balanced) {
      result += out.slice(idx, braceStart + 1);
      i = braceStart + 1;
      continue;
    }
    result += replacer(balanced.inner);
    i = balanced.end;
  }
  return result;
}

function renderExpr(expr: string, bare: boolean = false): string {
  let out = expr;

  out = out.replace(/\\dfrac/g, '\\frac').replace(/\\tfrac/g, '\\frac');

  {
    let result = '';
    let i = 0;
    while (i < out.length) {
      const idx = findCommand(out, '\\frac', i, bare);
      if (idx === -1) {
        result += out.slice(i);
        break;
      }
      result += out.slice(i, idx);
      const numStart = idx + 5;
      const num = readBalanced(out, numStart);
      if (!num) {
        result += out.slice(idx, numStart + 1);
        i = numStart + 1;
        continue;
      }
      const denStart = num.end;
      if (out[denStart] !== '{') {
        result += out.slice(idx, denStart);
        i = denStart;
        continue;
      }
      const den = readBalanced(out, denStart);
      if (!den) {
        result += out.slice(idx, denStart + 1);
        i = denStart + 1;
        continue;
      }
      result += `${renderExpr(num.inner, bare)}⁄${renderExpr(den.inner, bare)}`;
      i = den.end;
    }
    out = result;
  }

  // A boxed result is the answer the model is pointing at: kept visibly marked, not dropped into the line.
  out = replaceCommandWithBraces(out, '\\boxed', (inner) => `[${renderExpr(inner, bare)}]`, bare);
  out = replaceCommandWithBraces(out, '\\sqrt', (inner) => `√${renderExpr(inner, bare)}`, bare);
  out = replaceCommandWithBraces(out, '\\surd', (inner) => `√${renderExpr(inner, bare)}`, bare);
  out = out.replace(/\\sqrt(\s|$)/g, '√$1');

  for (const cmd of TEXT_COMMANDS) {
    out = replaceCommandWithBraces(out, cmd, (inner) => renderExpr(inner, bare), bare);
  }

  // Symbols before \left/\right stripping: \rightarrow starts with \right and \leftarrow with \left.
  const commands = [...SYMBOLS.keys()].sort((a, b) => b.length - a.length);
  for (const cmd of commands) {
    out = replaceSymbol(out, cmd, SYMBOLS.get(cmd) ?? '', bare);
  }

  // Spacing only inside delimited math: in loose text a backslash-comma is more likely part of something else.
  if (!bare) for (const [cmd, space] of SPACING) out = out.split(cmd).join(space);

  if (bare) {
    out = out.replace(/(?<![:\\w\\\\])\\left\s*/g, '').replace(/(?<![:\\w\\\\])\\right\s*/g, '');
    out = out.replace(/(?<![:\\w\\\\])\\[Bb]igg?\s*/g, '');
  } else {
    out = out.replace(/\\left\s*/g, '').replace(/\\right\s*/g, '');
    out = out.replace(/\\[Bb]igg?\s*/g, '');
  }

  if (!bare) {
    out = out.replace(/\^\{([^}]*)\}/g, (_, inner) => scriptTransform(inner, SUPERSCRIPTS));
    out = out.replace(/\^([0-9a-zA-Z+=()])/g, (_, c) => SUPERSCRIPTS.get(c) ?? c);

    out = out.replace(/_\{([^}]*)\}/g, (_, inner) => scriptTransform(inner, SUBSCRIPTS));
    out = out.replace(/_([0-9a-zA-Z+=()])/g, (_, c) => SUBSCRIPTS.get(c) ?? c);
  }

  return out;
}

function hasBareLatex(text: string): boolean {
  const all = new Set([
    ...SYMBOLS.keys(),
    ...TEXT_COMMANDS,
    ...BRACE_COMMANDS,
    '\\left', '\\right', '\\Big', '\\big',
  ]);
  const re = new RegExp(`(?<![:\\w\\\\])${[...all].map(escapeRegExp).join('|')}`);
  return re.test(text);
}

/** One math expression, written with LaTeX, as it should read in a terminal. */
export function renderMath(expr: string): string {
  return renderExpr(String(expr ?? '').trim());
}

/** Whether a `$…$` body is math, so `$5 and $10` stays money. */
export function isMath(expr: string): boolean {
  return renderMath(expr) !== String(expr ?? '').trim() || looksLikeMath(expr);
}

export function renderBareLatex(text: string): string {
  if (!hasBareLatex(text)) return text;
  return renderExpr(text, true);
}

/** Is a `$…$` body delimited as math, when the mini-renderer has no way to prove it by rendering it? */
function looksLikeMath(expr: string): boolean {
  const s = String(expr ?? '');
  return (
    /\\[a-zA-Z]+/.test(s) ||
    /[A-Za-z]\d|\d[A-Za-z]/.test(s) ||
    /[A-Za-z]\([^)]*\)/.test(s)
  );
}
