import { describe, it, expect } from "vitest";
import { parseXshell, parseSshConfig } from "../../server/node-sources.js";

describe("node source adapters", () => {
	it("imports Xshell metadata without carrying password ciphertext", () => {
		const node = parseXshell("[CONNECTION]\r\nHost=10.0.0.1\r\nPort=2222\r\nProtocol=SSH\r\n[CONNECTION:AUTHENTICATION]\r\nUserName=deploy\r\nMethod=0\r\nPassword=NEVER_IMPORT\r\n", "prod/api.xsh");
		expect(node).toMatchObject({ host: "10.0.0.1", port: 2222, username: "deploy", name: "api", group: "prod", auth: "password", unsupported: [] });
		expect(JSON.stringify(node)).not.toContain("NEVER_IMPORT");
	});
	it("blocks proxies, non-SSH sessions and unknown authentication", () => {
		expect(parseXshell("[CONNECTION]\nHost=host\nProtocol=TELNET\nProxy=jump\n[CONNECTION:AUTHENTICATION]\nMethod=4", "host.xsh").unsupported).toEqual(expect.arrayContaining(["protocol", "proxy", "authentication", "username"]));
	});
	it("merges SSH wildcard defaults in first-value order and blocks executable directives", () => {
		const nodes = parseSshConfig('Host api other\n HostName 10.0.0.2\n User deploy\n Port 2222\n IdentityFile "~/.ssh/id_ed25519"\nHost * !other\n User fallback\n ProxyCommand nc proxy 22\n');
		expect(nodes).toHaveLength(2);
		expect(nodes[0]).toMatchObject({ name: "api", host: "10.0.0.2", username: "deploy", port: 2222, keyPath: "~/.ssh/id_ed25519", unsupported: ["proxycommand"] });
		expect(nodes[1].unsupported).toEqual([]);
	});
	it("does not execute or silently approximate Include and Match", () => {
		expect(parseSshConfig("Include hosts/*\nHost api\n Match exec bad-command\n User root")[0].unsupported).toEqual(["include", "match"]);
	});
});
