import { describe, it, expect } from "vitest";
import { encodeFrame, RpcDecoder, type Frame } from "../../server/omp/rpc.js";

describe("OMP framed transport", () => {
	it("round-trips chunked Unicode across arbitrary pipe boundaries", () => {
		const frame = { type: "prompt", message: "任务😀".repeat(180_000) };
		const received: Frame[] = [];
		const decoder = new RpcDecoder((value) => received.push(value));
		const bytes = Buffer.from(encodeFrame(frame).join(""));
		for (let i = 0; i < bytes.length; i += 7919) decoder.push(bytes.subarray(i, i + 7919));
		decoder.end();
		expect(received).toEqual([frame]);
	});
	it("rejects oversized and incomplete chunk claims", () => {
		const decoder = new RpcDecoder(() => {});
		expect(() => decoder.push(Buffer.from(JSON.stringify({ type: "rpc_chunk", chunkId: "x", index: 0, count: 1, byteLength: 100_000_000, data: "e30=" }) + "\n"))).toThrow();
		const incomplete = new RpcDecoder(() => {});
		incomplete.push(Buffer.from('{"type":'));
		expect(() => incomplete.end()).toThrow("incomplete");
	});
	it("rejects reordered chunks instead of delivering corrupted tool arguments", () => {
		const lines = encodeFrame({ type: "host_tool_call", arguments: { text: "x".repeat(2_000_000) } });
		const decoder = new RpcDecoder(() => {});
		expect(() => decoder.push(Buffer.from(lines[1]))).toThrow("zero");
	});
});
