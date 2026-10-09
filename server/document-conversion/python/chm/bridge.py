"""Offline CHM -> structured Markdown. Archive paths are never extracted to disk."""
import codecs
import hashlib
import importlib.metadata
import json
import posixpath
import re
import sys
import tempfile
from copy import deepcopy
from pathlib import Path
from urllib.parse import unquote, urlsplit

VERSIONS = dict(line.split("==", 1) for line in Path(__file__).with_name("requirements.txt").read_text("utf-8").splitlines() if line.strip())
MAX_FILES = 10000
MAX_MEMBER = 20 * 1024 * 1024
MAX_TOTAL = 512 * 1024 * 1024
MAX_TEXT = 64 * 1024 * 1024
HTML_SUFFIXES = {".htm", ".html", ".xhtml"}
IMAGE_SUFFIXES = {".png", ".jpg", ".jpeg", ".gif", ".webp", ".bmp"}


def offline():
	def audit(event, args):
		if event in ("socket.connect", "socket.getaddrinfo", "socket.sendto"):
			raise PermissionError("Network access is disabled during CHM conversion")
	sys.addaudithook(audit)


def digest(text):
	return hashlib.sha256(text.encode("utf-8")).hexdigest()[:24]


def member_path(name):
	name = name.replace("\\", "/").lstrip("/")
	if not name or any(part in ("", ".", "..") for part in name.split("/")) or ":" in name or any(ord(c) < 32 for c in name):
		raise ValueError("Unsafe CHM member path: " + name)
	return name


def decode_html(data, name, warnings, language=0):
	# HTML declarations override the CHM language; GB2312 labels commonly contain GBK.
	match = re.search(br'charset\s*=\s*["\x27]?\s*([A-Za-z0-9_-]+)', data[:8192], re.I)
	declared = match[1].decode("ascii") if match else None
	if declared and declared.lower() in ("gb2312", "gbk", "cp936"):
		declared = "gb18030"
	choices = (["utf-16"] if data.startswith((b"\xff\xfe", b"\xfe\xff")) else []) + ([declared] if declared else []) + ["utf-8-sig"]
	fallback = {0x804: "gb18030", 0x404: "big5", 0x411: "cp932", 0x412: "cp949", 0x419: "cp1251", 0x409: "cp1252"}.get(language)
	if fallback:
		choices.append(fallback)
	for encoding in dict.fromkeys(choices):
		try:
			codecs.lookup(encoding)
			return data.decode(encoding).replace("\r\n", "\n").replace("\r", "\n"), encoding
		except (LookupError, UnicodeError):
			pass
	warnings.append(f"Uncertain text encoding: {name}; verify replacement characters")
	return data.decode("utf-8", errors="replace"), "utf-8-replacement"


def local_target(url, current, archive_name):
	url = url.strip().replace("\\", "/")
	if "::" in url:
		archive, url = url.rsplit("::", 1)
		if unquote(archive).lower().split("/")[-1].split(":")[-1] != archive_name.lower():
			raise ValueError("link to another CHM archive")
	parts = urlsplit(url)
	if parts.scheme or parts.netloc:
		raise ValueError("external or executable URL")
	path = unquote(parts.path)
	if path:
		path = posixpath.normpath(path.lstrip("/") if path.startswith("/") else posixpath.join(posixpath.dirname(current), path))
	else:
		path = current
	return member_path(path).casefold(), unquote(parts.fragment)


def heading_slug(text):
	return re.sub(r"[^\w\- ]", "", text.lower(), flags=re.UNICODE).replace(" ", "-")


def converter():
	from markdownify import MarkdownConverter

	class ChmMarkdown(MarkdownConverter):
		def convert_pre(self, el, text, parent_tags):
			# HTML <pre> already has the exact indentation; never wrap or infer it.
			el = deepcopy(el)
			for linebreak in el.find_all("br"):
				linebreak.replace_with("\n")
			code = el.get_text().replace("\r\n", "\n").replace("\r", "\n")
			language = ""
			for node in [el, *el.find_all("code")]:
				for value in node.get("class", []):
					if re.fullmatch(r"(?:language|lang)-[A-Za-z0-9_+-]+", value):
						language = value.split("-", 1)[1]
			fence = "`" * max(3, 1 + max((len(m[0]) for m in re.finditer(r"`+", code)), default=0))
			return f"\n\n{fence}{language}\n{code}{'' if code.endswith(chr(10)) else chr(10)}{fence}\n\n"

	return ChmMarkdown(heading_style="ATX", bullets="-", table_infer_header=False, strip=["script", "style"])


