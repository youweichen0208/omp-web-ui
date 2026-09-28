import { useEffect, useRef, useState } from "react";
import { Terminal, type IMarker } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import "@xterm/xterm/css/xterm.css";
import { randomUuid } from "../uuid";
import { useT } from "../i18n";
import type { ClientMessage, ServerMessage, NodeRun } from "../types";
export type NodeTab = { id: string; conversationId: string; busy: boolean; closed?: boolean; output?: string };
export function RemoteTerminal({ nodeId, tab, active, send, initialOutput, onQuote }: { nodeId: string; tab: NodeTab; active: boolean; send: (msg: ClientMessage) => boolean; initialOutput?: string; onQuote: (text: string) => void }) {
	const t = useT();
	const ref = useRef<HTMLDivElement>(null);
	const closed = useRef(tab.closed); closed.current = tab.closed;
	const [selection, setSelection] = useState("");
	const [copyError, setCopyError] = useState("");
	useEffect(() => {
		if (!ref.current) return;
		const style = getComputedStyle(ref.current);
		const term = new Terminal({ theme: { background: style.getPropertyValue("--node-terminal-bg").trim(), foreground: style.getPropertyValue("--node-terminal-fg").trim(), selectionBackground: "#645384", cursor: "#dcd8d4" }, fontFamily: '"JetBrains Mono", Consolas, monospace', fontSize: 13, scrollback: 8000, allowProposedApi: true });
		const fit = new FitAddon(); term.loadAddon(fit); term.open(ref.current);
		if (initialOutput) term.write(initialOutput);
		const marks = new Map<string, IMarker>();
		const request = (action: string, payload: Record<string, unknown> = {}) => send({ type: "node_request", action, requestId: randomUuid(), nodeId, terminalId: tab.id, conversationId: tab.conversationId, payload });
		const input = term.onData((data) => { if (!closed.current) request(data === "\x03" ? "interrupt" : "terminal_input", { data }); });
		const selectionChange = term.onSelectionChange(() => setSelection(term.getSelection().slice(0, 32000)));
		const listener = (e: globalThis.Event) => {
			const msg = (e as CustomEvent<Extract<ServerMessage, { type: "node_event" }>>).detail;
			if (msg.nodeId !== nodeId || msg.terminalId !== tab.id) return;
			if (msg.event === "terminal_output") term.write(String(msg.data?.text ?? ""));
			if (msg.event === "run") {
				const run = msg.data?.run as NodeRun;
				if (run.status === "running") term.write("", () => {
					const marker = term.registerMarker(0);
					if (marker) { marks.set(run.id, marker); const decoration = term.registerDecoration({ marker, width: 1, backgroundColor: "#9470ce" }); decoration?.onRender((el) => { el.classList.add("node-command-marker"); el.title = run.command; }); }
				});
			}
		};
		const locate = (e: globalThis.Event) => {
			const run = (e as CustomEvent<NodeRun>).detail;
			if (run.nodeId !== nodeId || run.terminalId !== tab.id) return;
			const mark = marks.get(run.id);
			if (mark && !mark.isDisposed) { term.scrollToLine(mark.line); term.selectLines(mark.line, mark.line + Math.min(8, run.output?.split("\n").length ?? 1)); }
		};
		window.addEventListener("pi-node-event", listener); window.addEventListener("pi-node-locate", locate);
		const ro = new ResizeObserver(() => { if (!ref.current?.clientWidth || !ref.current.clientHeight) return; try { fit.fit(); if (!closed.current) request("terminal_resize", { cols: term.cols, rows: term.rows }); } catch { /* hidden panel */ } }); ro.observe(ref.current);
		return () => { ro.disconnect(); input.dispose(); selectionChange.dispose(); window.removeEventListener("pi-node-event", listener); window.removeEventListener("pi-node-locate", locate); term.dispose(); };
	}, [nodeId, tab.id, tab.conversationId, send]);
	return <div className="node-terminal-wrap" style={{ display: active ? "block" : "none" }}><div ref={ref} className="node-xterm" />{selection && <div className="node-selection-menu"><button onClick={() => { onQuote(selection); setSelection(""); }}>{t("nodeSendSelection", { n: selection.split("\n").length })}</button><button onClick={() => void navigator.clipboard.writeText(selection).then(() => setCopyError(t("nodeCopied"))).catch((e) => setCopyError(String(e)))}>{t("nodeCopy")}</button>{copyError && <span role="status">{copyError}</span>}</div>}</div>;
}
