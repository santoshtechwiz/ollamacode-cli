import { createElement as h, useCallback, useRef, useState, useMemo, useEffect } from 'react';
import { Box, Text, useInput } from 'ink';
import { Autocomplete, AutocompleteOption } from './autocomplete';
import { AutocompleteConfig, mergeAutocompleteConfig } from './autocomplete-config';

export interface PromptProps {
  prefix: string;
  value: string;
  cursor: number;
  modeLabel?: string;
  modeRestricted?: boolean;
  onChange: (value: string, cursor: number) => void;
  onSubmit: (text: string) => void;
  onHistoryUp: () => void;
  onHistoryDown: () => void;
  onCtrlC: () => void;
  onCtrlD: () => void;
  onCycleMode: () => void;
  onRevealFile: () => void;
  onRevealOutput: () => void;
  onClearScreen: () => void;
  onEscape: () => void;
  onEditor: () => void;
  disabled?: boolean;
  autocompleteConfig?: AutocompleteConfig;
  onAutocompleteSelect?: (option: AutocompleteOption, providerId: string) => void;
  onAutocompleteExecute?: (command: string, args: string) => Promise<void>;
}

export function Prompt(props: PromptProps) {
  const { prefix, value, cursor, disabled, modeLabel, modeRestricted, autocompleteConfig, onAutocompleteSelect, onAutocompleteExecute } = props;
  const latest = useRef(props);
  latest.current = props;

  const config = useMemo(() => mergeAutocompleteConfig(autocompleteConfig ?? {}), [autocompleteConfig]);

  const [activeProviderId, setActiveProviderId] = useState<string | null>(null);
  const [showAutocomplete, setShowAutocomplete] = useState(false);
  const [selectedIndex, setSelectedIndex] = useState(0);

  // Get options from active provider
  const activeProvider = useMemo(() => {
    if (!activeProviderId) return null;
    return config.providers.find(p => p.id === activeProviderId) ?? null;
  }, [config.providers, activeProviderId]);

  const [providerOptions, setProviderOptions] = useState<AutocompleteOption[]>([]);

  useEffect(() => {
    let cancelled = false;
    async function fetchOptions() {
      if (!activeProvider) {
        setProviderOptions([]);
        return;
      }
      const filter = activeProvider.getFilter ? activeProvider.getFilter(value, cursor) : '';
      const options = await activeProvider.getOptions(filter);
      if (!cancelled) {
        setProviderOptions(options.filter((opt) =>
          opt.label.toLowerCase().includes(filter.toLowerCase()) ||
          opt.description.toLowerCase().includes(filter.toLowerCase())
        ).slice(0, config.maxOptions));
      }
    }
    fetchOptions();
    return () => { cancelled = true; };
  }, [activeProvider, value, cursor, config.maxOptions]);

  // Accepting a suggestion fills it in, like an editor; only Enter on a / command runs it.
  const handleAutocompleteSelect = useCallback((option: AutocompleteOption, { run = false }: { run?: boolean } = {}) => {
    const { value, cursor } = latest.current;
    if (!activeProvider) return;
    const prefixEnd = activeProvider.getPrefixEnd ? activeProvider.getPrefixEnd(value, cursor) : 0;
    const newValue = value.slice(0, prefixEnd) + option.label + ' ' + value.slice(cursor);
    const newCursor = prefixEnd + option.label.length + 1;

    if (run && activeProvider.trigger === '/' && onAutocompleteExecute) {
      const [cmd, ...args] = option.label.split(/\s+/);
      onAutocompleteExecute(cmd, args.join(' '));
      props.onChange('', 0);
      setShowAutocomplete(false);
      setSelectedIndex(0);
      return;
    }
    
    props.onChange(newValue, newCursor);
    setShowAutocomplete(false);
    setSelectedIndex(0);
    onAutocompleteSelect?.(option, activeProviderId ?? '');
  }, [props, activeProvider, activeProviderId, onAutocompleteSelect, onAutocompleteExecute]);

  const handleInput = useCallback((input: string, key: Parameters<Parameters<typeof useInput>[0]>[1]) => {
    const p = latest.current;
    if (p.disabled) return;
    const { value, cursor, onChange, onSubmit } = p;

    // Shift+Tab and Ctrl+G cycle the mode whatever is typed. Some Windows consoles send Shift+Tab as a
    // plain Tab, so Ctrl+G is the key that works everywhere, as /help says.
    if ((key.tab && key.shift) || (key.ctrl && input === 'g')) return p.onCycleMode();

    const autocompleteActive = showAutocomplete && providerOptions.length > 0;

    // Handle autocomplete navigation
    if (autocompleteActive) {
      if (key.upArrow) {
        setSelectedIndex((prev) => (prev > 0 ? prev - 1 : providerOptions.length - 1));
        return;
      }
      if (key.downArrow) {
        setSelectedIndex((prev) => (prev < providerOptions.length - 1 ? prev + 1 : 0));
        return;
      }
      if (key.return) {
        handleAutocompleteSelect(providerOptions[selectedIndex], { run: true });
        return;
      }
      if (key.escape) {
        setShowAutocomplete(false);
        setSelectedIndex(0);
        setActiveProviderId(null);
        return;
      }
      if (key.tab) {
        handleAutocompleteSelect(providerOptions[selectedIndex]);
        return;
      }
    }

    if (key.ctrl && input === 'c') return p.onCtrlC();
    if (key.ctrl && input === 'd') { if (!value.trim()) return p.onCtrlD(); return; }
    if (key.ctrl && input === 't') return p.onRevealOutput();
    if (key.ctrl && input === 'o') return p.onRevealFile();
    if (key.ctrl && input === 'l') return p.onClearScreen();
    if (key.ctrl && input === 'e') return p.onEditor();
    if (key.ctrl && input === 'j') {
      const next = value.slice(0, cursor) + '\n' + value.slice(cursor);
      return onChange(next, cursor + 1);
    }
    if (key.tab && !value.trim()) return p.onCycleMode();
    if (key.escape) return p.onEscape();
    if (key.return) {
      const text = value;
      onChange('', 0);
      return onSubmit(text);
    }
    if (key.upArrow) return p.onHistoryUp();
    if (key.downArrow) return p.onHistoryDown();
    if (key.leftArrow) return onChange(value, previousCodePoint(value, cursor));
    if (key.rightArrow) return onChange(value, nextCodePoint(value, cursor));
    if (key.backspace || key.delete) {
      if (cursor === 0) return;
      const from = key.meta ? wordStart(value, cursor) : previousCodePoint(value, cursor);
      return onChange(value.slice(0, from) + value.slice(cursor), from);
    }
    if (key.ctrl && input === 'w') {
      const from = wordStart(value, cursor);
      return onChange(value.slice(0, from) + value.slice(cursor), from);
    }
    if (key.ctrl && input === 'u') return onChange(value.slice(cursor), 0);
    if (key.ctrl && input === 'k') return onChange(value.slice(0, cursor), cursor);
    if (!input || key.ctrl || key.meta) return;
    if (/^[\x7f\b]+$/.test(input)) {
      let from = cursor;
      for (let i = 0; i < input.length && from > 0; i++) from = previousCodePoint(value, from);
      return onChange(value.slice(0, from) + value.slice(cursor), from);
    }
    const text = cleanPaste(input);
    const next = value.slice(0, cursor) + text + value.slice(cursor);
    onChange(next, cursor + text.length);
  }, [showAutocomplete, providerOptions, selectedIndex, handleAutocompleteSelect, activeProviderId]);

  useInput(handleInput, { isActive: !disabled });

  // Determine which provider should be active based on trigger characters
  useEffect(() => {
    for (const provider of config.providers) {
      if (provider.shouldActivate && provider.shouldActivate(value, cursor)) {
        setActiveProviderId(provider.id);
        setShowAutocomplete(true);
        setSelectedIndex(0);
        return;
      }
    }
    // No provider should activate
    if (showAutocomplete) {
      setShowAutocomplete(false);
      setSelectedIndex(0);
      setActiveProviderId(null);
    }
  }, [value, cursor, config.providers, showAutocomplete]);

  // Also close if value is cleared (after command execution)
  if (value === '' && showAutocomplete) {
    setShowAutocomplete(false);
    setSelectedIndex(0);
    setActiveProviderId(null);
  }

  const borderColor = modeRestricted ? 'yellow' : 'cyan';
  const { rows, hidden } = visibleRows(value, cursor);
  const lineCount = value.split('\n').length;

  return h(
    Box,
    { flexDirection: 'column' },
    modeLabel ? h(Text, { color: borderColor, dimColor: !modeRestricted }, `${modeLabel}  ·  Shift+Tab to switch`) : null,
    h(
      Box,
      { borderStyle: 'round', borderColor, paddingX: 1, flexDirection: 'column' },
      hidden.above > 0 ? h(Text, { dimColor: true }, `  ↑ ${hidden.above} more line(s)`) : null,
      ...rows.map((row, i) => h(
        Text,
        { key: `l${i}`, wrap: 'wrap' },
        h(Text, { color: 'cyan' }, row.first ? prefix : ' '.repeat(prefixWidth(prefix))),
        row.before,
        row.cursor !== null ? h(Text, { inverse: true }, row.cursor) : null,
        row.after
      )),
      hidden.below > 0 ? h(Text, { dimColor: true }, `  ↓ ${hidden.below} more line(s)`) : null
    ),
    showAutocomplete && providerOptions.length > 0 ? h(Autocomplete, {
      options: providerOptions,
      filter: activeProvider?.getFilter ? activeProvider.getFilter(value, cursor) : '',
      selectedIndex,
      onSelect: handleAutocompleteSelect,
      onClose: () => { setShowAutocomplete(false); setSelectedIndex(0); setActiveProviderId(null); },
      onNavigate: (delta: number) => setSelectedIndex((prev) => {
        const next = prev + delta;
        if (next < 0) return providerOptions.length - 1;
        if (next >= providerOptions.length) return 0;
        return next;
      }),
    }) : null,
    lineCount > 1 || value.length > 200
      ? h(Text, { dimColor: true }, `  ${lineCount} lines · ${value.length} chars · Esc clears · Ctrl+U deletes to start · Alt+Backspace deletes a word`)
      : null
  );
}

