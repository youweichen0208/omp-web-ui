/** Pre-1.0 launchd agent: relabel on migration, remove on install/uninstall. */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { LEGACY_LAUNCHD_LABEL, legacyLaunchdPlan, relabelPlist } from '../bin/launchd-legacy.mjs';

const NEW = 'com.youweichen.pi-web-ui';
const plist = `<?xml version="1.0"?>\n<plist version="1.0">\n<dict>\n  <key>Label</key>\n  <string>${LEGACY_LAUNCHD_LABEL}</string>\n  <key>WorkingDirectory</key>\n  <string>/Users/me/project</string>\n  <key>EnvironmentVariables</key>\n  <dict><key>PORT</key><string>9000</string></dict>\n</dict>\n</plist>\n`;

const relabeled = relabelPlist(plist, LEGACY_LAUNCHD_LABEL, NEW);
assert(relabeled.includes(`<key>Label</key>\n  <string>${NEW}</string>`), 'label replaced');
assert(!relabeled.includes(LEGACY_LAUNCHD_LABEL), 'old label gone');
assert(relabeled.includes('<string>9000</string>') && relabeled.includes('/Users/me/project'), 'port and directory kept');
assert.equal(relabelPlist(plist.replace(LEGACY_LAUNCHD_LABEL, 'other.label'), LEGACY_LAUNCHD_LABEL, NEW), null, 'unknown label is not touched');
// The dots in the label are literal, not regex wildcards.
assert.equal(relabelPlist(plist.replace(LEGACY_LAUNCHD_LABEL, LEGACY_LAUNCHD_LABEL.replaceAll('.', 'x')), LEGACY_LAUNCHD_LABEL, NEW), null);

assert.equal(legacyLaunchdPlan({ legacyExists: false, targetExists: false, action: 'restart' }), 'none');
for (const action of ['start', 'stop', 'restart', 'status', 'shortcut']) assert.equal(legacyLaunchdPlan({ legacyExists: true, targetExists: false, action }), 'migrate', action);
for (const action of ['install', 'uninstall']) assert.equal(legacyLaunchdPlan({ legacyExists: true, targetExists: false, action }), 'remove', action);
assert.equal(legacyLaunchdPlan({ legacyExists: true, targetExists: true, action: 'restart' }), 'remove', 'never overwrite an agent under the new label');

// The old label exists in exactly one place in the shipped sources.
for (const file of ['bin/pi-web-ui.mjs', 'deploy/com.youweichen.pi-web-ui.plist']) {
	assert(!readFileSync(new URL(`../${file}`, import.meta.url), 'utf8').includes(LEGACY_LAUNCHD_LABEL), `${file} must not mention the old label`);
}
assert.match(readFileSync(new URL('../bin/pi-web-ui.mjs', import.meta.url), 'utf8'), /\? "com\.youweichen\.pi-web-ui"/, 'new default label');
console.log('PASS pre-1.0 launchd label is migrated or removed, never kept');
