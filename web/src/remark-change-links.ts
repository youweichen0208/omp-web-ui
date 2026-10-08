interface Node { type: string; value?: string; url?: string; children?: Node[]; }
/** Link only known changed paths in prose; code blocks and existing links stay intact. */
export function remarkChangeLinks(paths: string[]) {
	const ordered = [...new Set(paths)].filter(Boolean).sort((a, b) => b.length - a.length);
	return () => (tree: unknown) => {
		const visit = (node: Node) => {
			if (!node.children || ["link", "code", "inlineCode"].includes(node.type)) return;
			node.children = node.children.flatMap(child => {
				if ((child.type === "text" || child.type === "inlineCode") && child.value) {
					const value = child.value, nodes: Node[] = [];
					let offset = 0;
					while (offset < value.length) {
						let first = -1, matched = "";
						for (const path of ordered) {
							const index = value.indexOf(path, offset);
							if (index < 0 || (first >= 0 && index >= first)) continue;
							if (index > 0 && /[\w/.-]/.test(value[index - 1])) continue;
							if (/[\w/.-]/.test(value[index + path.length] ?? "") && value[index + path.length] !== ".") continue;
							first = index; matched = path;
						}
						if (first < 0) { nodes.push({ ...child, value: value.slice(offset) }); break; }
						if (first > offset) nodes.push({ ...child, value: value.slice(offset, first) });
						nodes.push({ type: "link", url: `#pi-change=${encodeURIComponent(matched)}`, children: [{ ...child, value: matched }] });
						offset = first + matched.length;
					}
					return nodes;
				}
				visit(child); return [child];
			});
		};
		visit(tree as Node);
	};
}
