/** Offline Maven reactor fixture; no company repositories or user settings are changed. */
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { pathToFileURL } from "node:url";
const appRoot = resolve(process.env.PI_NATIVE_APP_ROOT || process.cwd());
const { CodeIntelligenceManager, codeDefaults } = await import(
	pathToFileURL(join(appRoot, "dist/server/code-intelligence.js"))
);
const root = await mkdtemp(join(tmpdir(), "pi-maven-reactor-"));
const data = process.env.PI_NATIVE_TEST_DATA || join(root, "data");
const manager = new CodeIntelligenceManager(data, () => true);
const version = process.env.PI_NATIVE_JAVA_VERSION || "21";
const projectJdk = process.env.PI_NATIVE_PROJECT_JDK;
const source = version === "8" ? "1.8" : version;
const parent =
	"<parent><groupId>fixture</groupId><artifactId>reactor</artifactId><version>1</version></parent>";
const rawFiles = {
	"pom.xml": `<project><modelVersion>4.0.0</modelVersion><groupId>fixture</groupId><artifactId>reactor</artifactId><version>1</version><packaging>pom</packaging><modules><module>library</module><module>app</module></modules><properties><maven.compiler.source>${source}</maven.compiler.source><maven.compiler.target>${source}</maven.compiler.target></properties></project>`,
	"library/pom.xml": `<project><modelVersion>4.0.0</modelVersion>${parent}<artifactId>library</artifactId></project>`,
	"app/pom.xml": `<project><modelVersion>4.0.0</modelVersion>${parent}<artifactId>app</artifactId><dependencies><dependency><groupId>fixture</groupId><artifactId>library</artifactId><version>1</version></dependency></dependencies></project>`,
	"library/src/main/java/fixture/library/Library.java":
		"package fixture.library;\npublic class Library { public static int square(int x) { return x*x; } }\n",
	"app/src/main/java/fixture/app/App.java":
		'package fixture.app;\nimport fixture.library.Library;\npublic class App { public static int calculate() { return Library.square(2); } int broken = "wrong"; }\n',
};
const prefix = process.env.PI_NATIVE_MAVEN_PREFIX || "";
const files = Object.fromEntries(
	Object.entries(rawFiles).map(([path, text]) => [
		prefix ? `${prefix}/${path}` : path,
		text,
	]),
);
const path = `${prefix ? prefix + "/" : ""}app/src/main/java/fixture/app/App.java`;
const wait = (ms) => new Promise((done) => setTimeout(done, ms));
async function diagnostics(predicate) {
	let result;
	for (let i = 0; i < 240; i++) {
		result = await manager.query(root, { action: "diagnostics", path });
		if (result.freshness === "fresh" && predicate(result)) return result;
		await wait(250);
	}
	throw Error(
		`Maven reactor diagnostics did not settle: ${JSON.stringify(result)}`,
	);
}
try {
	for (const [path, text] of Object.entries(files)) {
		await mkdir(join(root, path, ".."), { recursive: true });
		await writeFile(join(root, path), text);
	}
	const userSettings = join(root, "fixture-user-settings.xml");
	const globalSettings = join(root, "fixture-global-settings.xml");
	await writeFile(
		userSettings,
		'<settings xmlns="http://maven.apache.org/SETTINGS/1.2.0"><interactiveMode>false</interactiveMode></settings>',
	);
	await writeFile(
		globalSettings,
		'<settings xmlns="http://maven.apache.org/SETTINGS/1.2.0"></settings>',
	);
	await manager.configure(root, {
		...codeDefaults(),
		mavenUserSettings: userSettings,
		mavenGlobalSettings: globalSettings,
		...(projectJdk ? { javaProjectHomes: { [version]: projectJdk } } : {}),
	});
	const before = await diagnostics((r) =>
		r.diagnostics.some((d) => d.severity === 1),
	);
	assert(
		before.diagnostics.every((d) => !/cannot be resolved/.test(d.message)),
		`Reactor dependency must resolve: ${JSON.stringify(before)}`,
	);
	const definition = await manager.query(root, {
		action: "navigate",
		operation: "definition",
		path,
		line: 3,
		symbol: "square",
	});
	assert(
		JSON.stringify(definition).includes(
			"library/src/main/java/fixture/library/Library.java",
		),
		`Cross-module definition: ${JSON.stringify(definition)}`,
	);
	await writeFile(join(root, path), files[path].replace('"wrong"', "1"));
	await diagnostics((r) => !r.diagnostics.some((d) => d.severity === 1));
	console.log(
		`PASS Maven Java ${version} reactor: cross-module source definition, dependency resolution and repaired diagnostics`,
	);
} finally {
	await manager.shutdown();
	await rm(root, { recursive: true, force: true });
}
