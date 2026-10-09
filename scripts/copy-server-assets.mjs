import { cpSync, mkdirSync } from "node:fs";

// tsc copies JavaScript only. Python workers must also exist in npm/Desktop dist.
const source = new URL("../server/document-conversion/python/", import.meta.url);
const destination = new URL("../dist/server/document-conversion/python/", import.meta.url);
mkdirSync(destination, { recursive: true });
cpSync(source, destination, {
	recursive: true,
	filter: path => !/[/\\]__pycache__(?:[/\\]|$)|\.py[co]$/.test(path),
});
