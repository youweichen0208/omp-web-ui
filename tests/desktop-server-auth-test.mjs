import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { bearerHeaders, desktopServerToken, desktopWindowUrl } from '../electron/server-auth.mjs';

const a = desktopServerToken({}), b = desktopServerToken({});
assert.match(a, /^[\da-f]{64}$/);
assert.notEqual(a, b, 'each launch gets a fresh token');
assert.equal(desktopServerToken({ PI_WEB_TOKEN: '  pinned  ' }), 'pinned');
assert.equal(desktopWindowUrl(4321, 'a b'), 'http://127.0.0.1:4321/?token=a%20b');
assert.deepEqual(bearerHeaders('t'), { Authorization: 'Bearer t' });

// main.mjs must hand the token to the server child and to the window.
const main = readFileSync(new URL('../electron/main.mjs', import.meta.url), 'utf8');
assert(/PI_WEB_TOKEN:\s*serverToken/.test(main), 'server child receives the token');
assert(main.includes('loadURL(desktopWindowUrl(serverPort, serverToken))'), 'window loads with the token');
assert(!/process\.env\.PI_WEB_TOKEN/.test(main), 'main process uses the generated token, not the raw env');
console.log('PASS desktop server token generation and wiring');
