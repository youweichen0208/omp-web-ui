// Bun-only fixture writer: use the native version, paths, index and title slot.
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
const { cwd, messages, name } = JSON.parse(await Bun.stdin.text());
const manager = await SessionManager.open(SessionManager.createEmptySessionFile(cwd));
try {
	for (const message of messages) manager.appendMessage(message);
	if (name) await manager.setSessionName(name, "user");
	await manager.flush();
	process.stdout.write(JSON.stringify({ path: manager.getSessionFile() }));
} finally { await manager.close(); }
