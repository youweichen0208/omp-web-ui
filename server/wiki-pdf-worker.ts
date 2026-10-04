import { readFileSync } from "node:fs";
import { getDocument } from "pdfjs-dist/legacy/build/pdf.mjs";
process.once("message", async (path: string) => {
	try {
		const task = getDocument({ data: new Uint8Array(readFileSync(path)), useSystemFonts: false });
		const pdf = await task.promise, pages: string[] = [];
		try {
			if (pdf.numPages > 200) throw new Error("PDF exceeds 200 pages");
			for (let i = 1; i <= pdf.numPages; i++) {
				const page = await pdf.getPage(i), content = await page.getTextContent();
				pages.push(content.items.map(item => "str" in item ? item.str : "").join(" ").slice(0, 100000));
			}
		} finally { await task.destroy(); }
		process.send?.({ pages });
	} catch (e) { process.send?.({ error: (e as Error).message }); }
});