const MAX_VISIBLE_LINES = 10;

function visibleRows(value: string, cursor: number) {
  const lines = value.split('\n');
  let offset = 0;
  let cursorLine = 0;
  for (let i = 0; i < lines.length; i++) {
    if (cursor <= offset + lines[i].length) { cursorLine = i; break; }
    offset += lines[i].length + 1;
  }
  const start = Math.max(0, Math.min(cursorLine - Math.floor(MAX_VISIBLE_LINES / 2), lines.length - MAX_VISIBLE_LINES));
  const end = Math.min(lines.length, start + MAX_VISIBLE_LINES);
  let lineStart = 0;
  for (let i = 0; i < start; i++) lineStart += lines[i].length + 1;
  const rows: Array<{ first: boolean; before: string; cursor: string | null; after: string; }> = [];
  for (let i = start; i < end; i++) {
    const line = lines[i];
    if (i === cursorLine) {
      const col = Math.max(0, cursor - lineStart);
      const before = line.slice(0, col);
      const cursorText = Array.from(line.slice(col))[0] ?? ' ';
      rows.push({ first: i === 0, before, cursor: cursorText, after: line.slice(col + cursorText.length) });
    } else {
      rows.push({ first: i === 0, before: line || ' ', cursor: null, after: '' });
    }
    lineStart += line.length + 1;
  }
  return { rows, hidden: { above: start, below: lines.length - end } };
}

