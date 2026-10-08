import { AutocompleteProvider, AutocompleteOption } from '../../ui/render/autocomplete';
import { COMMANDS } from '../commands/registry';

export function createCommandAutocompleteProvider(): AutocompleteProvider {
  return {
    id: 'command',
    name: 'Command',
    trigger: '/',
    async getOptions(filter: string): Promise<AutocompleteOption[]> {
      const cleanFilter = filter.replace(/^\//, '').toLowerCase();
      return COMMANDS
        .filter((cmd) => !cmd.hidden)
        .filter((cmd) => cmd.name.toLowerCase().includes(cleanFilter) || cmd.description.toLowerCase().includes(cleanFilter))
        .map((cmd) => ({
          label: cmd.name,
          description: cmd.description,
          hint: cmd.arg,
        }));
    },
    getFilter(value: string, cursor: number): string {
      const beforeCursor = value.slice(0, cursor);
      const match = beforeCursor.match(/\/([^\s]*)\s*$/);
      return match ? '/' + match[1] : '/';
    },
    // Only while typing the input's first word, and only while it can still be a command name: a second slash makes it a path.
    shouldActivate(value: string, cursor: number): boolean {
      return /^\s*\/[^\s/]*$/.test(value.slice(0, cursor));
    },
    getPrefixEnd(value: string, cursor: number): number {
      return value.slice(0, cursor).match(/^(\s*)\//)?.[1].length ?? 0;
    },
  };
}