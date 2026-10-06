import { createRequire } from "node:module";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { VERSION, type AgentSession, type BuildSystemPromptOptions } from "@earendil-works/pi-coding-agent";
import type { PromptSectionView, PromptRuleView } from "./protocol.js";
const sdkFile = createRequire(import.meta.url).resolve.paths("@earendil-works/pi-coding-agent")?.map(path=>join(path,"@earendil-works/pi-coding-agent/dist/core/system-prompt.js")).find(path=>existsSync(path));
if(!sdkFile)throw Error("Native system prompt builder not found");
const builders = await import(pathToFileURL(sdkFile).href) as {
	buildSystemPrompt(options: BuildSystemPromptOptions): string;
	buildSystemPromptSections(options: BuildSystemPromptOptions): Record<string,string>;
};
export const nativePromptSections = builders.buildSystemPromptSections;
export const nativePromptText = builders.buildSystemPrompt;
export const estimatePromptTokens = (text: string) => Math.ceil(text.replace(/[\u2e80-\u9fff\uf900-\ufaff]/g,"xxxx").length/4);
const unwrap = (name: string, text: string) => name === "preamble" ? text : text.slice(`<${name}>\n`.length,-`\n</${name}>`.length);
const rules = (text: string) => text.split(/\n(?=- )/).map(s=>s.replace(/^- /,"").trim()).filter(Boolean);
/** Read-only adapter for the exact pinned SDK. Rendering must match the public getter before exposing editable structure. */
export function promptView(session: AgentSession, cwd: string) {
	const raw = session.systemPrompt;
	const internals = session as unknown as { _runSystemPromptOptions?: BuildSystemPromptOptions; _baseSystemPromptOptions?: BuildSystemPromptOptions };
	const options = internals._runSystemPromptOptions ?? internals._baseSystemPromptOptions;
	const defaultPreamble = nativePromptSections({cwd}).preamble;
	if (VERSION !== "1.0.4" || !options || nativePromptText(options) !== raw) return { raw, defaultPreamble, opaque: true, forced: false, sections: [] as PromptSectionView[], rules: [] as PromptRuleView[], options: undefined };
	if (options.forceSystemPrompt !== undefined) return {raw,defaultPreamble,opaque:true,forced:true,sections:[] as PromptSectionView[],rules:[] as PromptRuleView[],options:undefined};
	const built = nativePromptSections(options);
	const sections = Object.entries(built).map(([name,text])=>({name,text:unwrap(name,text)}));
	const active = (options.selectedTools ?? ["read", "bash", "edit", "write"]).filter(name => !options.hiddenTools?.includes(name));
	const definitions = session.getAllTools();
	const sources = new Map<string,Omit<PromptRuleView,"text">>();
	const fixed = rules(unwrap("rules",nativePromptSections({cwd,selectedTools:[]}).rules));
	const allBuiltin = rules(unwrap("rules",nativePromptSections({cwd,selectedTools:active}).rules));
	for(const text of allBuiltin.filter(text=>!fixed.includes(text))) sources.set(text,{kind:"builtin"});
	for(const name of active) for(const text of options.toolGuidelines?.[name]??[]) {
		const normalized=text.trim();if(!sources.has(normalized))sources.set(normalized,{kind:"tool",name,path:definitions.find(t=>t.name===name)?.sourceInfo.path});
	}
	// The SDK supplies no per-handler attribution for promptGuidelines. Never invent an extension name.
	for(const text of options.promptGuidelines??[]) if(!sources.has(text.trim()))sources.set(text.trim(),{kind:"extension"});
	for(const text of fixed) if(!sources.has(text))sources.set(text,{kind:"builtin"});
	const ruleViews: PromptRuleView[] = built.rules ? rules(unwrap("rules",built.rules)).map(text=>({text,...sources.get(text)??{kind:"unknown" as const}})) : [];
	return {raw,defaultPreamble,opaque:false,forced:false,sections,rules:ruleViews,options};
}
