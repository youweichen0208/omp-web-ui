import { splitCommandChain } from "./bash-steps.js";
import { compactCommandLabel } from "./bash-presentation.js";

/** Conservative display inference. Never execute or rewrite the underlying shell. */
export function commandReading(command: string, english = false): { title: string; command: string; path?: string } {
	const echo = /^\s*echo\s+(["'])===\s*(.+?)\s*===\1\s*&&\s*([\s\S]+)$/.exec(command);
	const actual = echo ? echo[3] : command;
	const first = splitCommandChain(actual)[0] ?? actual;
	const sed = /^sed\s+-n\s+['"]?(\d+),(\d+)p['"]?\s+(['"]?)([^\s'";&|<>$`]+)\3(?:\s+2>\s*\/dev\/null)?\s*$/.exec(first);
	const read = /^(?:cat|head|tail)\s+(?:-n\s+\d+\s+)?(['"]?)([^\s'";&|<>$`]+)\1(?:\s+2>\s*\/dev\/null)?\s*$/.exec(first);
	const git = /^git\s+show\s+[^\s:'"`;$&|<>]+:([^\s'"`;$&|<>]+)(?:\s+2>\s*\/dev\/null)?\s*$/.exec(first);
	const path = sed?.[4] ?? read?.[2] ?? git?.[1];
	const leaf = path?.split(/[\\/]/).at(-1);
	const title = echo?.[2].trim() || (sed ? `${leaf} ${sed[1]}–${sed[2]}${english ? " lines" : " 行"}` : leaf) || compactCommandLabel(command);
	return { title, command: actual, path };
}

export function consecutiveAttempts<T>(items: T[], title: (item: T) => string): T[][] {
	const groups: T[][] = [];
	for (const item of items) {
		const previous = groups.at(-1);
		if (previous && title(previous[0]) === title(item)) previous.push(item);
		else groups.push([item]);
	}
	return groups;
}

export function isProcessNarration(text: string): boolean {
	const value = text.trim();
	return [...value].length < 40 && !/[\n#*]|(?:完成|通过|失败|结论|发现|结果|问题是|已修复)/.test(value)
		&& /^(?:(?:我|我们)(?:会|将|要)?|接下来|下一步|然后|现在|先|再|继续|让我|I'll|I will|Next,?\s|Let me)/i.test(value)
		&& /(?:检查|查看|读取|确认|验证|修改|修复|测试|实现|更新|定位|对照|check|read|inspect|test|update|verify)/i.test(value);
}
