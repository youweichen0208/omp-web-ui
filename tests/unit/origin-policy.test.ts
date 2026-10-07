import { describe, expect, it } from "vitest";
import { createOriginPolicy, effectiveAllowHosts } from "../../server/origin-policy.js";

const policy = (bindHost: string, allowHosts: string[] = [], allowOrigins: string[] = []) =>
	createOriginPolicy({ bindHost, allowHosts, allowOrigins });

describe("origin policy", () => {
	it("admits same-authority browser requests on loopback hosts", () => {
		const ok = policy("127.0.0.1");
		expect(ok({ host: "localhost:8787", origin: "http://localhost:8787" })).toBe(true);
		expect(ok({ host: "127.0.0.1:8787", origin: "http://127.0.0.1:8787" })).toBe(true);
		expect(ok({ host: "[::1]:8787", origin: "http://[::1]:8787" })).toBe(true);
	});

	it("rejects DNS rebinding on a loopback bind", () => {
		const ok = policy("127.0.0.1");
		expect(ok({ host: "evil.com:8787", origin: "http://evil.com:8787" })).toBe(false);
		expect(ok({ host: "evil.com:8787" })).toBe(false);
	});

	it("rejects cross-port and null origins", () => {
		const ok = policy("127.0.0.1");
		expect(ok({ host: "localhost:8787", origin: "http://localhost:9999" })).toBe(false);
		expect(ok({ host: "localhost:8787", origin: "null" })).toBe(false);
	});

	it("admits non-browser clients without Origin", () => {
		expect(policy("127.0.0.1")({ host: "127.0.0.1:8787" })).toBe(true);
	});

	it("honors PI_WEB_ALLOW_ORIGINS (dev proxy)", () => {
		const ok = policy("127.0.0.1", [], ["http://localhost:5173"]);
		expect(ok({ host: "localhost:8788", origin: "http://localhost:5173" })).toBe(true);
	});

	it("keeps same-authority behavior on non-loopback binds", () => {
		const ok = policy("0.0.0.0");
		expect(ok({ host: "nas.lan:8787", origin: "http://nas.lan:8787" })).toBe(true);
		expect(effectiveAllowHosts("0.0.0.0", [])).toEqual([]);
	});

	it("explicit allowlist overrides the loopback default", () => {
		const ok = policy("127.0.0.1", ["pi.example.com"]);
		expect(ok({ host: "pi.example.com:443", origin: "http://pi.example.com:443" })).toBe(true);
		expect(ok({ host: "localhost:8787" })).toBe(false);
	});
});
