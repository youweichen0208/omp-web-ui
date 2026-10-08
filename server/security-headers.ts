import type { NextFunction, Request, Response } from "express";

/**
 * Baseline response headers for every route.
 *
 * The UI can drive an agent that runs commands, so a foreign page must not be
 * able to frame it (clickjacking on confirm buttons). Same-origin framing stays
 * allowed because the Wiki previews PDFs in a same-origin iframe. X-Frame-Options
 * is set as well because /api/wiki-media replaces the Content-Security-Policy
 * header with its own `sandbox`.
 *
 * No `script-src` policy here: it needs a full pass over pdf.js, mermaid, KaTeX
 * and plugin bundles before it can be enforced without breaking features.
 */
export const SECURITY_HEADERS: Readonly<Record<string, string>> = {
	"Content-Security-Policy": "frame-ancestors 'self'",
	"X-Frame-Options": "SAMEORIGIN",
	"X-Content-Type-Options": "nosniff",
	// The first navigation may carry ?token=; never leak the URL to external links.
	"Referrer-Policy": "no-referrer",
};

export function securityHeaders(_req: Request, res: Response, next: NextFunction): void {
	for (const [name, value] of Object.entries(SECURITY_HEADERS)) res.setHeader(name, value);
	next();
}
