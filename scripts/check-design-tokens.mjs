import { readFileSync, readdirSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import postcss from "postcss";
import ts from "typescript";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const hexColor = /(?<![\w&])#(?:[\da-f]{8}|[\da-f]{6}|[\da-f]{4}|[\da-f]{3})\b/gi;
const rootPalette = /^:root(?:\[data-appearance=(?:"dark"|'dark'|dark)\])?$/;
const contentPalette = /^(?:--file-code-|--wiki-code-)/;
const colorNames = new Set(`aliceblue antiquewhite aqua aquamarine azure beige bisque black blanchedalmond blue blueviolet brown burlywood cadetblue chartreuse chocolate coral cornflowerblue cornsilk crimson cyan darkblue darkcyan darkgoldenrod darkgray darkgreen darkgrey darkkhaki darkmagenta darkolivegreen darkorange darkorchid darkred darksalmon darkseagreen darkslateblue darkslategray darkslategrey darkturquoise darkviolet deeppink deepskyblue dimgray dimgrey dodgerblue firebrick floralwhite forestgreen fuchsia gainsboro ghostwhite gold goldenrod gray green greenyellow grey honeydew hotpink indianred indigo ivory khaki lavender lavenderblush lawngreen lemonchiffon lightblue lightcoral lightcyan lightgoldenrodyellow lightgray lightgreen lightgrey lightpink lightsalmon lightseagreen lightskyblue lightslategray lightslategrey lightsteelblue lightyellow lime limegreen linen magenta maroon mediumaquamarine mediumblue mediumorchid mediumpurple mediumseagreen mediumslateblue mediumspringgreen mediumturquoise mediumvioletred midnightblue mintcream mistyrose moccasin navajowhite navy oldlace olive olivedrab orange orangered orchid palegoldenrod palegreen paleturquoise palevioletred papayawhip peachpuff peru pink plum powderblue purple rebeccapurple red rosybrown royalblue saddlebrown salmon sandybrown seagreen seashell sienna silver skyblue slateblue slategray slategrey snow springgreen steelblue tan teal thistle tomato turquoise violet wheat white whitesmoke yellow yellowgreen`.split(" "));
const colorProperty = /^(?:--[\w-]+|(?:background|border|outline|text-decoration|column-rule)(?:-[\w-]+)?|(?:box|text)-shadow|(?:caret|accent|stop|flood|lighting)-color|color|fill|stroke|fill-style|stroke-style)$/;

function literalColors(value, named = true) {
	// Skip comments, quoted CSS content and URLs; variable names remain whole tokens.
	value = value.replace(/\/\*[\s\S]*?\*\/|"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|url\((?:\\.|[^)])*\)/gi, "");
	const colors = [...value.matchAll(hexColor)].map(match => match[0]);
	for (const match of value.matchAll(/\b(?:rgba?|hsla?)\([^)]*\)/gi)) colors.push(match[0]);
	if (named) for (const match of value.matchAll(/[-a-z_][\w-]*/gi)) {
		if (colorNames.has(match[0].toLowerCase())) colors.push(match[0]);
	}
	for (const match of value.matchAll(/oklch\(\s*([\d.%]+)\s+([\d.]+%?)\s+([+-]?[\d.]+)(deg|grad|rad|turn)?(?:\s*\/[^)]*)?\s*\)/gi)) {
		const chroma = Number.parseFloat(match[2]);
		const unit = match[4]?.toLowerCase();
		const degrees = Number(match[3]) * (unit === "turn" ? 360 : unit === "rad" ? 180 / Math.PI : unit === "grad" ? 0.9 : 1);
		const hue = ((degrees % 360) + 360) % 360;
		if (chroma > 0 && hue >= 260 && hue < 320) colors.push(match[0]);
	}
	return colors;
}

function allowedPalette(decl) {
	const rule = decl.parent;
	if (rule.type !== "rule") return false;
	if (rootPalette.test(rule.selector) && decl.prop.startsWith("--")) return true;
	if (contentPalette.test(decl.prop) && rule.selectors.every(selector => /(?:^|\s)\.(?:fp-embedded|wiki-prose)(?:\[data-code-theme="(?:dark|system)"\])?$/.test(selector))) return true;
	if (decl.prop === "--highlight-color" && /^\.fp-highlight-(?:yellow|green|blue|pink|purple)$/.test(rule.selector)) return true;
	if (decl.prop === "color" && rule.selectors.every(selector => /^\.fp-markdown \.hljs-[\w-]+$/.test(selector) || /^\.fp-rich-document pre > code::highlight\(rich-code-[\w-]+\)$/.test(selector))) return true;
	return decl.prop === "background" && rule.selector === ".desktop-window-controls .desktop-window-close:hover";
}

