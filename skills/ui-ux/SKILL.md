---
name: ui-ux
description: building, reviewing or fixing a web page or UI — layout, spacing, type, color, responsive design, accessibility, forms and states
paths: ["**/*.html", "**/*.css", "**/*.scss", "**/*.sass", "**/*.less", "**/*.jsx", "**/*.tsx", "**/*.vue", "**/*.svelte", "**/*.astro", "**/tailwind.config.*"]
---
Follow these steps in order. Change only what makes the UI more consistent or easier to use. Leave business logic alone unless the UI cannot work without the change.

1. Find the design system before writing any style.
   - Look for theme files, CSS variables (`:root { --… }`), `tailwind.config.*`, a component library (shadcn/ui, MUI, Chakra…) or shared components.
   - Use what is there. Add no one-off colors, font sizes, spacing or shadows.
   - Nothing there? With a Node build, use Tailwind and its default scale. Without a build step, copy `tokens.css` from this skill (use_skill file "tokens.css") and use only its variables.

2. Layout.
   - Semantic HTML: `header`, `nav`, `main`, `section`, `footer`, real `button` and `a` elements, one `h1`, headings in order.
   - Mobile first. Flex or grid, a max-width container, no fixed pixel widths on content.
   - One clear main action per screen. Group related things; separate unrelated ones with space, not lines.

3. Spacing and type.
   - Spacing only from the scale (4/8px steps). Same gaps for the same kind of thing.
   - At most two font families. Body text at least 16px with line-height about 1.5, lines no longer than about 70 characters.
   - Hierarchy from size and weight, not from color alone.

4. Color.
   - Text contrast at least 4.5:1 (3:1 for large text and icons). Never show meaning by color alone.
   - One accent color for actions. Support dark mode if the project's theme does.

5. Components and states.
   - Build a component once and reuse it; no copied markup with small differences.
   - Buttons, links and inputs need hover, focus-visible, active and disabled styles.
   - Every view that loads data needs loading, empty, error and success states. A slow action shows progress and blocks double submits.

6. Forms.
   - Every input has a visible `label`. Use the right `type` and `autocomplete`.
   - Errors appear next to the field, say how to fix it, and are announced (`aria-describedby`, `aria-invalid`).
   - Keep what the person typed when validation fails.

7. Accessibility.
   - Everything works with the keyboard alone, in a sensible order, with a visible focus ring.
   - Images have `alt` (empty `alt=""` when decorative). Icon-only buttons have an `aria-label`.
   - Tap targets at least 44×44px. Use ARIA only when no native element does the job.
   - Respect `prefers-reduced-motion`.

8. Clean up.
   - Replace hardcoded values that the theme already has with the theme's names.
   - Merge duplicated CSS rules and components.

9. Verify.
   - Run the project's build, lint and tests.
   - Call check_page on the page (a URL from the running dev server, or the .html file) and fix what it reports. It checks mobile, tablet and desktop widths.
   - check_page cannot see states it does not reach: check loading, empty and error states by reading the code.

When you report, list what you changed with file and line, and what you left as suggestions.
