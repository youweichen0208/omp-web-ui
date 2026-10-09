export interface Notice {
	count?: number;
	conversationId?: string;
	id: number;
	level: "info" | "warning" | "error";
	text: string;
}

export function appendNotice(notices: Notice[], incoming: Notice): Notice[] {
	const existing = notices.findIndex(notice => notice.conversationId === incoming.conversationId
		&& notice.level === incoming.level && notice.text === incoming.text);
	if (existing >= 0) return notices.map((notice, index) => index === existing
		? { ...notice, count: (notice.count ?? 1) + 1 }
		: notice);
	return [...notices, incoming].slice(-6);
}
