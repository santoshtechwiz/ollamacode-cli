import type { Diagnostic } from '../../types';
import { isEditableSource } from '../diagnostics/paths';
import { dedupe, quotedName, scan, tagMissingByCode } from './shared';

// Output of the TypeScript compiler, node:test, Jest, Vitest, Mocha and Node itself.

const TS_MISSING = new Set(['TS2304', 'TS2307', 'TS2339']);

export function parseTypeScript(output: string): Diagnostic[] {
  const out: any[] = [];
  for (const re of [
    /^(.+?)\((\d+),(\d+)\):\s+(error|warning)\s+(TS\d+):\s*(.+)$/gm,
    /^(.+?):(\d+):(\d+)\s+-\s+(error|warning)\s+(TS\d+):\s*(.+)$/gm,
  ]) {
    out.push(...scan(output, re, (m) => {
      const diag = { file: m[1].trim(), line: Number(m[2]), column: Number(m[3]), severity: m[4], code: m[5], message: m[6].trim() };
      tagMissingByCode(diag, TS_MISSING);
      return diag;
    }));
  }
  return out;
}

function tagMissingModules(out: any[]): any[] {
  for (const d of out) {
    const m = /Cannot find module '([^']+)'/i.exec(String(d?.message ?? ''));
    if (!m) continue;
    d.kind = 'missing';
    d.symbol = m[1];
  }
  return out;
}

function firstSourceFrame(block: string): { file: string; line: number; column: number } | null {
  const frame = /(?:at\s+.*?\(|[❯>]\s+)?((?:[A-Za-z]:[\\/]|\.{0,2}[\\/])?[\w.@$-]+(?:[\\/][\w.@$-]+)*\.[cm]?[jt]sx?):(\d+):(\d+)/g;
  for (let m = frame.exec(block); m !== null; m = frame.exec(block)) {
    if (!isEditableSource(m[1])) continue;
    return { file: m[1], line: Number(m[2]), column: Number(m[3]) };
  }
  return null;
}

export function parseNodeTest(output: string): Diagnostic[] {
  const out = scan(output, /^\s*not ok \d+ - (.+)$/gm, (m) => {
    const name = m[1].trim();
    // A file-level rollup, not a test.
    if (name.startsWith('/') || /^[A-Za-z]:\\/.test(name)) return null;
    return { file: '(test)', severity: 'failure', message: name };
  });
  const locations = scan(output, /location:\s*'([^']+):(\d+):(\d+)'/g, (m) => ({ file: m[1], line: Number(m[2]), column: Number(m[3]) }));
  for (let i = 0; i < out.length && i < locations.length; i++) Object.assign(out[i], locations[i]);
  return tagMissingModules(out);
}

export function parseJest(output: string): Diagnostic[] {
  const out: any[] = [];
  for (const part of output.split(/^\s*●\s+/m).slice(1)) {
    const name = part.split('\n')[0].trim();
    if (!name || /^Console$/i.test(name)) continue;
    const frame = firstSourceFrame(part);
    out.push({ file: frame?.file ?? '(test)', line: frame?.line, column: frame?.column, severity: 'failure', message: name });
  }
  return dedupe(tagMissingModules(out));
}

export function parseVitest(output: string): Diagnostic[] {
  const out = scan(output, /^\s*FAIL\s+(\S+?)\s*>\s*(.+?)\s*$/gm, (m) => {
    const file = m[1].trim();
    if (!isEditableSource(file)) return null;
    const frame = firstSourceFrame(output.slice(m.index).slice(0, 800));
    const here = frame && frame.file === file;
    return { file, line: here ? frame.line : undefined, column: here ? frame.column : undefined, severity: 'failure', message: m[2].trim() };
  });
  return dedupe(tagMissingModules(out));
}

const MOCHA_FAILURE_TEXT = /^\s*(?:[A-Z]\w*Error\b|Error:|AssertionError\b|expected .+ to |\+ expected|- actual)/m;

export function parseMocha(output: string): Diagnostic[] {
  const out: any[] = [];
  for (const part of output.split(/^\s*\d+\)\s+/m).slice(1)) {
    const head = part.split('\n').slice(0, 2).map((l) => l.trim()).filter(Boolean).join(' ').replace(/:$/, '');
    if (!head) continue;
    const frame = firstSourceFrame(part);
    if (!frame && !MOCHA_FAILURE_TEXT.test(part)) continue;
    out.push({ file: frame?.file ?? '(test)', line: frame?.line, column: frame?.column, severity: 'failure', message: head });
  }
  return dedupe(tagMissingModules(out));
}

function tagMissingRuntime(diag: { code?: string; message?: string; kind?: string; symbol?: string }): void {
  const code = String(diag.code ?? '');
  const message = String(diag.message ?? '');
  if (code === 'ReferenceError') {
    const m = /(\S+) is not defined/i.exec(message);
    if (!m) return;
    diag.kind = 'missing';
    diag.symbol = m[1];
  } else if (code === 'ERR_MODULE_NOT_FOUND') {
    diag.kind = 'missing';
    diag.symbol = quotedName(message) ?? '';
  }
}

export function parseNodeRuntime(output: string): Diagnostic[] {
  const out = scan(output, /^(\/|[A-Za-z]:\\|file:\/\/)?([^\s:()]+\.(?:m?[jt]s|cjs)):(\d+)$/gm, (m) => ({ file: m[2], line: Number(m[3]), severity: 'error', message: 'runtime error' }));
  const errorLine = output.match(/^([A-Z]\w*(?:Error|Exception)):\s*(.+)$/m);
  const frames = scan(output, /at .*?\(?(?:file:\/\/\/)?([A-Za-z]:[\\/][^\s:()]+|\/[^\s:()]+|[^\s:()]+\.[cm]?[jt]s):(\d+):(\d+)\)?/g, (m) =>
    m[1].includes('node:internal') ? null : { file: m[1], line: Number(m[2]), column: Number(m[3]) });
  if (errorLine && frames.length > 0) {
    const diag = { ...frames[0], severity: 'error', code: errorLine[1], message: errorLine[2].trim() };
    tagMissingRuntime(diag);
    out.push(diag);
  } else if (errorLine && out.length > 0) {
    out[0].code = errorLine[1];
    out[0].message = errorLine[2].trim();
    tagMissingRuntime(out[0]);
  }
  return out;
}
