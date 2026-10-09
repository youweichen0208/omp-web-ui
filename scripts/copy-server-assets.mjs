import { cpSync, mkdirSync, rmSync } from "node:fs";

// tsc copies JavaScript only. Python workers must also exist in npm/Desktop dist.
const source = new URL("../server/document-conversion/python/", import.meta.url);
const destination = new URL("../dist/server/document-conversion/python/", import.meta.url);
// Prior local runs may have left bytecode in dist. Rebuild only owned assets.
rmSync(destination, { recursive: true, force: true });
mkdirSync(destination, { recursive: true });
cpSync(source, destination, {
	recursive: true,
	filter: path => !/[/\\]__pycache__(?:[/\\]|$)|\.py[co]$/.test(path),
});
