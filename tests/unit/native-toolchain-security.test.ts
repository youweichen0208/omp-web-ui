import { spawn } from "node:child_process";
import { once } from "node:events";
import { it, expect } from "vitest";
import { NativeCodeToolchains } from "../../server/code-native-toolchains.js";
import { mkdtemp, writeFile, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
// A small ZIP with one Unix symlink entry: extraction must reject before writing it.
function symlinkZip(name: string, target: string) {
	const filename = Buffer.from(name),
		body = Buffer.from(target);
	const local = Buffer.alloc(30);
	local.writeUInt32LE(0x04034b50);
	local.writeUInt16LE(20, 4);
	local.writeUInt32LE(body.length, 18);
	local.writeUInt32LE(body.length, 22);
	local.writeUInt16LE(filename.length, 26);
	const central = Buffer.alloc(46);
	central.writeUInt32LE(0x02014b50);
	central.writeUInt16LE(0x0314, 4);
	central.writeUInt16LE(20, 6);
	central.writeUInt32LE(body.length, 20);
	central.writeUInt32LE(body.length, 24);
	central.writeUInt16LE(filename.length, 28);
	central.writeUInt32LE((0o120777 << 16) >>> 0, 38);
	const end = Buffer.alloc(22);
	end.writeUInt32LE(0x06054b50);
	end.writeUInt16LE(1, 8);
	end.writeUInt16LE(1, 10);
	end.writeUInt32LE(central.length + filename.length, 12);
	end.writeUInt32LE(local.length + filename.length + body.length, 16);
	return Buffer.concat([local, filename, body, central, filename, end]);
}
it("rejects ZIP symlinks without creating an escaping link", async () => {
	const root = await mkdtemp(join(tmpdir(), "pi-native-zip-")),
		tools = new NativeCodeToolchains(root);
	try {
		const archive = join(root, "unsafe.zip");
		await writeFile(archive, symlinkZip("escape", "../outside"));
		await expect(
			(tools as any).unpack(archive, join(root, "output")),
		).rejects.toThrow(/Unsafe/);
		await expect(readFile(join(root, "output/escape"))).rejects.toThrow(
			/ENOENT/,
		);
	} finally {
		await tools.shutdown();
		await rm(root, { recursive: true, force: true });
	}
});
it("aborts a local tool process and its tree during service shutdown", async () => {
	const root = await mkdtemp(join(tmpdir(), "pi-native-process-")),
		tools = new NativeCodeToolchains(root);
	try {
		const job = (tools as any).run(
			process.execPath,
			["-e", "setInterval(()=>{},1000)"],
			{ timeout: 30000 },
		);
		const rejected = expect(job).rejects.toThrow(/Service stopped/);
		await tools.shutdown();
		await rejected;
		expect((tools as any).children.size).toBe(0);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});
