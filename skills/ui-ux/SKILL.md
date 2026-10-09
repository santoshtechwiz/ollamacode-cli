---
name: ui-ux
description: load before creating or changing any web page, site or UI — stack and folder choice, layout, spacing, type, color, responsive, accessibility, forms, states
paths: ["**/*.html", "**/*.css", "**/*.scss", "**/*.sass", "**/*.less", "**/*.jsx", "**/*.tsx", "**/*.vue", "**/*.svelte", "**/*.astro", "**/*.component.ts", "**/tailwind.config.*"]
---
Follow these steps in order. Change only what makes the UI more consistent or easier to use. Leave business logic alone unless the UI cannot work without the change.

0. Settle the stack and the folder before creating anything.
   - Working in an existing project: use its framework, its folders and its styling. Do not add a framework it does not use.
   - Building something new, and the request does not name the stack or the folder: ask once with ask_user before creating any file. Offer plain HTML and CSS (recommended for a page or a small site), React with Vite, and whatever else fits, plus the folder (for example "./coffee-site"). Build with the answer; do not pick React on your own.
   - Look at the folder first with list_directory. Put every file of a new site inside its own folder, never scattered in the workspace root next to other projects.
   - A scaffolder (npm create vite@latest my-app …) makes a new folder: pass that folder as cwd to every later command and write files under it. Each command starts in a fresh shell, so `cd` does not carry over. After scaffolding, list_directory that folder to see where the files really are.
   - Keep the files that are already there, generated ones included (App.css, index.css, assets). Change them with edit_file; do not delete them or rewrite them whole. A file you no longer need stays: name it in your report, and delete it only when the user asks.

1. Find the design system before writing any style.
   - Look for theme files, CSS variables (`:root { --… }`), `tailwind.config.*` or a Tailwind `@theme` block, a component library (shadcn/ui, MUI, Chakra, Angular Material, Vuetify, PrimeVue, Skeleton…) or shared components.
   - Use what is there. Add no one-off colors, font sizes, spacing or shadows.
   - Nothing there: plain HTML and CSS copy `tokens.css` from this skill (use_skill file "tokens.css") and use only its variables; a project that already uses Tailwind uses its scale.
   - Follow the framework's own way: React/Next.js components and `next/image` (remote hosts go in `next.config` `images.remotePatterns`); Angular components with their own template and styles, theme in `styles.scss` or Angular Material's theme; Vue and Svelte single-file components with scoped styles; Astro components. Do not mix two frameworks in one project.

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
   - One accent color for actions.
   - Dark mode: scaffolds (create-next-app, Vite) turn the page dark with `@media (prefers-color-scheme: dark)` in their global CSS. Either style both schemes through the theme's variables (or Tailwind `dark:`), or remove that block on purpose. Never put hardcoded light colors (`bg-white`, `text-gray-900`, `#111`) on a background that turns dark: the page comes out half black.

5. Components and states.
   - Build a component once and reuse it; no copied markup with small differences.
   - Buttons, links and inputs need hover, focus-visible, active and disabled styles.
   - Every view that loads data needs loading, empty, error and success states. A slow action shows progress and blocks double submits.

6. Motion: small and purposeful, so the page feels alive without getting in the way.
   - Every interactive element eases its hover, focus and press changes (150–200ms). Content enters with a short fade and rise (200–400ms, ease-out); list and card groups stagger by about 50ms; a modal or menu scales from 0.96 and fades.
   - Animate only `transform` and `opacity`: animating width, height, top or margin makes the page stutter. Never delay content the person came for, and never loop motion that is not a loading indicator.
   - Use the project's tools first: Tailwind `transition`/`animate-*` (and tw-animate-css or tailwindcss-animate when installed), Framer Motion (`motion`) in React when it is a dependency, Angular animations, Vue `<Transition>`, Svelte `transition:`. Add a library only when the request asks for rich motion.
   - Plain CSS: copy `motion.css` from this skill (use_skill file "motion.css"): its durations, easings and `.reveal` / `.stagger` classes, with a few lines of script that reveal elements as they scroll into view.
   - Everything honors `prefers-reduced-motion: reduce`: motion turns off and content still shows.

7. Forms.
   - Every input has a visible `label`. Use the right `type` and `autocomplete`.
   - Errors appear next to the field, say how to fix it, and are announced (`aria-describedby`, `aria-invalid`).
   - Keep what the person typed when validation fails.

8. Accessibility.
   - Everything works with the keyboard alone, in a sensible order, with a visible focus ring.
   - Images have `alt` (empty `alt=""` when decorative). Icon-only buttons have an `aria-label`.
   - Tap targets at least 44×44px. Use ARIA only when no native element does the job.
   - Respect `prefers-reduced-motion`.

9. Clean up.
   - Replace hardcoded values that the theme already has with the theme's names.
   - Merge duplicated CSS rules and components.

10. Verify. A type check is not enough: it passed on a Next.js site that crashed on its first page.
   - Run the project's build (`npm run build`, `ng build`…): it prerenders pages and catches what a type check cannot (values that change between renders, image hosts not configured, template errors). Run its lint too.
   - Start the dev server in the background, then call check_page on its URL (or on the .html file of a site with no server) and fix what it reports. It checks mobile, tablet and desktop widths.
   - check_page cannot see states it does not reach: check loading, empty and error states by reading the code.
   - Say only what you checked. Do not call a page responsive or accessible unless check_page passed.

When you report, list what you changed with file and line, and what you left as suggestions.
