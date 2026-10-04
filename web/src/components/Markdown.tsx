import { memo } from "react";
import ReactMarkdown from "react-markdown";
import type { Components } from "react-markdown";
import type { PluggableList } from "unified";
import remarkGfm from "remark-gfm";
import { remarkHighlightBlock } from "../remark-highlight-block";
import rehypeHighlight from "rehype-highlight";
import { remarkCjkAutolink } from "../remark-cjk-autolink";
import { CopyButton } from "./copy-button";
import { MermaidDiagram } from "./MermaidDiagram";

interface MarkdownProps {
	text: string;
	imageSrc?: (source: string) => string;
	/** Source positions let the file preview quote rendered text with Markdown syntax. */
	sourceLines?: boolean;
	/** Interpret local file references in user-pasted text. */
	fileLinks?: boolean;
}

/** Shared markdown pipeline + codeblock chrome (copy button). Exported so
 *  StreamMarkdown's per-segment renderers reuse the exact same configuration
 *  as this full-document renderer — streaming preview and final render must
 *  be visually identical. */
// remarkCjkAutolink 必须排在 remarkGfm 后面：它修的正是 gfm 自动链接把中文
// 标点吞进 URL 的结果。
export const remarkPlugins = [remarkGfm, remarkCjkAutolink, remarkHighlightBlock];
export const rehypePlugins: PluggableList = [
	[rehypeHighlight, { detect: true, ignoreMissing: true }],
];

const sourceLineComponents: Components = {
	p: ({ node, ...props }) => <p {...props} data-source-start={node?.position?.start.line} data-source-end={node?.position?.end.line} />,
	li: ({ node, ...props }) => <li {...props} data-source-start={node?.position?.start.line} data-source-end={node?.position?.end.line} />,
	h1: ({ node, ...props }) => <h1 {...props} data-source-start={node?.position?.start.line} data-source-end={node?.position?.end.line} />,
	h2: ({ node, ...props }) => <h2 {...props} data-source-start={node?.position?.start.line} data-source-end={node?.position?.end.line} />,
	h3: ({ node, ...props }) => <h3 {...props} data-source-start={node?.position?.start.line} data-source-end={node?.position?.end.line} />,
	h4: ({ node, ...props }) => <h4 {...props} data-source-start={node?.position?.start.line} data-source-end={node?.position?.end.line} />,
	h5: ({ node, ...props }) => <h5 {...props} data-source-start={node?.position?.start.line} data-source-end={node?.position?.end.line} />,
	h6: ({ node, ...props }) => <h6 {...props} data-source-start={node?.position?.start.line} data-source-end={node?.position?.end.line} />,
};

export function MarkdownBody({ text, imageSrc, sourceLines, fileLinks }: MarkdownProps) {
	return (
		<ReactMarkdown remarkPlugins={remarkPlugins} rehypePlugins={rehypePlugins} components={{ pre: ({ children, ...props }) => <PreWithCopy {...props} fileLinks={fileLinks}>{children}</PreWithCopy>, ...(fileLinks ? { a: ({ node: _node, href, ...props }) => <a {...props} href={href} onClick={(event) => { if (href?.startsWith("#pi-file=")) { event.preventDefault(); openLocalFile(href.slice(9)); } }} /> } : {}), ...(sourceLines ? sourceLineComponents : {}), ...(imageSrc ? { img: ({ node: _node, src, ...props }) => <img {...props} src={imageSrc(src ?? "")} /> } : {}) }}>
			{text}
		</ReactMarkdown>
	);
}

/** GFM markdown with syntax highlighting; code blocks get a copy button. */
export const Markdown = memo(function Markdown({ text, imageSrc, sourceLines, fileLinks }: MarkdownProps) {
	return (
		<div className="md">
			<MarkdownBody text={text} imageSrc={imageSrc} sourceLines={sourceLines} fileLinks={fileLinks} />
		</div>
	);
});

export function PreWithCopy({ children, fileLinks, showLanguage, ...props }: JSX.IntrinsicElements["pre"] & { fileLinks?: boolean; showLanguage?: boolean }) {
	if (isMermaidCodeBlock(children)) {
		return <MermaidDiagram code={codeText(children)} />;
	}
	const asciiTable = fileLinks && isAsciiTableCodeBlock(children);
	const code = codeText(children);
	const child = Array.isArray(children) ? children[0] : children;
	const language = child && typeof child === "object" && "props" in child ? /language-([\w+-]+)/.exec(String(child.props.className ?? ""))?.[1] : undefined;
	return (
		<div className={`codeblock${asciiTable ? " ascii-table" : ""}`}>
			{showLanguage ? <div className="codeblock-heading"><span>{language}</span><CopyButton text={code} label /></div> : <CopyButton text={code} />}
			<pre {...props}>{asciiTable ? <code>{linkedFilePaths(code)}</code> : children}</pre>
		</div>
	);
}

function isAsciiTableCodeBlock(children: unknown): boolean {
	const child = Array.isArray(children) ? children[0] : children;
	return !!child && typeof child === "object" && "props" in child &&
		/(^|\s)language-ascii-table(\s|$)/.test(String((child as { props?: { className?: unknown } }).props?.className ?? ""));
}

function openLocalFile(reference: string): void {
	const match = /^(.+):([1-9]\d*)$/.exec(reference);
	if (!match) return;
	try {
		window.dispatchEvent(new CustomEvent("pi-web-ui:open-tool-file", { detail: { path: decodeURIComponent(match[1]), line: Number(match[2]) } }));
	} catch { /* Ignore malformed links pasted into a message. */ }
}

function linkedFilePaths(code: string) {
	const pattern = /((?:[\w.-]+\/)+[\w.-]+\.[A-Za-z0-9]+):([1-9]\d*)/g;
	const parts: (string | JSX.Element)[] = [];
	let offset = 0;
	for (const match of code.matchAll(pattern)) {
		const start = match.index;
		if (start > offset) parts.push(code.slice(offset, start));
		const reference = `${match[1]}:${match[2]}`;
		parts.push(<a key={start} href={`#pi-file=${encodeURIComponent(match[1])}:${match[2]}`} onClick={(event) => { event.preventDefault(); openLocalFile(`${encodeURIComponent(match[1])}:${match[2]}`); }}>{reference}</a>);
		offset = start + match[0].length;
	}
	if (offset < code.length) parts.push(code.slice(offset));
	return parts;
}

/** True when `children` is the single ```mermaid fenced-code element that
 *  react-markdown/rehype-highlight hand to a <pre>'s children. */
function isMermaidCodeBlock(children: unknown): boolean {
	const child = Array.isArray(children) ? children[0] : children;
	if (!child || typeof child !== "object" || !("props" in child)) return false;
	const className = (child as { props?: { className?: unknown } }).props?.className;
	return typeof className === "string" && /(^|\s)language-mermaid(\s|$)/.test(className);
}

function codeText(children: unknown): string {
	if (typeof children === "string") return children;
	if (Array.isArray(children)) return children.map(codeText).join("");
	if (children && typeof children === "object" && "props" in children) {
		const props = (children as { props?: { children?: unknown } }).props;
		return codeText(props?.children);
	}
	return "";
}
