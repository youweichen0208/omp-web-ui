/** Plain text with safe HTTP links, including SDK OAuth authorization notices. */
export function LinkedText({ text }: { text: string }) {
	return <>{text.split(/(https?:\/\/[^\s<>]+)/g).map((part,index) => {
		try { const url = new URL(part); if (url.protocol === "https:" || url.protocol === "http:" && ["localhost","127.0.0.1","[::1]"].includes(url.hostname)) return <a key={index} href={part} target="_blank" rel="noreferrer">{part}</a>; } catch {}
		return part;
	})}</>;
}
