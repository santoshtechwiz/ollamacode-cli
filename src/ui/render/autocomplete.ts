import { createElement as h, useMemo } from 'react';
import { Box, Text } from 'ink';

export interface AutocompleteOption {
  label: string;
  description: string;
  hint?: string;
}

export interface AutocompleteProvider {
  /** Unique identifier for this provider */
  id: string;
  /** Unique trigger character (e.g., '/', '@', '#') */
  trigger: string;
  /** Human-readable name for debugging */
  name: string;
  /** Return options matching the filter (text after trigger) */
  getOptions(filter: string): Promise<AutocompleteOption[]>;
  /** Optional: customize how the filter is extracted from input */
  getFilter?(value: string, cursor: number): string;
  /** Optional: customize when this provider should activate */
  shouldActivate?(value: string, cursor: number): boolean;
  /** Optional: position where the trigger starts (for replacement) */
  getTriggerStart?(value: string, cursor: number): number;
  /** Optional: position after trigger for text replacement */
  getPrefixEnd?(value: string, cursor: number): number;
}

interface AutocompleteProps {
  options: AutocompleteOption[];
  filter: string;
  selectedIndex: number;
  onSelect: (option: AutocompleteOption) => void;
  onClose: () => void;
  onNavigate: (delta: number) => void;
  maxVisible?: number;
}

export function Autocomplete(props: AutocompleteProps) {
  const { options, filter, selectedIndex, onSelect: _onSelect, onClose: _onClose, onNavigate: _onNavigate, maxVisible = 8 } = props;

  const filtered = useMemo(() => {
    const lowerFilter = filter.toLowerCase().replace(/^\//, '');
    return options.filter((opt) =>
      opt.label.toLowerCase().includes(lowerFilter) ||
      opt.description.toLowerCase().includes(lowerFilter)
    );
  }, [options, filter]);

  if (filtered.length === 0) return null;

  const visible = filtered.slice(0, maxVisible);
  const hasMore = filtered.length > maxVisible;

  return h(
    Box,
    { flexDirection: 'column', marginTop: 1 },
    h(
      Box,
      { borderStyle: 'round', borderColor: 'cyan', paddingX: 1, paddingY: 0, flexDirection: 'column' },
      visible.map((opt, i) =>
        h(
          Box,
          { key: opt.label, flexDirection: 'row' },
          h(Text, { color: i === selectedIndex ? 'black' : undefined, backgroundColor: i === selectedIndex ? 'cyan' : undefined }, ` ${opt.label} `),
          opt.hint && h(Text, { color: i === selectedIndex ? 'black' : 'gray', backgroundColor: i === selectedIndex ? 'cyan' : undefined, dimColor: true }, ` ${opt.hint}`),
          h(Text, { color: i === selectedIndex ? 'black' : 'gray', backgroundColor: i === selectedIndex ? 'cyan' : undefined, dimColor: true }, `  ${opt.description}`)
        )
      ),
      hasMore && h(Text, { dimColor: true }, `  … ${filtered.length - maxVisible} more`)
    )
  );
}