def convert(request):
	from bs4 import BeautifulSoup, Comment
	from pylibmspack import ChmArchive
	source, output = Path(request["inputPath"]), Path(request["outputDir"])
	archive_name = request.get("archiveName") or source.name
	archive = ChmArchive(str(source))
	info = archive.info()
	entries = archive.files(include_system=False)
	if len(entries) > MAX_FILES or sum(entry["size"] for entry in entries) > MAX_TOTAL:
		raise ValueError("CHM exceeds 10000 members or 512 MiB uncompressed")
	warnings, members = [], {}
	for entry in entries:
		if entry["name"].endswith("/") or entry["name"].lstrip("/").startswith(("#", "$")):
			continue
		name = member_path(entry["name"])
		key = name.casefold()
		if key in members:
			raise ValueError("Ambiguous duplicate CHM member: " + name)
		if entry["size"] > MAX_MEMBER:
			raise ValueError("CHM member exceeds 20 MiB: " + name)
		members[key] = {**entry, "path": name}
	text_size = sum(e["size"] for e in members.values() if Path(e["path"]).suffix.lower() in HTML_SUFFIXES | {".hhc"})
	if text_size > MAX_TEXT:
		raise ValueError("CHM HTML exceeds 64 MiB")
	pages = {key: entry for key, entry in members.items() if Path(entry["path"]).suffix.lower() in HTML_SUFFIXES}
	if not pages:
		raise ValueError("CHM contains no HTML topics")

	def read(key):
		entry = members[key]
		data = archive.read(entry["name"], max_size=MAX_MEMBER)
		if len(data) != entry["size"]:
			raise ValueError("Incomplete CHM member: " + entry["path"])
		return data

	def soup_for(key):
		text, encoding = decode_html(read(key), members[key]["path"], warnings, info.get("language", 0))
		return BeautifulSoup(text, "html.parser"), encoding

	# HHC supplies document order. All unlisted HTML topics are appended, never dropped.
	toc, order = [], []
	for key in sorted(k for k in members if k.endswith(".hhc")):
		soup, _ = soup_for(key)
		for node in soup.find_all("object"):
			params = {str(p.get("name", "")).lower(): str(p.get("value", "")) for p in node.find_all("param")}
			item = {"title": params.get("name", ""), "depth": max(0, len(node.find_parents("ul")) - 1), "target": None}
			if params.get("local"):
				try:
					target, fragment = local_target(params["local"], key, archive_name)
					if target not in pages:
						raise ValueError("missing HTML topic")
					item.update(target=target, fragment=fragment)
					if target not in order:
						order.append(target)
				except ValueError as error:
					warnings.append(f"Unresolved CHM contents entry: {params['local']}: {error}")
			toc.append(item)
	if not toc:
		warnings.append("CHM has no readable HTML contents (.hhc); topics are ordered by archive path")
	order.extend(key for key in sorted(pages) if key not in order)
	output.mkdir(parents=True, exist_ok=True)
	(output / "assets").mkdir(exist_ok=True)
	(output / "topics").mkdir(exist_ok=True)
	parser = converter()
	topics, tables, copied_assets = {}, [], {}
	for key in order:
		soup, encoding = soup_for(key)
		title_node = soup.find("title") or soup.find(re.compile(r"^h[1-6]$"))
		title = title_node.get_text(" ", strip=True) if title_node else pages[key]["path"]
		for node in soup.find_all(["script", "style", "head", "meta", "title", "link"]):
			node.decompose()
		for node in soup.find_all(string=lambda value: isinstance(value, Comment)):
			node.extract()
		if soup.find(["iframe", "frame", "object", "embed", "audio", "video"]):
			warnings.append(f"Embedded or active content omitted: {pages[key]['path']}")
		for node in soup.find_all(["iframe", "frame", "object", "embed", "audio", "video"]):
			node.decompose()
		if not soup.get_text(strip=True) and not soup.find("img"):
			warnings.append(f"CHM topic has no readable content: {pages[key]['path']}")
		# Predictable headings preserve fragments for standard Markdown renderers.
		heading = soup.new_tag("h1")
		heading.string = title
		(soup.body or soup).insert(0, heading)
		anchors, counts = {}, {}
		for node in soup.find_all(re.compile(r"^h[1-6]$")):
			slug = heading_slug(node.get_text())
			count = counts.get(slug, 0)
			counts[slug] = count + 1
			anchor = slug + (f"-{count}" if count else "")
			anchors.setdefault(slug, anchor)
			if node.get("id"):
				anchors[node["id"]] = anchor
		for node in soup.find_all("a"):
			name = node.get("name") or node.get("id")
			if name:
				heading = node.find_parent(re.compile(r"^h[1-6]$")) or node.find_next(re.compile(r"^h[1-6]$"))
				if heading:
					anchors[name] = anchors.get(heading.get("id"), anchors.get(heading_slug(heading.get_text()), ""))
		for table in soup.find_all("table"):
			if table.find("table"):
				warnings.append(f"Nested table layout requires review: {pages[key]['path']}")
			cells = [[{"text": cell.get_text(" ", strip=True), "rowspan": cell.get("rowspan", "1"), "colspan": cell.get("colspan", "1")} for cell in row.find_all(["td", "th"], recursive=False)] for row in table.find_all("tr")]
			tables.append({"member": pages[key]["path"], "rows": cells})
			if any(cell["rowspan"] != "1" or cell["colspan"] != "1" for row in cells for cell in row):
				warnings.append(f"Merged table cells require review; original spans retained in structure.json: {pages[key]['path']}")
		for node in soup.find_all("img"):
			url = str(node.get("src", ""))
			try:
				target, _ = local_target(url, key, archive_name)
				if target not in members or Path(target).suffix not in IMAGE_SUFFIXES:
					raise ValueError("missing or unsupported image")
				if target not in copied_assets:
					data = read(target)
					asset = "assets/" + hashlib.sha256(data).hexdigest()[:24] + Path(target).suffix
					(output / asset).write_bytes(data)
					copied_assets[target] = asset
				node["src"] = copied_assets[target]
			except ValueError as error:
				warnings.append(f"CHM image not archived: {url}: {error}")
				node.replace_with(f"[Image unavailable: {node.get('alt', url)}]")
		topics[key] = {"soup": soup, "title": title, "encoding": encoding, "anchors": anchors, "output": "topics/" + digest(key) + ".md"}

	def render(key, combined):
		topic = topics[key]
		soup = deepcopy(topic["soup"])
		for node in soup.find_all("a", href=True):
			url = str(node["href"])
			if re.match(r"^(?:https?://|mailto:)", url, re.I):
				continue
			try:
				target, fragment = local_target(url, key, archive_name)
				if target not in topics:
					raise ValueError("missing or non-HTML target")
				anchor = topics[target]["anchors"].get(fragment) if fragment else None
				if fragment and anchor is None:
					warnings.append(f"CHM fragment falls back to topic: {pages[key]['path']} -> {url}")
				node["href"] = (topics[target]["output"] if combined else Path(topics[target]["output"]).name) + ("#" + anchor if anchor else "")
			except ValueError as error:
				warnings.append(f"CHM link not resolved: {pages[key]['path']} -> {url}: {error}")
				del node["href"]
		if not combined:
			for node in soup.find_all("img", src=True):
				node["src"] = "../" + node["src"]
		return parser.convert_soup(soup).strip() + "\n"

	blocks, combined_pages, metadata = [], [], []
	for key in order:
		topic = topics[key]
		markdown = render(key, True)
		(output / topic["output"]).write_text(render(key, False), "utf-8")
		# One source block per paragraph/code/table; blank lines in fences stay intact.
		start, fence, lines = 0, None, markdown.splitlines()
		for index in range(len(lines) + 1):
			line = lines[index] if index < len(lines) else ""
			marker = re.match(r"^(`{3,}|~{3,})", line)
			if marker:
				if fence is None:
					fence = marker[1]
				elif marker[1][0] == fence[0] and len(marker[1]) >= len(fence):
					fence = None
			if index == len(lines) or (not line.strip() and fence is None):
				text = "\n".join(lines[start:index])
				if text.strip():
					blocks.append({"id": f"block-{len(blocks) + 1}", "text": text, "locator": {"member": pages[key]["path"], "heading": topic["title"], "lineStart": start + 1, "lineEnd": index}})
				start = index + 1
		combined_pages.append(markdown)
		metadata.append({"member": pages[key]["path"], "title": topic["title"], "encoding": topic["encoding"], "markdownPath": topic["output"], "anchors": topic["anchors"]})
	contents = []
	for item in toc:
		title = re.sub(r"[\[\]\r\n]", " ", item["title"] or "Untitled")
		target = item["target"]
		url = topics[target]["output"] if target else None
		if target and item.get("fragment"):
			anchor = topics[target]["anchors"].get(item["fragment"])
			if anchor:
				url += "#" + anchor
			else:
				warnings.append(f"CHM contents fragment falls back to topic: {target}#{item['fragment']}")
		contents.append("  " * min(item["depth"], 20) + "- " + (f"[{title}]({url})" if target else title))
	unlisted = [key for key in order if key not in {item["target"] for item in toc}]
	contents.extend(f"- [{re.sub(r'[\[\]\r\n]', ' ', topics[key]['title'])}]({topics[key]['output']})" for key in unlisted)
	markdown = "# Contents\n\n" + "\n".join(contents) + "\n\n" + "\n\n---\n\n".join(combined_pages)
	if len(markdown.encode("utf-8")) > MAX_TEXT:
		raise ValueError("Converted CHM exceeds 64 MiB")
	warnings = list(dict.fromkeys(warnings))
	(output / "document.md").write_text(markdown, "utf-8")
	(output / "structure.json").write_text(json.dumps({"schemaVersion": 1, "kind": "chm", "origin": {"filename": archive_name}, "topics": metadata, "contents": toc, "tables": tables}, ensure_ascii=False, indent=2), "utf-8")
	(output / "source-map.json").write_text(json.dumps({"schemaVersion": 1, "source": str(source), "sourceHash": request["sourceHash"], "lineBasis": "normalized topic Markdown", "blocks": blocks}, ensure_ascii=False, indent=2), "utf-8")
	return {"status": "partial" if warnings else "complete", "warnings": warnings[:200] + ([f"{len(warnings) - 200} additional warnings"] if len(warnings) > 200 else [])}


