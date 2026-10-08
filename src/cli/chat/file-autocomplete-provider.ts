import { AutocompleteProvider, AutocompleteOption } from '../../ui/render/autocomplete';
import { fuzzyFind } from '../../context/mentions';

interface FileAutocompleteProviderConfig {
  cwd: string;
  debounceMs?: number;
  maxResults?: number;
}

export function createFileAutocompleteProvider(config: FileAutocompleteProviderConfig): AutocompleteProvider {
  const { cwd, maxResults = 20 } = config;
  
  let cache: AutocompleteOption[] = [];
  let lastQuery = '';

  return {
    id: 'file',
    name: 'File',
    trigger: '@',
    async getOptions(filter: string): Promise<AutocompleteOption[]> {
      if (filter === lastQuery && cache.length > 0) {
        return cache;
      }
      const results = await fuzzyFind(cwd, filter, maxResults);
      cache = results.map((rel) => ({
        label: `@${rel}`,
        description: 'attach file',
        hint: rel,
      }));
      lastQuery = filter;
      return cache;
    },
    getFilter(value: string, cursor: number): string {
      const beforeCursor = value.slice(0, cursor);
      const match = beforeCursor.match(/@([^\s]*)\s*$/);
      return match ? match[1] : '';
    },
    // Open for as long as the cursor sits in an @word, so typing narrows the list instead of closing it.
    shouldActivate(value: string, cursor: number): boolean {
      return /(^|\s)@[^\s]*$/.test(value.slice(0, cursor));
    },
    getPrefixEnd(value: string, cursor: number): number {
      const beforeCursor = value.slice(0, cursor);
      let lastAt = -1;
      for (let i = beforeCursor.length - 1; i >= 0; i--) {
        if (beforeCursor[i] === '@' && (i === 0 || /\s/.test(beforeCursor[i - 1]))) {
          lastAt = i;
          break;
        }
      }
      return lastAt >= 0 ? lastAt : 0;
    },
  };
}