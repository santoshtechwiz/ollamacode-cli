// @joplin/turndown-plugin-gfm ships no types; only its `gfm` plugin is used here.
declare module '@joplin/turndown-plugin-gfm' {
  import type TurndownService from 'turndown';
  export function gfm(service: TurndownService): void;
}
