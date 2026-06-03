'use strict';
/**
 * Entry-point alias.
 *
 * cPanel's "Setup Node.js App" frequently defaults the startup file to `app.js`.
 * If that's how your app is configured, THIS file is what actually runs — so it
 * simply loads the real server. Either `server.js` or `app.js` works as the
 * configured startup file. (Keep server.js and portal.js in the same folder.)
 */
require('./server.js');
