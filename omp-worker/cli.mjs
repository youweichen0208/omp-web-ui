import "./compat.mjs";
const { runCli } = await import("@oh-my-pi/pi-coding-agent/cli");
await runCli(process.argv.slice(2));
