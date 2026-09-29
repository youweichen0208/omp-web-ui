// Exercise native session semantics in CI without requiring a browser download.
process.argv.push("--protocol-only");
await import("./new-chat-context-test.mjs");
