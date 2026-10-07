import { describe, it, expect } from "vitest";
import { activeTool, assistantPredecessors } from "../../web/src/agent-activity.js";
import { compactSearchLine, differentCommandDirectory } from "../../web/src/bash-presentation.js";
import type { UiMessage } from "../../server/protocol.js";
const a: UiMessage = {id:"a",role:"assistant",model:"x",content:[{type:"toolCall",id:"call",name:"bash"}]};
const result: UiMessage = {id:"r",role:"toolResult",toolCallId:"call",content:[]};
const b: UiMessage = {...a,id:"b",content:[]};
describe("agent steps",()=>{
	it("joins assistant steps across tool results, but not users or model changes",()=>{
		expect(assistantPredecessors([a,result,b]).get("b")).toBe("a");
		expect(assistantPredecessors([a,{id:"u",role:"user",content:[]},b]).size).toBe(0);
		expect(assistantPredecessors([a,{...b,model:"y"}]).size).toBe(0);
	});
	it("reports only unfinished tools in the current turn",()=>{
		expect(activeTool([a],new Map())?.name).toBe("bash");
		expect(activeTool([a,result],new Map())).toBeUndefined();
		expect(activeTool([a],new Map([["call",{}]]))).toBeUndefined();
		expect(activeTool([a,{id:"u",role:"user",content:[]}],new Map())).toBeUndefined();
	});
});
it("trims numbered search output only",()=>{
	expect(compactSearchLine('331:             <div className="x">')).toBe('331: <div className="x">');
	expect(compactSearchLine('file.ts:42:    return 1')).toBe('file.ts:42: return 1');
	expect(compactSearchLine('    return 1')).toBe('    return 1');
});
it("hides the current folder and shortens only the same user's home",()=>{
	const cwd='/Users/alice/projects/app';
	const args=(command:string)=>JSON.stringify({command});
	expect(differentCommandDirectory(args('ls'),cwd)).toBeNull();
	expect(differentCommandDirectory(args('cd . && ls'),cwd)).toBeNull();
	expect(differentCommandDirectory(args('cd ../docs && ls'),cwd)).toBe('~/projects/docs');
	expect(differentCommandDirectory(args('cd /Users/bob && ls'),cwd)).toBe('/Users/bob');
	expect(differentCommandDirectory(args('cd "$TARGET" && ls'),cwd)).toBeNull();
});

it("does not resurrect a missing result after a newer tool batch completes", () => {
 const next: UiMessage = { ...a, id: "retry", content: [{ type: "toolCall", id: "retry-call", name: "bash" }] };
 expect(activeTool([a, next, {...result, toolCallId: "retry-call"}], new Map())).toBeUndefined();
});
