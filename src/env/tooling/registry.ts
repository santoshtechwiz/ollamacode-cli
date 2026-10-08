import { LANGUAGES, type Language } from '../languages';

export function getProviders(): Language[] {
  return [...LANGUAGES];
}

export function getProvider(id: string): Language | null {
  return LANGUAGES.find((l) => l.id === id) ?? null;
}
