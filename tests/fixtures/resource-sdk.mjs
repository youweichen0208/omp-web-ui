import { createAgentSession, SessionManager } from '@earendil-works/pi-coding-agent';
const sessions = [];
process.on('message', async message => {
	try {
		while (sessions.length < message.count) sessions.push((await createAgentSession({ cwd: process.env.PI_WEB_CWD, agentDir: process.env.PI_CODING_AGENT_DIR, sessionManager: SessionManager.inMemory(process.env.PI_WEB_CWD) })).session);
		process.send({ count: sessions.length });
	} catch (error) { process.send({ error: String(error) }); }
});
process.on('SIGTERM', () => { for (const session of sessions) session.dispose(); process.exit(0); });
process.send({ ready: true });
