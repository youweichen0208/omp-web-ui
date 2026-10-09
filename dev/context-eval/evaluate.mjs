import { readEvidence } from "./corpus.mjs";

export function parseAnswer(raw) {
	let text = raw.trim();
	if (text.startsWith("```")) text = text.replace(/^```(?:json)?\s*\n?/, "").replace(/\n?```\s*$/, "");
	const answer = JSON.parse(text);
	if (!answer || typeof answer.answer !== "string" || !answer.answer.trim()
		|| typeof answer.insufficientEvidence !== "boolean" || !Array.isArray(answer.evidence)) {
		throw new Error("Expected JSON {answer, insufficientEvidence, evidence: [...]} with a nonempty answer");
	}
	return answer;
}

export async function evaluateAnswer(raw, question, corpus) {
	let answer;
	try { answer = parseAnswer(raw); } catch (error) {
		return { formatValid: false, evidenceChecksPassed: false, error: error.message, humanCorrectness: "ungraded" };
	}
	const evidence = [];
	for (const citation of answer.evidence) {
		try {
			if (!citation || typeof citation.quote !== "string" || !citation.quote.trim()) throw new Error("An exact nonempty source quote is required");
			if (citation.page === undefined && (citation.lineStart === undefined || citation.lineEnd === undefined)) throw new Error("A PDF page or explicit inclusive line range is required");
			const result = await readEvidence(corpus, citation);
			// Do not normalize whitespace: a true source quote must survive a byte-for-text check.
			if (!result.text.includes(citation.quote)) throw new Error("Quote does not match the cited source location");
			evidence.push({ ...citation, valid: true, sha256: result.document.sha256, location: result.location });
		} catch (error) {
			evidence.push({ ...citation, valid: false, error: error.message });
		}
	}
	const covered = question.expectedEvidence.filter((expected) => evidence.some((item) => item.valid && item.sourceId === expected.sourceId && item.path === expected.path));
	const insufficiencyMatches = answer.insufficientEvidence === (question.expectInsufficient === true);
	return {
		formatValid: true, answer: answer.answer, insufficientEvidence: answer.insufficientEvidence,
		evidenceChecksPassed: evidence.every((item) => item.valid) && covered.length === question.expectedEvidence.length && insufficiencyMatches,
		evidence, validCitations: evidence.filter((item) => item.valid).length,
		invalidCitations: evidence.filter((item) => !item.valid).length,
		expectedEvidenceCount: question.expectedEvidence.length, coveredEvidenceCount: covered.length,
		expectedFileCoverage: question.expectedEvidence.length ? covered.length / question.expectedEvidence.length : null,
		insufficiencyMatches,
		// File coverage and quote validity do not establish that a conclusion follows from them.
		humanCorrectness: "ungraded",
	};
}

export function summarize(samples) {
	const result = {};
	for (const arm of ["baseline", "openviking"]) {
		const group = samples.filter((sample) => sample.arm === arm);
		if (!group.length) continue;
		const completed = group.filter((sample) => !sample.error);
		const scores = completed.map((sample) => sample.evaluation).filter((score) => score.formatValid);
		const expected = group.reduce((sum, sample) => sum + sample.expectedEvidenceCount, 0);
		const durations = completed.map((sample) => sample.durationMs).sort((a, b) => a - b);
		const mcpCalls = group.flatMap((sample) => sample.toolCalls ?? []).filter((call) => call.name.startsWith("mcp__openviking__"));
		result[arm] = {
			questions: group.length, completed: completed.length, errors: group.length - completed.length,
			invalidFormats: completed.length - scores.length,
			evidenceChecksPassed: scores.filter((score) => score.evidenceChecksPassed).length,
			insufficiencyMismatches: scores.filter((score) => !score.insufficiencyMatches).length,
			questionsUsingMcp: group.filter((sample) => sample.toolCalls?.some((call) => call.name.startsWith("mcp__openviking__"))).length,
			mcpCalls: mcpCalls.length, successfulMcpCalls: mcpCalls.filter((call) => !call.isError && !call.blocked).length,
			validCitations: scores.reduce((sum, score) => sum + score.validCitations, 0),
			invalidCitations: scores.reduce((sum, score) => sum + score.invalidCitations, 0),
			expectedFileCoverage: expected ? scores.reduce((sum, score) => sum + score.coveredEvidenceCount, 0) / expected : null,
			medianDurationMs: durations.length ? (durations[Math.floor((durations.length - 1) / 2)] + durations[Math.floor(durations.length / 2)]) / 2 : null,
			humanCorrectness: "ungraded",
		};
	}
	return result;
}
