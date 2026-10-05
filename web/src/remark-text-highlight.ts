import type { Root, PhrasingContent, Parent } from "mdast";

export const TEXT_HIGHLIGHT_COLORS = [
	{ name: "yellow", hex: "#fff3a3", rgb: "rgb(255, 243, 163)" },
	{ name: "green", hex: "#ccebc5", rgb: "rgb(204, 235, 197)" },
	{ name: "blue", hex: "#c8e4ff", rgb: "rgb(200, 228, 255)" },
	{ name: "pink", hex: "#ffd5e5", rgb: "rgb(255, 213, 229)" },
	{ name: "purple", hex: "#e5d5ff", rgb: "rgb(229, 213, 255)" },
] as const;

export function textHighlightColor(value: string) {
	return TEXT_HIGHLIGHT_COLORS.find(color => color.hex === value.toLowerCase() || color.rgb === value.toLowerCase());
}

/** Interpret only our exact, paired mark syntax; arbitrary HTML stays inert. */
export function remarkTextHighlight() {
	return (tree: Root) => {
		const visit = (parent: Parent) => {
			for (let i = 0; i < parent.children.length; i++) {
				const node = parent.children[i];
				if (node.type === "html") {
					const match = /^<mark style="background-color: (#[0-9a-f]{6})">$/i.exec(node.value);
					const color = match && textHighlightColor(match[1]);
					if (!color) continue;
					let end = i + 1;
					while (end < parent.children.length) {
						const candidate = parent.children[end];
						if (candidate.type === "html" && candidate.value === "</mark>") break;
						// Do not interpret nested/unbalanced HTML as a highlight.
						if (candidate.type === "html") { end = parent.children.length; break; }
						end++;
					}
					if (end === parent.children.length) continue;
					const children = parent.children.slice(i + 1, end) as PhrasingContent[];
					// A styled span lets native hiliteColor recolor/clear after reopening.
					parent.children.splice(i, end - i + 1, { type: "emphasis", children,
						data: { hName: "span", hProperties: { style: `background-color: ${color.hex}` } } });
				}
				const child = parent.children[i];
				if ("children" in child) visit(child as Parent);
			}
		};
		visit(tree);
	};
}
