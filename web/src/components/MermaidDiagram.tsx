import { useEffect, useId, useRef, useState } from "react";
import { useT } from "../i18n";
import { CopyButton } from "./copy-button";

/** Lazily-loaded, memoized mermaid module — most chats never hit a mermaid
 *  fence, so this stays out of the main bundle until one actually renders. */
let mermaidPromise: Promise<typeof import("mermaid")["default"]> | null = null;
function loadMermaid() {
	if (!mermaidPromise) {
		mermaidPromise = import("mermaid").then((mod) => {
			const mermaid = mod.default;

			return mermaid;
		});
	}
	return mermaidPromise;
}

let renderSeq = 0;
let renderQueue: Promise<unknown> = Promise.resolve();
function renderDiagram(id: string, code: string) {
	const job = renderQueue.then(async () => {
		const mermaid = await loadMermaid();
		const styles = getComputedStyle(document.documentElement);
		const canvas = document.createElement("canvas"); canvas.width = canvas.height = 1;
		const context = canvas.getContext("2d")!;
		const color = (token: string) => {
			context.clearRect(0, 0, 1, 1); context.fillStyle = styles.getPropertyValue(token).trim(); context.fillRect(0, 0, 1, 1);
			const [r, g, b] = context.getImageData(0, 0, 1, 1).data;
			return `rgb(${r}, ${g}, ${b})`;
		};
		mermaid.initialize({ startOnLoad: false, securityLevel: "strict", theme: "base", themeVariables: {
			background: color("--bg-elev"), primaryColor: color("--accent-soft"), primaryBorderColor: color("--accent"),
			primaryTextColor: color("--text"), textColor: color("--text"), lineColor: color("--text-dim"),
			secondaryColor: color("--bg-elev2"), tertiaryColor: color("--bg"), fontFamily: styles.getPropertyValue("--mono").trim(),
		} });
		return mermaid.render(id, code);
	});
	renderQueue = job.catch(() => {});
	return job;
}

/** Renders a ```mermaid fenced block as an SVG diagram (flowcharts, sequence
 *  diagrams, etc. — see docs/AI_Investment_OS_SYSTEM_DESIGN.md for examples).
 *  Falls back to the raw source in a codeblock if mermaid can't parse it, so
 *  a typo never blanks out the rest of the document. */
export function MermaidDiagram({ code }: { code: string }) {
	const t = useT();
	const reactId = useId().replace(/[^a-zA-Z0-9]/g, "");
	const [svg, setSvg] = useState<string | null>(null);
	const [error, setError] = useState<string | null>(null);
	const containerRef = useRef<HTMLDivElement>(null);
	const [appearance, setAppearance] = useState(document.documentElement.dataset.appearance);
	useEffect(() => {
		const observer = new MutationObserver(() => setAppearance(document.documentElement.dataset.appearance));
		observer.observe(document.documentElement, { attributes: true, attributeFilter: ["data-appearance"] });
		return () => observer.disconnect();
	}, []);

	useEffect(() => {
		let cancelled = false;
		setSvg(null);
		setError(null);
		const renderId = `mermaid-${reactId}-${++renderSeq}`;
		renderDiagram(renderId, code)
			.then(({ svg }) => {
				if (!cancelled) setSvg(svg);
			})
			.catch((err: unknown) => {
				if (!cancelled) {
					setError(err instanceof Error ? err.message : String(err));
				}
				// mermaid sometimes leaves a detached error node behind in the DOM
				// on parse failure; nothing in our tree references it so it's inert,
				// but clean up the offscreen render target just in case.
				document.getElementById(renderId)?.remove();
			});
		return () => {
			cancelled = true;
		};
	}, [code, reactId, appearance]);

	if (error) {
		return (
			<div className="mermaid-block mermaid-block-error">
				<div className="mermaid-error-note">{t("mermaidRenderFailed")}</div>
				<div className="codeblock">
					<CopyButton text={code} />
					<pre>
						<code>{code}</code>
					</pre>
				</div>
			</div>
		);
	}

	if (!svg) {
		return (
			<div className="mermaid-block mermaid-block-loading">
				<div className="mermaid-loading-note">{t("mermaidRendering")}</div>
			</div>
		);
	}

	return (
		<div className="mermaid-block">
			<CopyButton text={code} />
			{/* mermaid.render() output is inert markup we generated locally
			 *  (securityLevel: "strict" also has mermaid itself sanitize it). */}
			<div
				ref={containerRef}
				className="mermaid-svg"
				// eslint-disable-next-line react/no-danger
				dangerouslySetInnerHTML={{ __html: svg }}
			/>
		</div>
	);
}
