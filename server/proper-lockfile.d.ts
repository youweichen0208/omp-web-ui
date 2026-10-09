// Minimal typings for the proper-lockfile API used by auth and document jobs
// (the SDK ships the library but not its types).
declare module "proper-lockfile" {
	export interface LockOptions {
		realpath?: boolean;
		lockfilePath?: string;
		stale?: number;
		retries?: number | { retries: number; minTimeout?: number; maxTimeout?: number };
	}
	export function lock(file: string, options?: LockOptions): Promise<() => Promise<void>>;
	const lockfile: { lock: typeof lock };
	export default lockfile;
}
