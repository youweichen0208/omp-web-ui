import { parentPort } from "node:worker_threads";
import { isDeepStrictEqual } from "node:util";

// Large JSON records are parsed and compared away from the server event loop.
let record: unknown;
parentPort!.on("message", (request: { text: string } | { native: unknown }) => {
	try {
		if ("text" in request) {
			record = JSON.parse(request.text);
			parentPort!.postMessage({ id: (record as { id?: unknown } | null)?.id });
		} else {
			const equal = request.native !== undefined && isDeepStrictEqual(JSON.parse(JSON.stringify(request.native)), record);
			record = undefined;
			parentPort!.postMessage({ equal });
		}
	} catch { record = undefined; parentPort!.postMessage({ error: true }); }
});
