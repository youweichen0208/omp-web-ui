import { fork } from "node:child_process";
import { statSync } from "node:fs";
const cache = new Map<string, { version: string; pages: string[] }>();
let running = 0;
export async function readWikiPdf(path: string): Promise<string[]> {
	const info = statSync(path), version = `${info.size}:${info.mtimeMs}`;
	if (cache.get(path)?.version === version) return cache.get(path)!.pages;
	if (running >= 2) throw new Error("PDF reader busy");
	running++;
	return new Promise((resolve, reject) => {
		const child = fork(new URL(import.meta.url.endsWith(".ts") ? "./wiki-pdf-worker.ts" : "./wiki-pdf-worker.js", import.meta.url), [], { stdio: ["ignore", "ignore", "ignore", "ipc"], execArgv: process.execArgv.filter(a => !a.startsWith("--watch")) });
		let finished = false;
		const finish = (error?: Error, pages?: string[]) => {
			if (finished) return; finished = true; clearTimeout(timer); child.kill("SIGKILL");
			if (error) reject(error); else {
				if (cache.size >= 16) cache.delete(cache.keys().next().value!);
				cache.set(path, { version, pages: pages! }); resolve(pages!);
			}
		};
		const timer = setTimeout(() => finish(new Error("PDF extraction timed out")), 8000);
		child.once("exit", () => { running--; finish(new Error("PDF reader stopped")); });
		child.once("error", e => finish(e));
		child.once("message", (message: { pages?: string[]; error?: string }) => finish(message.error ? new Error(message.error) : undefined, message.pages));
		child.send(path);
	});
}
