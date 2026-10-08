/**
 * Defensive rendering guard for reasoning models that occasionally emit raw
 * `<think>`/`<thinking>` reasoning tags on the normal text channel instead
 * of the SDK's dedicated `thinking` channel (a model/provider output
 * glitch, not something this app or the pi SDK can parse away upstream —
 * from here it's indistinguishable from ordinary text until it shows up
 * literally in a reply). Different reasoning models/providers spell the tag
 * differently (`</think>` vs `</thinking>` vs Kimi-style `</antThinking>`
 * all observed in practice), so all variants are matched.
 *
 * Everything up to and including the *last* closing tag is treated as
 * leaked reasoning noise and tucked behind a collapsed toggle; whatever
 * follows it is the model's actual answer and renders normally. Two
 * wrinkles the naive "cut at the last closing tag" rule got wrong:
 *
 *   - Orphan tags often trail the *very end* of a block, after the real
 *     reply (`…</think> 真正的回复 </antThinking></think>`). Cutting at the
 *     last tag there would fold the reply itself away, so trailing
 *     tag-only junk is peeled off first and the cut happens in what's left.
 *   - This intentionally does not pair up open/close tags — the observed
 *     failure mode is orphaned/duplicated closing tags with no matching
 *     opener, so a pairing parser would just miss them.
 */
export interface LeakedThinkingSplit {
	/** Leaked reasoning: text up to the last closing tag, plus trailing tag junk. */
	leaked: string;
	/** The model's actual reply, if any. */
	visible: string;
}

const CLOSE_TAG_RE = /<\/(?:ant)?think(?:ing)?>/gi;
/** One or more stray tags (either direction) hugging the end of the block. */
const TRAILING_TAGS_RE = /(?:\s*<\/?(?:ant)?think(?:ing)?>\s*)+$/i;

function lastCloseEnd(s: string): number {
	let end = -1;
	for (const m of s.matchAll(CLOSE_TAG_RE)) end = m.index + m[0].length;
	return end;
}

import { maskMarkdownCode } from "../../server/tool-text.js";
export { maskMarkdownCode };

// Only a trailing closing sequence with an explicit DSML marker qualifies.
// Ordinary XML such as </invoke>, and tags being discussed in prose, stay intact.
const DSML_TAIL_RE = /(?:\s*<\/(?:[｜|]DSML[｜|])?(?:parameter|invoke|tool_calls)>)+\s*$/i;
const THINK_TAG_RE = /<\/?(?:ant)?think(?:ing)?>/gi;

export function splitLeakedThinking(text: string): LeakedThinkingSplit | null {
	let masked = maskMarkdownCode(text);
	const dsml = masked.match(DSML_TAIL_RE);
	const hasDsmlTail = !!dsml && /[｜|]DSML[｜|]/i.test(dsml[0]);
	if (hasDsmlTail) {
		text = text.slice(0, dsml.index).trimEnd();
		masked = masked.slice(0, dsml.index).trimEnd();
	}
	const trailing = masked.match(TRAILING_TAGS_RE);
	const peelable = trailing != null && lastCloseEnd(masked.slice(0, trailing.index)) !== -1;
	const trailingJunk = peelable ? text.slice(trailing.index).trim() : "";
	const body = peelable ? text.slice(0, trailing.index) : text;
	const lastEnd = lastCloseEnd(peelable ? masked.slice(0, trailing.index) : masked);
	if (lastEnd === -1) return hasDsmlTail ? { leaked: "", visible: text.trim() } : null;

	const leaked = [body.slice(0, lastEnd).trim(), trailingJunk].filter(Boolean).join("\n");
	// Empty delimiter fragments must not create an "Additional model content" row.
	const hasContent = maskMarkdownCode(leaked).replace(THINK_TAG_RE, "").trim().length > 0;
	return { leaked: hasContent ? leaked : "", visible: body.slice(lastEnd).trim() };
}
