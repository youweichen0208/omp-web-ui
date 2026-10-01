import { plugin } from "bun";

// OMP 18.4.5 ships both prelude.ts (module) and prelude.js (text asset).
// Its extensionless SDK import resolves to the asset under Bun 1.4.2. Keep
// the correction local to this worker; never rewrite the installed package.
plugin({ name: "omp-18.4.5-ratchet-module", setup(builder) {
	// PI_CONFIG_DIR may be absolute on another Windows drive. Upstream join()
	// prefixes the home drive; resolve() preserves both relative and absolute roots.
	builder.onLoad({ filter: /pi-utils[\\/]src[\\/]dirs\.ts$/ }, async args => {
		return { contents: (await Bun.file(args.path).text()).replace("return path.join(os.homedir(), getConfigDirName());", "return path.resolve(os.homedir(), getConfigDirName());"), loader: "ts" };
	});
	builder.onLoad({ filter: /pi-coding-agent[\\/]src[\\/]sdk\.ts$/ }, async args => {
		return { contents: (await Bun.file(args.path).text()).replace('from "./ratchet/prelude"', 'from "./ratchet/prelude.ts"'), loader: "ts" };
	});
} });
