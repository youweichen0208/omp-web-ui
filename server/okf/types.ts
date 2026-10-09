import type { DocumentOrigin, DocumentBlock } from "../document-bundle.js";
import type { SourceDependency } from "./markdown-sources.js";

export interface EvidenceInput {
	sourceId: string;
	sourceHash: string;
	blockId: string;
	quote: string;
}

export interface CandidateInput {
	id?: string;
	conceptId: string;
	title: string;
	type: string;
	statement: string;
	scope?: string;
	basis?: "fact" | "inference" | "hypothesis" | "outdated";
	section?: "symptom" | "conditions" | "cause" | "validation" | "solution" | "workaround" | "limitations" | "unconfirmed" | "knowledge";
	staleAfter?: string;
	evidence: EvidenceInput[];
	review: {
		support: "supported" | "uncertain" | "unsupported";
		rationale: string;
		comparedConceptIds: string[];
		conflicts: string[];
	};
}

export type EvidenceBlock = DocumentBlock;

export interface SourceVersion {
	hash: string;
	documentHash: string;
	dependencies: SourceDependency[];
	originalPath: string;
	originalName: string;
	bundlePath?: string;
	provenance?: DocumentOrigin;
	bytes: number;
	createdAt: string;
	state: "pending" | "complete" | "partial" | "failed";
	markdownPath?: string;
	normalizedFiles?: Record<string, string>;
	blocksPath?: string;
	blocksHash?: string;
	parserVersion?: string;
	warnings: string[];
	error?: string;
}

export interface KnowledgeSource {
	id: string;
	inputPath: string;
	latestHash: string;
	state: "current" | "missing" | "changed";
	versions: Record<string, SourceVersion>;
}

export interface StoredCandidate extends CandidateInput {
	id: string;
	ownerSourceId: string;
	producer: string;
	submittedAt: string;
}

export interface KnowledgeConcept {
	id: string;
	title: string;
	type: string;
	status: "stable" | "draft";
	claims: StoredCandidate[];
	fileHash: string;
	updatedAt: string;
	producer: string;
	reasons: string[];
	verified?: Array<{ by: string; at: string; notes: string }>;
}

export interface KnowledgeManifest {
	kind: "pi-harness-knowledge";
	version: 1;
	evidenceDirectory: "evidence";
	sources: Record<string, KnowledgeSource>;
	concepts: Record<string, KnowledgeConcept>;
	managedFiles: Record<string, string>;
	proposals: Record<string, { title: string; conceptId: string; jobId: string }>;
	completedJobs: Record<string, NonNullable<IngestionJob["published"]>>;
	updatedAt: string;
	latestJobId?: string;
}

export interface IngestionJob {
	version: 1;
	id: string;
	cwd: string;
	outputDirectory: string;
	createdAt: string;
	updatedAt: string;
	state: "normalizing" | "reviewing" | "published";
	inputPaths: string[];
	sources: Array<{ sourceId: string; hash: string; state: "pending" | "complete" | "partial" | "failed"; reviewed: boolean; error?: string }>;
	candidates: StoredCandidate[];
	baseConceptHashes: Record<string, string>;
	warnings: string[];
	published?: { stable: string[]; draft: string[]; protected: string[]; proposals: string[]; reportPath: string; indexPath: string };
}
