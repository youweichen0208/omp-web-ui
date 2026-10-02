import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { ClientMessage, ServerMessage, CodeState } from "../types";
import { useT } from "../i18n";
import { randomUuid } from "../uuid";
import { codeServiceSummary } from "../code-service-status";
import { CodeServiceStatus } from "./CodeServiceStatus";
export function CodeStatusIndicator({
	cwd,
	connected,
	send,
	onSettings,
}: {
	cwd: string;
	connected: boolean;
	send: (msg: ClientMessage) => boolean;
	onSettings: () => void;
}) {
	const t = useT();
	const [state, setState] = useState<CodeState>();
	const [error, setError] = useState("");
	const [open, setOpen] = useState(false);
	const [position, setPosition] = useState({
		left: 12,
		bottom: 40,
		maxHeight: 400,
	});
	const button = useRef<HTMLButtonElement>(null),
		popup = useRef<HTMLDivElement>(null),
		close = useRef<HTMLButtonElement>(null);
	useEffect(() => {
		setState(undefined);
		setError("");
		setOpen(false);
		if (!connected || !cwd) return;
		let pending: string | undefined;
		const receive = (event: Event) => {
			const msg = (
				event as CustomEvent<
					Extract<ServerMessage, { type: "code_state" | "code_result" }>
				>
			).detail;
			if (msg.cwd !== cwd) return;
			if (msg.type === "code_result" && msg.requestId === pending) {
				pending = undefined;
				setError(msg.error ?? "");
			}
			if (msg.state) {
				setState(msg.state);
				setError("");
			}
		};
		const refresh = () => {
			if (document.visibilityState === "hidden") return;
			pending = randomUuid();
			if (
				!send({
					type: "code_request",
					action: "state",
					cwd,
					requestId: pending,
				})
			) {
				pending = undefined;
				setError(t("imageDisconnected"));
			}
		};
		window.addEventListener("pi-code-event", receive);
		document.addEventListener("visibilitychange", refresh);
		refresh();
		const timer = setInterval(refresh, 15000);
		return () => {
			clearInterval(timer);
			document.removeEventListener("visibilitychange", refresh);
			window.removeEventListener("pi-code-event", receive);
		};
	}, [cwd, connected, send]);
	useEffect(() => {
		if (!open) return;
		const positionPopup = () => {
			const rect = button.current?.getBoundingClientRect();
			if (rect)
				setPosition({
					left: Math.max(
						12,
						Math.min(
							rect.left,
							window.innerWidth - Math.min(380, window.innerWidth - 24) - 12,
						),
					),
					bottom: Math.max(12, window.innerHeight - rect.top + 8),
					maxHeight: Math.max(120, rect.top - 24),
				});
		};
		const dismiss = (event: PointerEvent) => {
			if (
				!popup.current?.contains(event.target as Node) &&
				!button.current?.contains(event.target as Node)
			)
				setOpen(false);
		};
		const keyboard = (event: KeyboardEvent) => {
			if (event.key === "Escape") {
				event.preventDefault();
				setOpen(false);
				button.current?.focus();
			}
		};
		positionPopup();
		close.current?.focus();
		window.addEventListener("resize", positionPopup);
		document.addEventListener("pointerdown", dismiss);
		document.addEventListener("keydown", keyboard);
		return () => {
			window.removeEventListener("resize", positionPopup);
			document.removeEventListener("pointerdown", dismiss);
			document.removeEventListener("keydown", keyboard);
		};
	}, [open]);
	const summary = codeServiceSummary(connected, state);
	const labels = {
		offline: "codeLspOffline",
		loading: "codeLspLoading",
		disabled: "codeLspDisabled",
		attention: "codeLspAttention",
		starting: "codeLspStarting",
		ready: "codeLspSummaryReady",
		standby: "codeLspStandby",
	} as const;
	return (
		<>
			<button
				ref={button}
				type="button"
				className={`code-status-indicator ${summary.kind}`}
				aria-label={t("codeLspStatus")}
				aria-expanded={open}
				onClick={() => setOpen(!open)}
				title={t("codeLspStatus")}
			>
				<i className="code-service-dot" aria-hidden="true" />
				<span aria-live="polite">
					LSP · {t(labels[summary.kind], { n: summary.ready })}
				</span>
			</button>
			{open &&
				createPortal(
					<div
						ref={popup}
						className="code-status-popup"
						role="dialog"
						aria-label={t("codeLspServers")}
						style={position}
					>
						<div className="code-actions">
							<strong>{t("codeLspServers")}</strong>
							<button
								ref={close}
								type="button"
								aria-label={t("close")}
								onClick={() => {
									setOpen(false);
									button.current?.focus();
								}}
							>
								×
							</button>
						</div>
						{!connected ? (
							<p>{t("codeLspOfflineHint")}</p>
						) : error ? (
							<p role="alert">{error}</p>
						) : state ? (
							<CodeServiceStatus state={state} />
						) : (
							<p>{t("codeLspLoading")}</p>
						)}
						<button
							type="button"
							className="code-status-settings"
							onClick={() => {
								setOpen(false);
								onSettings();
							}}
						>
							{t("codeLspOpenSettings")}
						</button>
					</div>,
					document.body,
				)}
		</>
	);
}
