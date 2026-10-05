import type { Express, Request } from "express";
import type { AgentService } from "./agent-service.js";
import type { WikiConversationResult } from "./protocol.js";
import { WikiService, wikiPath } from "./wiki-service.js";
import { statSync } from "node:fs";
import { extname } from "node:path";

/** Wiki uses the same authenticated client and original SDK session as chat. */
export function installWikiRoutes(app: Express, service: () => AgentService, dataDir: string, originAllowed: (req: Request) => boolean) {
	const wiki = new WikiService(dataDir);
	app.post("/api/wiki", async (req, res) => {
		res.setHeader("Cache-Control", "no-store");
		if (!originAllowed(req) || !req.is("application/json")) { res.status(403).json({ error: "Forbidden" }); return; }
		const { clientId, cwd, action, path, query, text, version, id, undo, conversationId, requestId, offset } = req.body ?? {};
		if (![clientId, cwd, action].every(v => typeof v === "string")) { res.status(400).json({ error: "Invalid request" }); return; }
		const cs = service().get(clientId);
		if (!cs || cs.switchingWorkspace || cs.cwd !== cwd) { res.status(409).json({ error: "Workspace unavailable" }); return; }
		const session = cs.session;
		const valid = () => !cs.switchingWorkspace && cs.cwd === cwd && cs.session === session;
		try {
			let result: unknown;
			switch (action) {
				case "new-conversation": {
					if (conversationId !== cs.conversationId || service().quiesceInfo().quiesced) throw new Error("Conversation unavailable");
					// Validate the target before leaving the current native session.
					if (typeof path !== "string") throw new Error("Invalid path");
					if (!statSync(wikiPath(cwd, path)).isFile()) throw new Error("Not a file");
					if (!valid()) throw new Error("Conversation changed");
					if (!await cs.newChat(true)) throw new Error("Could not create conversation");
					if (cs.cwd !== cwd || cs.switchingWorkspace || cs.conversationId === conversationId) throw new Error("Could not create conversation");
					res.json({ conversationId: cs.conversationId } satisfies WikiConversationResult); return;
				}
				case "open-info": { if (typeof path !== "string") throw new Error("Invalid path"); const absolute = wikiPath(cwd, path); if (!statSync(absolute).isFile()) throw new Error("Not a file"); result = { absolute }; break; }
				case "state": result = await wiki.state(cwd); break;
				case "directory": if (typeof path !== "string") throw new Error("Invalid path"); result = await wiki.directory(cwd, path, offset); break;
				case "document-content": if (typeof path !== "string") throw new Error("Invalid path"); result = await wiki.documentContent(cwd, path); break;
				case "document-references": if (typeof path !== "string") throw new Error("Invalid path"); result = await wiki.documentReferences(cwd, path); break;
				case "document": if (typeof path !== "string") throw new Error("Invalid path"); result = await wiki.document(cwd, path); break;
				case "change": if (typeof path !== "string" || typeof id !== "string") throw new Error("Invalid change"); result = wiki.change(cwd, id, path); break;
				case "search": if (typeof query !== "string") throw new Error("Invalid query"); result = await wiki.search(cwd, query); break;
				case "refresh": wiki.invalidate(cwd); result = await wiki.state(cwd, true); break;
				case "write":
					if (service().quiesceInfo().quiesced || session.isStreaming) throw new Error("Wait for the current request to finish");
					if (![path, text, version].every(v => typeof v === "string")) throw new Error("Invalid save request");
					wiki.write(cwd, path, text, version); result = await wiki.document(cwd, path); break;
				case "restore":
					if (service().quiesceInfo().quiesced || session.isStreaming) throw new Error("Wait for the current request to finish");
					if (typeof id !== "string" || typeof undo !== "boolean" || (path !== undefined && typeof path !== "string")) throw new Error("Invalid undo request");
					wiki.restore(cwd, id, undo, path); result = await wiki.state(cwd); break;
				case "prompt": {
					if (service().quiesceInfo().quiesced || session.isStreaming) throw new Error("Wait for the current request to finish");
					if (typeof text !== "string" || !text.trim() || text.length > 100000 || typeof requestId !== "string" || conversationId !== cs.conversationId) throw new Error("Invalid Wiki request");
					const before = await wiki.begin(cwd);
					if (!valid() || session.isStreaming) { wiki.cancel(cwd); throw new Error("Conversation changed"); }
					let settled = false;
					const finish = () => { if (settled) return; settled = true; off(); void wiki.finish(cwd, before, text).catch(e => console.error(`Wiki history failed: ${e.message}`)); };
					const off = session.subscribe(event => { if (event.type === "agent_settled") finish(); });
					await new Promise<void>((resolve, reject) => {
						void cs.prompt(text, undefined, false, requestId, ok => ok ? resolve() : reject(new Error("Pi rejected the request; check model configuration"))).finally(() => { finish(); resolve(); });
					});
					result = { accepted: true }; break;
				}
				default: throw new Error("Unknown Wiki action");
			}
			if (cs.switchingWorkspace || cs.cwd !== cwd || (["prompt", "write", "restore"].includes(action) && !valid())) { res.status(409).json({ error: "Workspace changed" }); return; }
			res.json(result);
		} catch (error) { res.status(400).json({ error: (error as Error).message }); }
	});
	app.get("/api/wiki-media", (req, res) => {
		try {
			if (!originAllowed(req)) { res.sendStatus(403); return; }
			const { clientId, cwd, path } = req.query;
			if (![clientId, cwd, path].every(v => typeof v === "string")) { res.sendStatus(400); return; }
			const cs = service().get(clientId as string);
			if (!cs || cs.switchingWorkspace || cs.cwd !== cwd) { res.sendStatus(409); return; }
			const absolute = wikiPath(cwd as string, path as string);
			if (!statSync(absolute).isFile()) { res.sendStatus(404); return; }
			res.setHeader("Cache-Control", "no-store");
			res.setHeader("X-Content-Type-Options", "nosniff");
			if (req.query.download === "1") res.download(absolute);
			else if ([".pdf", ".png", ".jpg", ".jpeg", ".gif", ".webp", ".avif", ".bmp", ".svg"].includes(extname(absolute).toLowerCase())) {
				res.setHeader("Content-Security-Policy", "sandbox"); res.sendFile(absolute);
			} else res.sendStatus(400);
		} catch { res.sendStatus(404); }
	});
}
