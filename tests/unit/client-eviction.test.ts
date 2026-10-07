import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { ClientStateStore } from "../../server/client-state.js";
import { DEFAULT_CLIENT_IDLE_MS, clientIdleMsFromEnv, isClientEvictable, type ClientIdleFacts } from "../../server/client-eviction.js";

const idle: ClientIdleFacts = {
	socketCount: 0, idleSince: 1_000, streamingConversations: 0, queuedMessages: 0,
	liveTerminals: 0, backgroundTasks: 0, switchingWorkspace: false, disposed: false,
};
const LATER = 1_000 + DEFAULT_CLIENT_IDLE_MS;

describe("isClientEvictable", () => {
	it("evicts a quiet client once the idle window has passed", () => {
		expect(isClientEvictable(idle, LATER, DEFAULT_CLIENT_IDLE_MS)).toBe(true);
		expect(isClientEvictable(idle, LATER - 1, DEFAULT_CLIENT_IDLE_MS)).toBe(false);
	});

	it.each([
		["a socket is attached", { socketCount: 1 }],
		["it was never detached", { idleSince: 0 }],
		["a run is streaming", { streamingConversations: 1 }],
		["messages are queued", { queuedMessages: 2 }],
		["a terminal is alive", { liveTerminals: 1 }],
		["background servers are tracked", { backgroundTasks: 1 }],
		["the workspace is switching", { switchingWorkspace: true }],
		["it is already disposed", { disposed: true }],
	])("keeps the client when %s", (_name, patch) => {
		expect(isClientEvictable({ ...idle, ...patch }, LATER * 10, DEFAULT_CLIENT_IDLE_MS)).toBe(false);
	});

	it("is disabled when the idle time is 0", () => {
		expect(isClientEvictable(idle, LATER * 10, 0)).toBe(false);
	});

	it("parses PI_WEB_CLIENT_IDLE_MINUTES", () => {
		expect(clientIdleMsFromEnv(undefined)).toBe(DEFAULT_CLIENT_IDLE_MS);
		expect(clientIdleMsFromEnv("")).toBe(DEFAULT_CLIENT_IDLE_MS);
		expect(clientIdleMsFromEnv("5")).toBe(300_000);
		expect(clientIdleMsFromEnv("0")).toBe(0);
		expect(clientIdleMsFromEnv("abc")).toBe(DEFAULT_CLIENT_IDLE_MS);
		expect(clientIdleMsFromEnv("-1")).toBe(DEFAULT_CLIENT_IDLE_MS);
	});
});

describe("ClientStateStore pruning", () => {
	const dir = mkdtempSync(join(tmpdir(), "client-state-"));
	afterAll(() => rmSync(dir, { recursive: true, force: true }));

	it("keeps the file bounded and drops the least recently used clients", () => {
		const file = join(dir, "client-state.json");
		const store = new ClientStateStore(file);
		store.remember("desktop", "/work/desktop");
		for (let i = 0; i < 250; i++) store.remember(`tab-${i}`, `/work/${i}`);
		store.remember("desktop", "/work/desktop"); // used again: now the most recent
		const saved = JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>;
		expect(Object.keys(saved)).toHaveLength(200);
		expect(saved["desktop"]).toBeDefined();
		expect(saved["tab-249"]).toBeDefined();
		expect(saved["tab-0"]).toBeUndefined();
	});
});
