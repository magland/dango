import { createHash } from 'crypto';
import { activeTheme } from '../../mochiforge/src/themes';
import { callScript } from './callscript';
import { pageScript } from './pagescript';
import { styleSheet } from './style';
import { serviceWorker } from './sw';

// What a page loaded: a hash of the page script, the call script, the service
// worker, and the stylesheet for the workspace's theme. Pages are stamped
// with it, and every page's event stream says it when it opens, so a page
// that has outlived a deploy (or a change of theme) learns that what it runs
// is no longer what the workspace serves, and loads itself again. This
// matters most for the app installed on a phone's home screen, which moves
// between rooms in place and has no reload button, so without it a phone
// could run the script of several deploys ago for weeks.

const tags = new Map<string, string>();

export function buildTag(): string {
  const parts = [pageScript().tag, callScript().tag, serviceWorker().tag, styleSheet(activeTheme()).tag].join(' ');
  let tag = tags.get(parts);
  if (!tag) {
    tag = createHash('sha256').update(parts).digest('hex').slice(0, 12);
    tags.set(parts, tag);
  }
  return tag;
}
