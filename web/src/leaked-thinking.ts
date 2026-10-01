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

export function splitLeakedThinking(text: string): LeakedThinkingSplit | null {
	const trailing = text.match(TRAILING_TAGS_RE);
	// Only treat end-of-block tags as peelable junk when a closing tag still
	// remains before them — that's what marks the earlier text as reasoning
	// and the text between as the real reply. When they are the *only* tags,
	// `prose</think>` is an ordinary leaked-reasoning run and folds whole.
	const peelable =
		trailing != null && lastCloseEnd(text.slice(0, trailing.index)) !== -1;
	const trailingJunk = peelable ? trailing[0].trim() : "";
	const body = peelable ? text.slice(0, trailing.index) : text;

	const lastEnd = lastCloseEnd(body);
	if (lastEnd === -1) return null;

	const leaked = [body.slice(0, lastEnd).trim(), trailingJunk]
		.filter(Boolean)
		.join("\n");
	return { leaked, visible: body.slice(lastEnd).trim() };
}
