import type { AgentSession } from "./omp/index.js";
import { encodePrompt, type AttachmentAside } from "./omp/prompt-content.js";

export async function deliverPrompt(session: AgentSession, text: string, asides: AttachmentAside[], queue: boolean, acknowledge: (ok: boolean) => void): Promise<void> {
	const payload = encodePrompt(text, asides);
	try {
		const accepted = await session.prompt(payload.message, { images: payload.images, thumbnails: payload.thumbnails, streamingBehavior: queue ? "followUp" : "steer" });
		acknowledge(accepted);
	} catch (error) { acknowledge(false); throw error; }
}