function prefixWidth(prefix: string): number {
  return displayWidth(prefix.replace(/\x1b\[[0-9;]*m/g, ''));
}

function displayWidth(text: string): number {
  return Array.from(text).reduce((width, char) => {
    if (/\p{Mark}/u.test(char)) return width;
    const code = char.codePointAt(0) ?? 0;
    return width + (code < 32 || code === 127 ? 0 : /[\u1100-\u115f\u2329\u232a\u2e80-\u303e\u3040-\ua4cf\uac00-\ud7a3\uf900-\ufaff\ufe10-\ufe19\ufe30-\ufe6f\uff00-\uff60\uffe0-\uffe6]/u.test(char) ? 2 : 1);
  }, 0);
}

function previousCodePoint(value: string, cursor: number): number {
  if (cursor <= 0) return 0;
  const code = value.charCodeAt(cursor - 1);
  return cursor > 1 && code >= 0xdc00 && code <= 0xdfff ? cursor - 2 : cursor - 1;
}

function nextCodePoint(value: string, cursor: number): number {
  if (cursor >= value.length) return value.length;
  const code = value.charCodeAt(cursor);
  return cursor + 1 < value.length && code >= 0xd800 && code <= 0xdbff ? cursor + 2 : cursor + 1;
}

function wordStart(value: string, cursor: number): number {
  let i = cursor;
  while (i > 0) {
    const next = previousCodePoint(value, i);
    if (!/\s/.test(value.slice(next, i))) break;
    i = next;
  }
  while (i > 0) {
    const next = previousCodePoint(value, i);
    if (/\s/.test(value.slice(next, i))) break;
    i = next;
  }
  return i;
}

function cleanPaste(input: string): string {
  return input.replace(/\x1b?\[20[01]~/g, '').replace(/\r\n?/g, '\n').replace(/[\x00-\x08\x0b-\x1f\x7f]/g, '');
}

export function createHistory() {
  const entries: string[] = [];
  let index: number | null = null;
  let draft = '';
  return {
    record(text: string) { if (text.trim()) entries.push(text); index = null; draft = ''; },
    up(current: string): string | null {
      if (entries.length === 0) return null;
      if (index === null) { draft = current; index = entries.length - 1; return entries[index] ?? null; }
      index = Math.max(0, index - 1);
      return entries[index] ?? null;
    },
    down(): string | null {
      if (index === null) return null;
      const next = index + 1;
      if (next >= entries.length) { index = null; return draft; }
      index = next;
      return entries[index] ?? null;
    },
  };
}