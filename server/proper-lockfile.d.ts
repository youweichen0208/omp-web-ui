// Minimal typings for the part of proper-lockfile that auth-file.ts uses
// (the SDK ships the library but not its types).
declare module "proper-lockfile" {
	export interface LockOptions {
		realpath?: boolean;
		stale?: number;
		retries?: number | { retries: number; minTimeout?: number; maxTimeout?: number };
	}
	export function lock(file: string, options?: LockOptions): Promise<() => Promise<void>>;
	const lockfile: { lock: typeof lock };
	export default lockfile;
}
