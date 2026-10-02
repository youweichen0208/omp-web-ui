import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync, renameSync, readdirSync, rmSync, realpathSync } from "node:fs";
import { join } from "node:path";
import type { ModelRuntime } from "@earendil-works/pi-coding-agent";
import type { ImageRecord, ClientMessage, ServerMessage } from "./protocol.js";

/** Service-owned jobs survive sockets and workspace changes. No credentials or bytes on lists. */
export class ImageService {
	private records = new Map<string, ImageRecord>();
	private running = new Map<string, { clientId: string; controller: AbortController }>();
	constructor(private directory: string) {
		mkdirSync(directory, { recursive: true });
		for (const id of readdirSync(directory)) {
			try {
				const record = JSON.parse(readFileSync(join(directory, id, "record.json"), "utf8")) as ImageRecord;
				if (record.status === "running") { record.status = "interrupted"; this.save(record); }
				this.records.set(record.id, record);
			} catch { /* Ignore incomplete directories; never invent a completed result. */ }
		}
	}
	private save(record: ImageRecord) {
		const dir = join(this.directory, record.id); mkdirSync(dir, { recursive: true });
		writeFileSync(join(dir, "record.tmp"), JSON.stringify(record)); renameSync(join(dir, "record.tmp"), join(dir, "record.json"));
		this.records.set(record.id, record);
	}
	file(cwd: string, id: string, index: number): string | undefined {
		const record = this.records.get(id);
		if (!record || record.cwd !== realpathSync(cwd) || !Number.isInteger(index) || !record.images[index]) return;
		return join(this.directory, id, `${index}.${record.images[index].extension}`);
	}
	async handle(clientId: string, runtime: ModelRuntime, msg: Extract<ClientMessage, { type: "image_request" }>, emit: (msg: ServerMessage) => void) {
		const reply = (partial: Omit<Extract<ServerMessage, { type: "image_result" }>, "type" | "requestId" | "cwd">) => emit({ type: "image_result", requestId: msg.requestId, cwd: msg.cwd, ...partial });
		try {
			const cwd = realpathSync(msg.cwd);
			if (msg.action === "models") { reply({ models: (await runtime.getAvailableOfType("image")).map(m => ({ id: m.id, provider: m.provider, name: m.name })) }); return; }
			if (msg.action === "list") { reply({ records: [...this.records.values()].filter(r => r.cwd === cwd).sort((a,b) => b.createdAt-a.createdAt) }); return; }
			if (msg.action !== "create") {
				const record = this.records.get(msg.id ?? ""); if (!record || record.cwd !== cwd) throw new Error("Image record not found");
				if (msg.action === "cancel") {
					const job = this.running.get(record.id); if (job && job.clientId !== clientId) throw new Error("Task belongs to another client");
					job?.controller.abort();
				} else if (msg.action === "delete") {
					if (this.running.has(record.id)) throw new Error("Cancel the running task before deleting");
					rmSync(join(this.directory, record.id), { recursive: true, force: true }); this.records.delete(record.id); reply({}); return;
				}
				reply({ record }); return;
			}
			if (this.running.size >= 4 || [...this.running.values()].some(j => j.clientId === clientId)) throw new Error("Image generation busy");
			if (!msg.prompt?.trim() || msg.prompt.length > 32000) throw new Error("Invalid prompt");
			const model = (await runtime.getAvailableOfType("image")).find(m => m.id === msg.model && m.provider === msg.provider);
			if (!model) throw new Error("Image model unavailable");
			const references = msg.references ?? [];
			if (references.length > 8 || references.some(r => !/^image\/(png|jpeg|webp|gif)$/.test(r.mimeType) || r.data.length > 8_000_000 || !/^[A-Za-z0-9+/]*={0,2}$/.test(r.data))) throw new Error("Invalid reference images");
			// Recheck after asynchronous catalog resolution, before reserving a slot.
			if (this.running.size >= 4 || [...this.running.values()].some(j => j.clientId === clientId)) throw new Error("Image generation busy");
			const controller = new AbortController();
			const record: ImageRecord = { id: randomUUID(), cwd, prompt: msg.prompt, provider: model.provider, model: model.id, status: "running", createdAt: Date.now(), images: [] };
			this.save(record); this.running.set(record.id, { clientId, controller }); reply({ record });
			void (async () => {
				try {
					const result = await runtime.generateImages(model, { input: [{ type: "text", text: record.prompt }, ...references.map(r => ({ type: "image" as const, ...r }))] }, { signal: controller.signal });
					record.usage = result.usage;
					if (controller.signal.aborted || result.stopReason === "aborted") record.status = "cancelled";
					else if (result.stopReason === "error") { record.status = "error"; record.error = result.errorMessage; }
					else {
						for (const block of result.output) if (block.type === "image") {
							const extension = ({ "image/png": "png", "image/jpeg": "jpg", "image/webp": "webp", "image/gif": "gif" } as Record<string,string>)[block.mimeType];
							if (!extension) throw new Error("Unsupported output image");
							writeFileSync(join(this.directory, record.id, `${record.images.length}.${extension}`), Buffer.from(block.data, "base64"));
							record.images.push({ mimeType: block.mimeType, extension });
						}
						record.status = record.images.length ? "done" : "error";
						if (!record.images.length) record.error = "Model returned no images";
					}
				} catch (error) { record.status = controller.signal.aborted ? "cancelled" : "error"; record.error = (error as Error).message; }
				finally {
					this.running.delete(record.id);
					try { this.save(record); } catch (error) { record.status = "error"; record.error = `Image history could not be saved: ${(error as Error).message}`; }
					reply({ record });
				}
			})();
		} catch (error) { reply({ error: (error as Error).message }); }
	}
	shutdown() { for (const job of this.running.values()) job.controller.abort(); }
}