def doctor():
	missing, actual = [], {}
	for name, expected in VERSIONS.items():
		try:
			actual[name] = importlib.metadata.version(name)
			if actual[name] != expected:
				missing.append(f"Expected {name} {expected}; found {actual[name]}")
		except importlib.metadata.PackageNotFoundError:
			missing.append(name + " is not installed")
	if sys.version_info[:2] != (3, 12):
		missing.append("CHM runtime requires Python 3.12")
	if not missing:
		try:
			from fixture import archive_bytes, sample_files
			with tempfile.TemporaryDirectory(prefix="pi-chm-check-") as directory:
				source = Path(directory) / "fixture.chm"
				source.write_bytes(archive_bytes(sample_files()))
				output = Path(directory) / "out"
				result = convert({"inputPath": str(source), "outputDir": str(output), "sourceHash": hashlib.sha256(source.read_bytes()).hexdigest()})
				text = (output / "document.md").read_text("utf-8")
				if result["status"] != "complete" or "中文内容" not in text or "    return sum(values)" not in text or "| limit | 42 |" not in text:
					raise ValueError("CHM offline content qualification failed")
		except Exception as error:
			missing.append(str(error))
	return {"ready": not missing, "parserVersion": "chm-html-v1/" + json.dumps(actual, sort_keys=True), "missing": missing, "warnings": []}


if __name__ == "__main__":
	offline()
	try:
		result = doctor() if sys.argv[1] == "doctor" else convert(json.load(sys.stdin))
		# ASCII JSON avoids splitting multibyte warnings across Node stdout chunks.
		print(json.dumps(result))
	except Exception as error:
		print(str(error), file=sys.stderr)
		sys.exit(1)
