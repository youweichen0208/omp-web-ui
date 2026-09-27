import { expect, test } from "vitest";
import { waitingPhase } from "../../web/src/waiting-phase.js";

test("waiting copy advances at 15 and 60 seconds, then yields to the silence notice", () => {
	expect(waitingPhase(0)).toBe("analyzing");
	expect(waitingPhase(14)).toBe("analyzing");
	expect(waitingPhase(15)).toBe("thinking");
	expect(waitingPhase(59)).toBe("thinking");
	expect(waitingPhase(60)).toBe("slow");
	expect(waitingPhase(179)).toBe("slow");
	expect(waitingPhase(180)).toBe("handoff");
});
