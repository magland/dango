import { setNaming } from '../../mochiforge/src/naming';

// Dango is built on mochiforge's modules, imported directly from the sibling
// checkout, and this is where it tells them its own name. Importing this file
// is the whole mechanism: every entry point imports it before anything else,
// and the shared modules read these values at call time, so a dango process
// mints dango_ tokens, sets a dango_session cookie, and keeps its identity in
// workspace.json rather than vault.json.

setNaming({
  product: 'dango',
  tokenPrefix: 'dango_',
  cookieName: 'dango_session',
  stateFile: 'workspace.json',
  rootNoun: 'workspace',
  envPrefix: 'DANGO',
  configDirName: 'dango',
});
