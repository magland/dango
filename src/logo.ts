import { Theme, activeTheme } from '../../mochiforge/src/themes';

// The mark is a skewer of three hanami dango: pink at the top, white in the
// middle, green at the bottom. The stick and the outlines are in currentColor,
// so the line takes the text colour wherever it sits, while the dango keep
// their own colours in every theme. The brand in the top bar is this mark
// beside the word set in the page's own font, rather than a drawn wordmark.

/** The dango's colours, from the top of the skewer down. */
export const DANGO_COLORS = { pink: '#f4a9bf', white: '#fdfaf2', green: '#9ccb82' };

/** The geometry, in a 64-unit square; appicon.ts draws the same shapes. */
export const STICK = { x1: 9, y1: 55, x2: 55, y2: 9, width: 5 };
export const DANGO = [
  { cx: 26, cy: 38, fill: DANGO_COLORS.green },
  { cx: 35, cy: 29, fill: DANGO_COLORS.white },
  { cx: 44, cy: 20, fill: DANGO_COLORS.pink },
];
export const DANGO_R = 9;
export const OUTLINE = 4;

function shapes(line: string): string {
  const stick = `<path d="M${STICK.x1} ${STICK.y1}L${STICK.x2} ${STICK.y2}" stroke="${line}" stroke-width="${STICK.width}" stroke-linecap="round"/>`;
  const balls = DANGO.map((d) => `<circle cx="${d.cx}" cy="${d.cy}" r="${DANGO_R}" fill="${d.fill}"/>`).join('');
  return `${stick}<g stroke="${line}" stroke-width="${OUTLINE}">${balls}</g>`;
}

export const MARK = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64" fill="none" role="img" aria-label="dango">${shapes('currentColor')}</svg>`;

/**
 * The favicon: the mark on a tile coloured from the active theme, so it
 * changes with the workspace's appearance, exactly as mochiforge's does.
 */
export function faviconSvg(theme: Theme = activeTheme(), unread: 'some' | 'urgent' | null = null): string {
  const bg = theme.vars.surface;
  const fg = theme.vars.fg;
  // Unread news puts a dot in the top left corner, the one the skewer leaves
  // empty, so it hides none of the dango: the theme's accent for anything, its danger colour when a
  // mention or a direct message is waiting. It is ringed in the tile's own
  // colour so it reads against any tab bar.
  const dot =
    unread === null
      ? ''
      : `<circle cx="14" cy="14" r="13" fill="${unread === 'urgent' ? theme.vars.danger : theme.vars.accent}" stroke="${bg}" stroke-width="4"/>`;
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><rect width="64" height="64" rx="14" fill="${bg}"/>${shapes(fg)}${dot}</svg>`;
}
