import { pathToFileURL } from "node:url";
import { join } from "node:path";
import { getPackageDir, VERSION, type AgentSession } from "@earendil-works/pi-coding-agent";

/** Internal API of pinned 1.0.3, located by the SDK itself in npm and desktop layouts. */
export async function expandNativeTemplate(text: string, templates: AgentSession["promptTemplates"]): Promise<string> {
	if (VERSION !== "1.0.3") throw new Error("Unsupported native prompt template contract");
	const module = await import(pathToFileURL(join(getPackageDir(), "dist/core/prompt-templates.js")).href);
	if (typeof module.expandPromptTemplate !== "function") throw new Error("Native prompt template adapter unavailable");
	return module.expandPromptTemplate(text, templates);
}
