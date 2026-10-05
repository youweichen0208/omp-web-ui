import { describe, it, expect } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { ProjectTrustStore, DefaultPackageManager, SettingsManager } from "@earendil-works/pi-coding-agent";
import { nativeSkills } from "../../server/skills-service.js";

function fixture() {
	const root = mkdtempSync(join(tmpdir(), "settings-skills-")), cwd = join(root, "project"), agent = join(root, "agent"), pkg = join(root, "package");
	for (const dir of [cwd, agent, pkg]) mkdirSync(dir);
	const skill = (base: string, name: string) => { const path = join(base, "skills", name); mkdirSync(path, { recursive: true }); writeFileSync(join(path, "SKILL.md"), `---\nname: ${name}\ndescription: Fixture ${name}\n---\nInstructions`); };
	skill(agent, "personal-fixture"); skill(pkg, "package-one"); skill(pkg, "package-two"); skill(join(cwd, ".pi"), "project-fixture");
	writeFileSync(join(pkg, "package.json"), JSON.stringify({ name: "skill-package", pi: { skills: ["skills"], extensions: ["entry.js"] } }));
	writeFileSync(join(pkg, "entry.js"), 'throw Error("Browsing must not execute this extension");');
	writeFileSync(join(agent, "settings.json"), JSON.stringify({ packages: [{ source: pkg, skills: [], extensions: ["entry.js"] }], skills: ["-skills/personal-fixture"], custom: { keep: true } }));
	return { root, cwd, agent, pkg };
}
describe("native skill controls", () => {
	it("persists isolated native filters, preserves sibling resources, rejects stale and foreign requests", async () => {
		const { root, cwd, agent } = fixture();
		try {
			let state = await nativeSkills(cwd, agent);
			expect(state.skills.find(s => s.name === "project-fixture")).toBeUndefined();
			const initiallyDisabled = state.skills.find(s => s.name === "personal-fixture")!;
			expect(initiallyDisabled.enabled).toBe(false);
			state = await nativeSkills(cwd, agent, { id: initiallyDisabled.id, version: state.version, enabled: true });
			expect(state.skills.find(s => s.id === initiallyDisabled.id)?.enabled).toBe(true);
			const first = state.skills.find(s => s.name === "package-one")!;
			expect(first.enabled).toBe(false);
			state = await nativeSkills(cwd, agent, { id: first.id, version: state.version, enabled: true });
			expect(state.skills.find(s => s.name === "package-one")?.enabled).toBe(true);
			expect(state.skills.find(s => s.name === "package-two")?.enabled).toBe(false);
			const personal = state.skills.find(s => s.name === "personal-fixture")!;
			const old = state.version;
			state = await nativeSkills(cwd, agent, { id: personal.id, version: old, enabled: false });
			expect(state.skills.find(s => s.id === personal.id)?.enabled).toBe(false);
			await expect(nativeSkills(cwd, agent, { id: personal.id, version: old, enabled: true })).rejects.toThrow(/changed/);
			await expect(nativeSkills(cwd, agent, { id: "foreign", version: state.version, enabled: true })).rejects.toThrow(/unavailable/);
			await expect(nativeSkills(cwd, agent, { id: personal.id, version: state.version, enabled: true }, () => false)).rejects.toThrow(/Workspace changed/);
			state = await nativeSkills(cwd, agent, { id: personal.id, version: state.version, enabled: true });
			expect(state.skills.find(s => s.id === personal.id)?.enabled).toBe(true);
			const config = JSON.parse(readFileSync(join(agent, "settings.json"), "utf8"));
			expect(config.custom).toEqual({ keep: true }); expect(config.packages[0].extensions).toEqual(["entry.js"]);
			const resolved = await new DefaultPackageManager({ cwd, agentDir: agent, settingsManager: SettingsManager.create(cwd, agent) }).resolve(async () => "skip");
			expect(resolved.extensions.some(e => e.path.endsWith("entry.js") && e.enabled)).toBe(true);
			new ProjectTrustStore(agent).set(cwd, true);
			state = await nativeSkills(cwd, agent);
			const project = state.skills.find(s => s.name === "project-fixture")!;
			state = await nativeSkills(cwd, agent, { id: project.id, version: state.version, enabled: false });
			expect(state.skills.find(s => s.id === project.id)?.enabled).toBe(false);
			expect(JSON.parse(readFileSync(join(cwd, ".pi/settings.json"), "utf8")).skills).toHaveLength(1);
		} finally { rmSync(root, { recursive: true, force: true }); }
	});
});
