/**
 * 跨平台测试辅助：端口探测与清理。
 * 替代 macOS/Linux 专属的 lsof（Windows 上不存在，导致整批测试无法运行）。
 */
import { createConnection } from "node:net";

/** TCP 连接探测：端口有监听时 resolve(true)，否则 false。 */
export function portUp(port, host = "127.0.0.1", timeoutMs = 500) {
	return new Promise((resolve) => {
		const socket = createConnection({ port, host });
		const done = (v) => {
			socket.destroy();
			resolve(v);
		};
		const timer = setTimeout(() => done(false), timeoutMs);
		socket.once("connect", () => {
			clearTimeout(timer);
			done(true);
		});
		socket.once("error", () => {
			clearTimeout(timer);
			done(false);
		});
	});
}

/** Compatibility name: require a free port without killing unrelated processes. */
export async function freePort(port) {
	if (await portUp(port)) throw new Error(`Test port ${port} is already in use`);
}
