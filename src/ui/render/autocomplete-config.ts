import { AutocompleteProvider } from './autocomplete';

export interface AutocompleteConfig {
  providers: AutocompleteProvider[];
  maxOptions?: number;
  minQueryLength?: number;
}

const DEFAULT_AUTOCOMPLETE_CONFIG: Partial<AutocompleteConfig> = {
  maxOptions: 10,
  minQueryLength: 0,
};

export function mergeAutocompleteConfig(
  userConfig: Partial<AutocompleteConfig>,
  defaults: Partial<AutocompleteConfig> = DEFAULT_AUTOCOMPLETE_CONFIG
): AutocompleteConfig {
  return {
    providers: userConfig.providers ?? [],
    maxOptions: userConfig.maxOptions ?? defaults.maxOptions ?? 10,
    minQueryLength: userConfig.minQueryLength ?? defaults.minQueryLength ?? 0,
  };
}