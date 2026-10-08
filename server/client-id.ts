/**
 * clientId arrives from the browser and is later used in file paths (uploads/<clientId>/)
 * and as a map key. Real ids are UUIDs; accept any plain token that cannot
 * contain a path separator or start with a dot.
 */
const CLIENT_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

export function isValidClientId(value: unknown): value is string {
	return typeof value === "string" && CLIENT_ID_RE.test(value);
}
