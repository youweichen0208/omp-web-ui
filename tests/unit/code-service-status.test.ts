import { it, expect } from "vitest";
import {
	codeServiceRows,
	codeServiceSummary,
} from "../../web/src/code-service-status.js";
import { codeDefaults } from "../../server/code-intelligence.js";
import type { CodeState, CodeServiceState } from "../../server/protocol.js";
const service = (
	status: string,
	language: CodeServiceState["language"] = "java",
): CodeServiceState => ({
	language,
	status,
	rssMiB: 100,
	restarts: 0,
	heapMiB: 1024,
	checkedFiles: 0,
	pendingFiles: 1,
	unconfirmedFiles: 0,
});
const state = (services: CodeServiceState[] = []): CodeState => ({
	cwd: "/project",
	settings: codeDefaults(),
	trusted: true,
	services,
	diagnostics: [],
	watcherPartial: false,
	toolchainVersion: "fixture",
	feedbackWaits: [],
});
it("never claims a connection before a snapshot or after app disconnect", () => {
	expect(codeServiceSummary(true).kind).toBe("loading");
	expect(codeServiceSummary(false, state([service("ready")])).kind).toBe(
		"offline",
	);
});
it("shows unused languages as not started instead of missing toolchains", () => {
	expect(
		codeServiceRows(state()).every((row) => row.status === "not_started"),
	).toBe(true);
	expect(codeServiceSummary(true, state()).kind).toBe("standby");
});
it("counts connected services without claiming diagnostics are complete", () => {
	expect(codeServiceSummary(true, state([service("ready")]))).toEqual({
		kind: "ready",
		ready: 1,
	});
});
it.each(["missing", "failed", "oom", "untrusted", "unsupported_gradle"])(
	"surfaces %s while another service is connected",
	(status) => {
		expect(
			codeServiceSummary(
				true,
				state([service("ready", "typescript"), service(status)]),
			),
		).toEqual({ kind: "attention", ready: 1 });
	},
);
it("separates startup and disabled settings from connected services", () => {
	expect(codeServiceSummary(true, state([service("initializing")])).kind).toBe(
		"starting",
	);
	const value = state([service("ready")]);
	value.settings.java = false;
	expect(
		codeServiceRows(value).find((row) => row.language === "java")?.status,
	).toBe("disabled");
	expect(codeServiceSummary(true, value).ready).toBe(0);
	value.settings.enabled = false;
	expect(codeServiceSummary(true, value).kind).toBe("disabled");
});
