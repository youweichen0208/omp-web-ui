import { codeTool } from "./code-tools.js";
import type { CodeQuery } from "./protocol.js";
import { randomUUID } from "node:crypto";
import { boundedBashOperations } from "./bounded-bash.js";
import { nativeToolExtensions, nativeExtensionPath } from "./native-tools.js";
/** Dedicated SDK process. No host UI tools, no delegation, explicit capabilities. */
import {
	createAgentSessionServices,
	createAgentSessionFromServices,
	createBashToolDefinition,
	createLocalBashOperations,
	defineTool,
	SessionManager,
	type AgentSession,
} from "@earendil-works/pi-coding-agent";
import type { SubagentSummary, SubagentRecord } from "./protocol.js";
import { upstreamSubagent } from "./subagents.js";
const codePending = new Map<
	string,
	{ resolve: (value: unknown) => void; reject: (error: Error) => void }
>();
async function queryCode(
	query: CodeQuery,
	signal?: AbortSignal,
): Promise<unknown> {
	const requestId = randomUUID();
	return new Promise((resolve, reject) => {
		const abort = () => {
			codePending.delete(requestId);
			send({ type: "code_cancel", requestId });
			reject(new Error("Code query cancelled"));
		};
		const timer = setTimeout(abort, 30000);
		const finish = (callback: () => void) => {
			clearTimeout(timer);
			signal?.removeEventListener("abort", abort);
			callback();
		};
		codePending.set(requestId, {
			resolve: (value) => finish(() => resolve(value)),
			reject: (error) => finish(() => reject(error)),
		});
		signal?.addEventListener("abort", abort, { once: true });
		if (signal?.aborted) {
			clearTimeout(timer);
			abort();
			return;
		}
		send({ type: "code_query", requestId, query });
	});
}
let session: AgentSession | undefined;
let stopping = false;
let done = false;
let extensionFailure: string | undefined;
const send = (message: unknown) => {
	if (process.connected) process.send?.(message);
};
/** Flush the final IPC packet before exit, including large model outputs. */
const finish = (message: unknown, code: number) => {
	if (!process.connected) {
		process.exit(1);
	}
	process.send?.(message, (error) => process.exit(error ? 1 : code));
};
const record = (type: string, text: string) =>
	send({
		type: "record",
		record: {
			type,
			timestamp: Date.now(),
			text:
				text.length > 100_000
					? JSON.stringify({
							truncated: true,
							originalLength: text.length,
							preview: text.slice(0, 90_000),
						})
					: text,
		} satisfies SubagentRecord,
	});
