/** A preview owns whole-file references. Line ranges, folders and uploads
 * remain independent of the file currently open in the editor. */
export function keepNonPreviewAttachments<T extends {
	path: string;
	mode: "inline" | "reference" | "lines";
	isDir?: boolean;
	imageData?: string;
	fileData?: string;
	nativeRef?: unknown;
}>(items: T[]): T[] {
	return items.filter((item) => item.nativeRef || item.mode === "lines" || item.isDir || item.imageData || item.fileData || !item.path);
}
