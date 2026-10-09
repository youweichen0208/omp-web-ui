import { parentPort, workerData } from "node:worker_threads";
import { getDocument } from "pdfjs-dist/legacy/build/pdf.mjs";

let task;
try {
	task = getDocument({ data: workerData.bytes, useSystemFonts: false, isEvalSupported: false, disableFontFace: true, useWorkerFetch: false, verbosity: 0 });
	const pdf = await task.promise;
	if (pdf.numPages > 200) throw new Error("PDF exceeds 200 page limit");
	const result = { pageCount: pdf.numPages };
	if (workerData.page !== undefined) {
		const page = await pdf.getPage(workerData.page);
		const content = await page.getTextContent();
		result.text = content.items.filter(item => "str" in item).map(item => `${item.str}${item.hasEOL ? "\n" : " "}`).join("").trim();
		if (result.text.length > 100000) throw new Error("PDF page exceeds 100000 extracted characters");
		page.cleanup();
	}
	parentPort.postMessage(result);
} catch (error) {
	parentPort.postMessage({ error: error.message });
} finally {
	await task?.destroy();
}