async function start(task: SubagentSummary, agentDir: string): Promise<void> {
	try {
		const services = await createAgentSessionServices({
			cwd: task.cwd,
			agentDir,
			resourceLoaderOptions: {
				noExtensions: true,
				additionalExtensionPaths: task.role.extensions.filter(
					(path) =>
						!path.startsWith("builtin:") && !path.startsWith("<inline:"),
				),
				noPromptTemplates: true,
				appendSystemPromptOverride: (base) => [
					...base,
					task.role.prompt,
					"You are an isolated subagent. Do not delegate or use unapproved capabilities. Bash commands must be bounded; do not start persistent background services.",
				],
				skillsOverride: (res) => {
					const skills = res.skills.filter((s) =>
						task.role.skills.includes(s.name),
					);
					for (const name of task.role.skills)
						if (!skills.some((s) => s.name === name))
							throw new Error(`Requested skill unavailable: ${name}`);
					return { ...res, skills };
				},
				extensionsOverride: (res) => {
					const extensions = res.extensions.filter(
						(e) =>
							(e.path === "<inline:web-subagent-capabilities>" ||
								task.role.extensions.some(
									(path) =>
										nativeExtensionPath(path) === nativeExtensionPath(e.path),
								)) &&
							!upstreamSubagent(e.path),
					);
					for (const path of task.role.extensions)
						if (
							!extensions.some(
								(e) =>
									nativeExtensionPath(e.path) === nativeExtensionPath(path),
							)
						)
							throw new Error(
								`Requested extension unavailable or untrusted: ${path}`,
							);
					return { ...res, extensions };
				},
				extensionFactories: [
					...nativeToolExtensions()
						.filter(
							(e) =>
								typeof e !== "function" &&
								task.role.extensions.some(
									(path) => nativeExtensionPath(path) === `<inline:${e.name}>`,
								),
						)
						.map((e) =>
							typeof e === "function"
								? e
								: { ...e, builtin: false, hidden: true },
						),
					{
						name: "web-subagent-capabilities",
						hidden: true,
						factory: (pi) => {
							pi.on("before_agent_start", () => {
								pi.setActiveTools(task.role.tools);
							});
							pi.on("tool_call", (event) => {
								if (
									!task.role.tools.includes(event.toolName) ||
									/subagent|spawn_agent|delegate_agent/.test(event.toolName)
								)
									return {
										block: true,
										reason: "Tool not authorized for this role",
									};
							});
						},
					},
				],
			},
		});
		const errors = services.diagnostics.filter((d) => d.type === "error");
		if (errors.length) throw new Error(errors.map((d) => d.message).join("\n"));
		const model = (await services.modelRuntime.getAvailable()).find(
			(m) => m.provider === task.model.provider && m.id === task.model.id,
		);
		if (!model)
			throw new Error(
				`Requested model unavailable: ${task.model.provider}/${task.model.id}`,
			);
		const created = await createAgentSessionFromServices({
			services,
			sessionManager: SessionManager.inMemory(task.cwd),
			model,
			thinkingLevel: task.thinking as NonNullable<
				SubagentSummary["role"]["thinking"]
			>,
			tools: task.role.tools,
			customTools: [
				...(task.role.tools.includes("code")
					? [codeTool(task.cwd, queryCode)]
					: []),
				...(task.role.tools.includes("bash")
					? [
							defineTool(
								createBashToolDefinition(task.cwd, {
									operations: boundedBashOperations(
										createLocalBashOperations(),
									),
								}),
							),
						]
					: []),
			],
		});
		session = created.session;
		await session.bindExtensions({
			mode: "rpc",
			onError: (error) => {
				extensionFailure = error.error;
				record("extension_error", error.error);
				if (session?.isStreaming) void session.abort().catch(() => {});
			},
		});
		if (extensionFailure) throw new Error(extensionFailure);
		if (services.resourceLoader.getExtensions().errors.length)
			throw new Error(
				JSON.stringify(services.resourceLoader.getExtensions().errors),
			);
		const names = new Set(session.getAllTools().map((t) => t.name));
		for (const name of task.role.tools)
			if (!names.has(name))
				throw new Error(`Requested tool unavailable: ${name}`);
		if (
			session.model?.id !== model.id ||
			session.model.provider !== model.provider ||
			session.thinkingLevel !== task.thinking
		)
			throw new Error("Requested model or thinking level could not be applied");
		session.subscribe((event) => {
			if (event.type === "agent_end")
				record(
					"agent_end",
					"SDK loop ended; task remains active until agent_settled",
				);
			if (event.type === "message_end")
				record("message", JSON.stringify(event.message));
			if (
				event.type === "tool_execution_start" ||
				event.type === "tool_execution_end"
			)
				record(event.type, JSON.stringify(event));
			if (event.type === "agent_settled" && !done) {
				done = true;
				const assistants = session!.messages.filter(
					(m) => m.role === "assistant",
				);
				const last = assistants.at(-1);
				const result =
					last?.content
						.filter((b) => b.type === "text")
						.map((b) => b.text)
						.join("\n") ?? "";
				let tokens = 0;
				let cost: number | null =
					model.cost && Object.values(model.cost).some((value) => value !== 0)
						? 0
						: null;
				for (const m of assistants) {
					tokens += m.usage?.totalTokens ?? 0;
					if (!m.usage?.cost || !Number.isFinite(m.usage.cost.total))
						cost = null;
					else if (cost !== null) cost += m.usage.cost.total;
				}
				finish(
					{
						type: "settled",
						result,
						error:
							extensionFailure ??
							(stopping
								? "Task stopped"
								: last?.stopReason === "error" || last?.stopReason === "aborted"
									? (last.errorMessage ?? last.stopReason)
									: undefined),
						usage: { tokens, cost },
					},
					0,
				);
			}
		});
		if (stopping) {
			await session.abort();
			process.exit(0);
		}
		send({ type: "ready" });
		await session.prompt(
			task.task +
				(task.background
					? `\n\nExplicit background from parent:\n${task.background}`
					: ""),
		);
		if (!done) throw new Error("SDK returned without agent_settled");
	} catch (e) {
		if (done) return;
		done = true;
		finish({ type: "settled", result: "", error: String(e) }, 1);
	}
}
process.on("message", (raw: unknown) => {
	const msg = raw as {
		result?: unknown;
		error?: string;
		type: string;
		task: SubagentSummary;
		agentDir: string;
		requestId: string;
		text: string;
		mode: "steer" | "followUp";
	};
	if (msg.type === "code_result") {
		const pending = codePending.get(msg.requestId);
		codePending.delete(msg.requestId);
		if (pending) {
			if (msg.error) pending.reject(new Error(msg.error));
			else pending.resolve(msg.result);
		}
	}
	if (msg.type === "start") void start(msg.task, msg.agentDir);
	if (msg.type === "stop") {
		stopping = true;
		if (session)
			void session.abort().finally(() => {
				if (!done) process.exit(0);
			});
	}
	if (msg.type === "message")
		void (async () => {
			try {
				if (!session || done || stopping || !session.isStreaming)
					throw new Error("Task is no longer running");
				await (msg.mode === "steer"
					? session.steer(msg.text)
					: session.followUp(msg.text));
				record("instruction", msg.text);
				send({ type: "ack", requestId: msg.requestId });
			} catch (e) {
				send({ type: "ack", requestId: msg.requestId, error: String(e) });
			}
		})();
});
process.on("disconnect", () => {
	stopping = true;
	if (session) void session.abort().finally(() => process.exit(1));
	else process.exit(1);
	setTimeout(() => process.exit(1), 4000).unref();
});
