import type { BashOperations } from "@earendil-works/pi-coding-agent";

export const DEFAULT_BASH_TIMEOUT_SECONDS = 120;

/** Bound one-shot commands even when the model omits timeout. */
export function boundedBashOperations(
	base: BashOperations,
	defaultTimeout = DEFAULT_BASH_TIMEOUT_SECONDS,
): BashOperations {
	return {
		exec: (command, cwd, options) => base.exec(command, cwd, {
			...options, timeout: options.timeout ?? defaultTimeout,
		}),
	};
}