function validRadius(value) {
	return /^(?:var\(--r-(?:sm|md|lg|switch|waiting|wiki-grid|wiki-code|diff-word|scrollbar)\)|50%|0|inherit)(?:[\s/]+(?:var\(--r-(?:sm|md|lg|switch|waiting|wiki-grid|wiki-code|diff-word|scrollbar)\)|50%|0))*$/.test(value.trim());
}

export function checkCss(source, file = "styles.css") {
	const issues = [];
	postcss.parse(source, { from: file }).walkDecls(decl => {
		const report = (severity, message) => issues.push({ file, line: decl.source.start.line, severity, message });
		if (!allowedPalette(decl)) {
			for (const color of literalColors(decl.value, colorProperty.test(decl.prop))) report("error", `Use a design token instead of ${color} (${decl.prop}).`);
		}
		if (/^border(?:-(?:top|bottom)-(?:left|right))?-radius$/.test(decl.prop) && !validRadius(decl.value)) {
			report("error", `Non-token radius: ${decl.value}. Use a documented --r-* token, 50%, 0 or inherit.`);
		}
	});
	return issues;
}

function scriptProperty(node) {
	const parent = node.parent;
	if (ts.isPropertyAssignment(parent) || ts.isJsxAttribute(parent) || ts.isVariableDeclaration(parent)) return parent.name.getText().replace(/["']/g, "");
	if (ts.isBinaryExpression(parent) && parent.operatorToken.kind === ts.SyntaxKind.EqualsToken) {
		if (ts.isPropertyAccessExpression(parent.left)) return parent.left.name.text;
		if (ts.isElementAccessExpression(parent.left) && ts.isStringLiteralLike(parent.left.argumentExpression)) return parent.left.argumentExpression.text;
	}
	if (ts.isCallExpression(parent) && ts.isPropertyAccessExpression(parent.expression) && parent.expression.name.text === "setProperty" && parent.arguments[1] === node && ts.isStringLiteralLike(parent.arguments[0])) return parent.arguments[0].text;
	if (ts.isJsxExpression(parent) || ts.isConditionalExpression(parent) || ts.isParenthesizedExpression(parent) || ts.isTemplateExpression(parent) || ts.isTemplateSpan(parent)) return scriptProperty(parent);
	return "";
}

function contentColor(node, file) {
	const path = file.replaceAll("\\", "/");
	for (let parent = node.parent; parent; parent = parent.parent) {
		if (!ts.isVariableDeclaration(parent)) continue;
		if (path === "web/src/remark-text-highlight.ts" && parent.name.getText() === "TEXT_HIGHLIGHT_COLORS") return true;
		return path === "web/src/image-paste.ts" && parent.name.getText() === "JPEG_MATTE_COLOR" && node.text === "#ffffff";
	}
	return false;
}

export function checkTsx(source, file = "component.tsx") {
	const issues = [];
	const ast = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, file.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
	function visit(node) {
		const line = ast.getLineAndCharacterOfPosition(node.getStart(ast)).line + 1;
		if (ts.isStringLiteralLike(node) || ts.isTemplateHead(node) || ts.isTemplateMiddle(node) || ts.isTemplateTail(node)) {
			const name = scriptProperty(node);
			const property = name === name.toUpperCase() ? name.toLowerCase() : name.replace(/[A-Z]/g, c => `-${c.toLowerCase()}`);
			if (!contentColor(node, file)) for (const color of literalColors(node.text, colorProperty.test(property))) issues.push({ file, line, severity: "error", message: `Use a design token instead of ${color}.` });
		}
		if (ts.isPropertyAssignment(node) && /^border(?:(?:Top|Bottom)(?:Left|Right))?Radius$/.test(node.name.getText(ast).replace(/["']/g, ""))) {
			const value = node.initializer;
			if ((ts.isStringLiteralLike(value) || ts.isNumericLiteral(value)) && !validRadius(value.text)) issues.push({ file, line, severity: "error", message: `Non-token radius: ${value.text}.` });
		}
		ts.forEachChild(node, visit);
	}
	visit(ast);
	return issues;
}

export function sourceFiles(dir) {
	return readdirSync(dir, { withFileTypes: true }).flatMap(entry => {
		const path = join(dir, entry.name);
		return entry.isDirectory() ? sourceFiles(path) : /\.(?:css|tsx?)$/.test(entry.name) ? [path] : [];
	});
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
	const issues = sourceFiles(join(root, "web/src")).flatMap(file => (file.endsWith(".css") ? checkCss : checkTsx)(readFileSync(file, "utf8"), relative(root, file)));
	for (const issue of issues) console[issue.severity === "error" ? "error" : "warn"](`${issue.file}:${issue.line}: ${issue.severity}: ${issue.message}`);
	const errors = issues.filter(issue => issue.severity === "error").length;
	console.log(`Design tokens: ${errors} errors, ${issues.length - errors} radius warnings.`);
	process.exitCode = errors ? 1 : 0;
}
