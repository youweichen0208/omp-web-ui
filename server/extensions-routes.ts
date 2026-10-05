import { nativeSkills } from "./skills-service.js";
import { mkdirSync, readFileSync, writeFileSync, renameSync, statSync, realpathSync, existsSync } from "node:fs";
import { createHash } from "node:crypto";
import { killPidTree } from "./process-utils.js";
import type { Express, Request } from "express";
import { fork } from "node:child_process";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import type { AgentService } from "./agent-service.js";
import type { ExtensionsState, ExtensionJob, ExtensionPreview, ExtensionOperation } from "./protocol.js";
import type { WorkerRequest } from "./extensions-worker.js";
import { readJson, textField, resourceTypes, sourceInfo, validateSource } from "./extensions-model.js";
import { browseCatalog, cachedFetch, safeUrl, packageReleaseNotes } from "./extensions-catalog.js";

const jobs = new Map<string, ExtensionJob & { cwd: string; clientId: string }>();
const tickets = new Map<string, { cwd: string; clientId: string; until: number; preview: ExtensionPreview }>();
const states = new Map<string, ExtensionsState>();
let mutation: string | undefined;
let readers = 0;
let canBackgroundRun = () => false;
const background = new Map<string, { agentDir:string; next:number }>();
function autoCheckEnabled(agentDir:string): boolean { try { return readJson(join(agentDir,"webui-extensions.json")).autoCheck !== false; } catch { return false; } }
const backgroundTimer = setInterval(() => {
	if (mutation || readers || !canBackgroundRun()) return;
	const entry = [...background].find(([,v])=>v.next <= Date.now()); if (!entry) return;
	const [cwd,target] = entry; target.next = Date.now()+6*60*60*1000;
	if (!autoCheckEnabled(target.agentDir)) return;
	readers++;
	void runWorker({cwd,agentDir:target.agentDir,action:"check"}).then(state=>states.set(cwd,state)).catch(()=>{}).finally(()=>{readers--;});
},60000);
backgroundTimer.unref();
function runWorker(input: WorkerRequest, log: (line: string) => void = () => {}): Promise<ExtensionsState> {
	return new Promise((resolve, reject) => {
		const child = fork(new URL(import.meta.url.endsWith(".ts") ? "./extensions-worker.ts" : "./extensions-worker.js", import.meta.url), ["--extensions-worker"], { detached: process.platform !== "win32", stdio: ["ignore","pipe","pipe","ipc"], execArgv: process.execArgv.filter(a => !a.startsWith("--watch")), env: { ...process.env, ELECTRON_RUN_AS_NODE: "1", GIT_TERMINAL_PROMPT: "0" } });
		let result: ExtensionsState | undefined, failure: Error | undefined;
		child.stdout?.on("data", chunk => log(String(chunk))); child.stderr?.on("data", chunk => log(String(chunk)));
		child.on("message", (message: { progress?: string; state?: ExtensionsState; error?: string }) => { if (message.progress) log(message.progress); if (message.state) result = message.state; if (message.error) failure = Error(message.error); });
		const stop = () => { if (child.pid) killPidTree(child.pid); };
		process.once("exit", stop);
		const timer = setTimeout(() => { failure = Error("Package operation timed out"); stop(); }, input.action === "mutate" ? 20*60*1000 : 120000);
		child.once("error", error => { clearTimeout(timer); process.removeListener("exit",stop); reject(error); });
		child.once("exit", () => { clearTimeout(timer); process.removeListener("exit",stop); result && !failure ? resolve(result) : reject(failure ?? Error("Package worker stopped")); });
		child.send(input);
	});
}
async function previewSource(source: string): Promise<Omit<ExtensionPreview,"ticket">> {
	const info = sourceInfo(source);
	let meta: Record<string, any> = {};
	if (info.kind === "npm") meta = await cachedFetch(`https://registry.npmjs.org/${encodeURIComponent(info.name)}/${encodeURIComponent(info.ref ?? "latest")}`);
	if (info.kind === "local") { try { meta = readJson(join(source,"package.json")); } catch (e) { if ((e as NodeJS.ErrnoException).code !== "ENOTDIR") throw e; } }
	const resources: Record<string,string[]> = {};
	for (const type of resourceTypes) if (Array.isArray(meta.pi?.[type])) resources[type] = meta.pi[type].filter((v: unknown) => typeof v === "string").slice(0,100);
	return { source, name: textField(meta.name) ?? info.name, version: textField(meta.version), description: textField(meta.description), author: textField(typeof meta.author === "string" ? meta.author : meta.author?.name), repository: safeUrl(typeof meta.repository === "string" ? meta.repository : meta.repository?.url), resources, canPin: info.kind === "npm" && typeof meta.version === "string" };
}
export function installExtensionsRoutes(app: Express, service: () => AgentService, originAllowed: (req: Request) => boolean) {
	canBackgroundRun = () => !service().quiesceInfo().quiesced;
	app.post("/api/extensions", async (req,res) => {
		res.setHeader("Cache-Control", "no-store");
		if (!originAllowed(req) || !req.is("application/json")) { res.sendStatus(403); return; }
		const { clientId, cwd, action } = req.body ?? {};
		const cs = typeof clientId === "string" ? service().get(clientId) : undefined;
		if (!cs || cs.cwd !== cwd || cs.switchingWorkspace || service().quiesceInfo().quiesced) { res.status(409).json({ error: "Workspace unavailable" }); return; }
		const agentDir = getAgentDir();
		try {
			if (action === "open-info" && req.body.id === "skills:user") {
				const path = join(agentDir, "skills");
				res.json({ absolute: existsSync(path) ? path : agentDir }); return;
			}
			if (action === "skills-list" || action === "skills-toggle") {
				if (mutation || readers >= 4) throw Error("Package manager busy");
				const change = action === "skills-toggle" ? req.body : undefined;
				if (change && (typeof change.id !== "string" || typeof change.enabled !== "boolean" || typeof change.version !== "string")) throw Error("Invalid skill change");
				if (change) mutation = randomUUID();
				readers++;
				try {
					const valid = () => cs.cwd === cwd && !cs.switchingWorkspace && !service().quiesceInfo().quiesced;
					const state = await nativeSkills(cwd, agentDir, change, valid);
					if (!valid()) throw Error("Workspace changed");
					res.json(state);
				} finally { readers--; if (change) mutation = undefined; }
				return;
			}
			if (action === "preferences") {
				if (typeof req.body.enabled !== "boolean") throw Error("Invalid preference");
				const path=join(agentDir,"webui-extensions.json"), previous=readJson(path);mkdirSync(agentDir,{recursive:true});writeFileSync(`${path}.tmp`,JSON.stringify({...previous,autoCheck:req.body.enabled}),{mode:0o600});renameSync(`${path}.tmp`,path);res.json({autoCheck:req.body.enabled});return;
			}
			if (action === "search") { res.json(await browseCatalog(String(req.body.query ?? ""),String(req.body.type ?? ""),String(req.body.sort ?? ""), Number(req.body.page) || 1)); return; }
			if (action === "preview") {
				const preview = { ...await previewSource(validateSource(req.body.source,cwd)), ticket: randomUUID() };
				if (tickets.size >= 64) tickets.delete(tickets.keys().next().value!);
				tickets.set(preview.ticket, { cwd,clientId,until: Date.now()+1200000,preview }); res.json(preview); return;
			}
			if (action === "job") { const job = jobs.get(req.body.id); if (!job || job.clientId !== clientId || job.cwd !== cwd) throw Error("Operation not found"); res.json(job); return; }
			if (action === "start") {
				if (mutation) throw Error("Package manager is busy; retry shortly");
				const op = req.body.operation as ExtensionOperation;
				if (!op || !["install","remove","toggle","update","update-all","unpin","move"].includes(op.action) || op.scope && !["user","project"].includes(op.scope) || op.action === "toggle" && typeof op.enabled !== "boolean") throw Error("Invalid operation");
				let source: string | undefined;
				if (op.action === "install") {
					const ticket = tickets.get(op.ticket ?? "");
					if (!ticket || ticket.cwd !== cwd || ticket.clientId !== clientId || ticket.until < Date.now()) throw Error("Install preview expired; review the source again");
					source = ticket.preview.source;
					if (op.pin && ticket.preview.canPin) source = `${sourceInfo(source).unpinned}@${ticket.preview.version}`;
					tickets.delete(op.ticket!);
				}
				const id = randomUUID(), job = { id,phase: "running" as const,log: "",cwd,clientId } as ExtensionJob & { cwd:string;clientId:string };
				if (jobs.size >= 32) jobs.delete(jobs.keys().next().value!); jobs.set(id,job); mutation=id;
				void runWorker({ cwd,agentDir,action:"mutate",operation:op,source,version:req.body.version }, line => { job.log = (job.log + line + "\n").slice(-128000); }).then(() => { states.delete(cwd); job.phase="done"; }, error => { job.phase="error";job.error=error.message;job.log += `\n${error.message}`; }).finally(() => { mutation=undefined; });
				res.json(job); return;
			}
			if (action !== "list" && action !== "check" && !["open-info","file","save-file","notes"].includes(action)) throw Error("Unknown action");
			if (mutation) throw Error("Package operation running");
			if (readers >= 4) throw Error("Package manager busy");
			readers++;
			try {
				const cached = states.get(cwd);
				const state = await runWorker({ cwd,agentDir,action:action === "check" ? "check" : "list" });
				if (cs.cwd !== cwd || cs.switchingWorkspace) throw Error("Workspace changed");
				if (["file","save-file","notes"].includes(action)) {
					const item = state.packages.find(p => p.id === req.body.id); if (!item) throw Error("Package unavailable");
					if (action === "notes") { res.json(item.kind === "npm" ? await packageReleaseNotes(sourceInfo(item.source).name) : { title: item.version ?? "", notes: [] }); return; }
					if (item.kind !== "file" || !item.trusted || !item.path || !/\.[cm]?[jt]s$/.test(item.path)) throw Error("Only trusted standalone extension files can be edited here");
					const path = realpathSync(item.path), info = statSync(path); if (!info.isFile() || info.size > 512*1024) throw Error("Extension file exceeds editor limit (512 KB)");
					const raw = readFileSync(path), version = createHash("sha256").update(raw).digest("hex");
					if (action === "save-file") {
						if (mutation) throw Error("Package operation running");
						if (version !== req.body.version) throw Error("File changed externally; reopen before saving");
						if (typeof req.body.content !== "string" || Buffer.byteLength(req.body.content) > 512*1024) throw Error("Invalid extension content");
						const temp = `${path}.${randomUUID()}.tmp`; writeFileSync(temp,req.body.content,{mode:info.mode}); renameSync(temp,path); res.json({ saved:true });
					} else res.json({ content:new TextDecoder("utf-8",{fatal:true}).decode(raw),version });
					return;
				}
				if (action === "open-info") { const item = state.packages.find(p => p.id === req.body.id); if (!item?.path) throw Error("Installed path unavailable"); res.json({ absolute:item.path }); return; }
				if (action === "check") { if (states.size > 32) states.delete(states.keys().next().value!); states.set(cwd,state); }
				else if (cached?.version === state.version) { state.checkedAt=cached.checkedAt; for (const item of state.packages) { const old=cached.packages.find(p=>p.id===item.id); if (old?.version===item.version) Object.assign(item,{update:old?.update,latest:old?.latest,checkError:old?.checkError}); } }
				state.autoCheck=autoCheckEnabled(agentDir);
				if (background.size>32) background.delete(background.keys().next().value!);
				background.set(cwd,{agentDir,next:Math.max(Date.now()+60000,(state.checkedAt??0)+6*60*60*1000)});
				res.json(state);
			} finally { readers--; }
		} catch (error) { res.status(400).json({ error: error instanceof Error ? error.message : String(error) }); }
	});
}
