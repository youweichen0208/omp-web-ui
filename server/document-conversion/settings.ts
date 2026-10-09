import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";

export interface DocumentExtensionSettings {
	pdfEnabled: boolean;
	okfEnabled: boolean;
	pythonPath?: string;
	runtimePath?: string;
}

export function documentDataDir(): string {
	return resolve(process.env.PI_WEB_DATA_DIR ?? join(homedir(), ".pi-web"));
}

function readSettings(): Record<string, unknown> {
	try {
		const value: unknown = JSON.parse(readFileSync(join(documentDataDir(), "document-extensions.json"), "utf8"));
		if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Expected an object");
		return value as Record<string, unknown>;
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return {};
		throw new Error(`Cannot read document-extensions.json: ${error instanceof Error ? error.message : String(error)}`);
	}
}

function validate(value: Record<string, unknown>): DocumentExtensionSettings {
	const result: DocumentExtensionSettings = { pdfEnabled: true, okfEnabled: true };
	for (const key of ["pdfEnabled", "okfEnabled"] as const) {
		if (value[key] !== undefined) {
			if (typeof value[key] !== "boolean") throw new Error(`${key} must be a boolean`);
			result[key] = value[key];
		}
	}
	for (const key of ["pythonPath", "runtimePath"] as const) {
		const path = value[key];
		if (path === undefined || path === "") continue;
		if (typeof path !== "string" || !isAbsolute(path) || /[\0\r\n]/.test(path)) throw new Error(`${key} must be an absolute filesystem path`);
		result[key] = resolve(path);
	}
	return result;
}

/** Read on every invocation so already loaded sessions honor a global disable. */
export function getDocumentSettings(): DocumentExtensionSettings {
	return validate(readSettings());
}

export function updateDocumentSettings(patch: Partial<DocumentExtensionSettings>): DocumentExtensionSettings {
	const saved = readSettings();
	const next = validate({ ...saved, ...patch });
	const output = { ...saved, ...next };
	for (const key of ["pythonPath", "runtimePath"] as const) if (!next[key]) delete output[key];
	const folder = documentDataDir();
	mkdirSync(folder, { recursive: true });
	const target = join(folder, "document-extensions.json");
	const temporary = `${target}.${randomUUID()}.tmp`;
	try {
		writeFileSync(temporary, JSON.stringify(output, null, 2) + "\n", { mode: 0o600, flag: "wx" });
		renameSync(temporary, target);
	} finally { rmSync(temporary, { force: true }); }
	return next;
}
