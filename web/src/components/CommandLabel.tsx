/** Allow the command prefix to shrink before the final filename. */
export function CommandLabel({ label }: { label: string }) {
	const split = label.lastIndexOf("/") + 1;
	return <code className="command-label"><span>{label.slice(0, split)}</span><span>{label.slice(split)}</span></code>;
}
