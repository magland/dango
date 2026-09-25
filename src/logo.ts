import { Theme, activeTheme } from '../../mochiforge/src/themes';

// The mark is a skewer of three dango, drawn in the same monoline the mochi
// mark uses: circles and a stick, currentColor throughout, so it takes the
// text colour wherever it sits. The brand in the top bar is this mark beside
// the word set in the page's own font, rather than a drawn wordmark.

export const MARK = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64" fill="none" role="img" aria-label="dango"><g stroke="currentColor" stroke-width="6" stroke-linecap="round"><path d="M14 50L50 14"/></g><g fill="var(--bg, #fff)" stroke="currentColor" stroke-width="6"><circle cx="22" cy="42" r="9"/><circle cx="32" cy="32" r="9"/><circle cx="42" cy="22" r="9"/></g></svg>`;

/**
 * The favicon: the mark on a tile coloured from the active theme, so it
 * changes with the workspace's appearance, exactly as mochiforge's does.
 */
export function faviconSvg(theme: Theme = activeTheme()): string {
  const bg = theme.vars.surface;
  const fg = theme.vars.fg;
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><rect width="64" height="64" rx="14" fill="${bg}"/><g stroke="${fg}" stroke-width="6" stroke-linecap="round"><path d="M14 50L50 14"/></g><g fill="${bg}" stroke="${fg}" stroke-width="6"><circle cx="22" cy="42" r="9"/><circle cx="32" cy="32" r="9"/><circle cx="42" cy="22" r="9"/></g></svg>`;
}
