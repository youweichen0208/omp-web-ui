import type { Express, Request } from "express";
import { realpathSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import type { AgentService } from "./agent-service.js";
import { sniffImageMime } from "./text-sniff.js";

/** A user save, separate from agent tools/context; only new files in the active workspace. */
export function installCodemodeImageRoutes(app: Express, service: () => AgentService, originAllowed: (req: Request) => boolean) {
	app.post("/api/codemode-image", (req, res) => {
		res.setHeader("Cache-Control", "no-store");
		if (!originAllowed(req) || !req.is("application/json")) { res.sendStatus(403); return; }
		const { clientId, cwd, dataUrl } = req.body ?? {};
		const cs = typeof clientId === "string" ? service().get(clientId) : undefined;
		if (!cs || cs.switchingWorkspace || cs.cwd !== cwd || service().quiesceInfo().quiesced) { res.status(409).json({ error: "Workspace unavailable" }); return; }
		try {
			if (typeof dataUrl !== "string" || dataUrl.length > 9 * 1024 * 1024) throw new Error("Image exceeds save limit (6 MB)");
			const match = /^data:image\/(png|jpeg|gif|webp);base64,([A-Za-z0-9+/]+={0,2})$/.exec(dataUrl);
			if (!match) throw new Error("Invalid image data");
			const buffer = Buffer.from(match[2], "base64");
			if (buffer.length > 6 * 1024 * 1024 || sniffImageMime(buffer, "") !== `image/${match[1]}`) throw new Error("Invalid image format or size");
			const path = `codemode-${randomUUID()}.${match[1] === "jpeg" ? "jpg" : match[1]}`;
			writeFileSync(join(realpathSync(cwd), path), buffer, { flag: "wx", mode: 0o600 });
			res.json({ path });
		} catch (error) { res.status(400).json({ error: (error as Error).message }); }
	});
}
