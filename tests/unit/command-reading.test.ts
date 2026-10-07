import { expect, it } from "vitest";
import { commandReading, consecutiveAttempts, isProcessNarration } from "../../web/src/command-reading.js";
it("reads literal labels and sed ranges without rewriting commands", () => {
 expect(commandReading('echo "=== 用户映射 ===" && sed -n \'1580,1620p\' backend/openai.py')).toEqual({title:"用户映射",command:"sed -n '1580,1620p' backend/openai.py",path:"backend/openai.py"});
 expect(commandReading("sed -n '1580,1620p' backend/openai.py").title).toBe("openai.py 1580–1620 行");
 expect(commandReading("echo hi && rm file").path).toBeUndefined();
 expect(commandReading("git show main:src/a.py 2>/dev/null").path).toBe("src/a.py");
});
it("only groups consecutive equal titles", () => {
 expect(consecutiveAttempts(["a", "a", "b", "a"], x=>x)).toEqual([["a","a"],["b"],["a"]]);
});
it("keeps conclusions and long paragraphs in body style", () => {
 expect(isProcessNarration("我先检查用户映射。 ")).toBe(true);
 for (const text of ["检查通过。", "我发现问题是权限检查缺失。", "## 下一步检查", "接下来检查" + "内容".repeat(30)]) expect(isProcessNarration(text)).toBe(false);
});
