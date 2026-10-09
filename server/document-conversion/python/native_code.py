"""Recover visible PDF code spacing only when native glyphs prove a fixed grid.

PDF text APIs can collapse explicit spaces. We retain native Unicode characters
and reconstruct their visible columns from glyph origins, never from code syntax.
Ambiguous geometry remains unchanged and is reported for review.
"""
import ctypes
import re


_SIGNATURE = re.compile(r"^\s*(?:(?:async\s+)?def\s+[A-Za-z_]\w*\s*\(|(?:export\s+)?(?:async\s+)?function(?:\s+[A-Za-z_$][\w$]*)?\s*\(|(?:public\s+|private\s+|static\s+)*(?:void|int|bool|float|double|char|long)\s+[A-Za-z_]\w*\s*\()")


def _compact(value):
	return re.sub(r"\s+", "", value)


def _native_region(page, textpage, bbox):
	import pypdfium2 as pdfium
	if page.get_rotation() != 0:
		raise ValueError("rotated page")
	if textpage.count_chars() > 100_000:
		raise ValueError("native page exceeds the character inspection limit")
	bounds = bbox.to_bottom_left_origin(page.get_height())
	chars, pitches, font_heights = [], [], []
	font_cache = {}
	for index in range(textpage.count_chars()):
		codepoint = pdfium.raw.FPDFText_GetUnicode(textpage.raw, index)
		if codepoint in (10, 13):
			continue
		x, y = ctypes.c_double(), ctypes.c_double()
		if not pdfium.raw.FPDFText_GetCharOrigin(textpage.raw, index, ctypes.byref(x), ctypes.byref(y)):
			continue
		left, bottom, right, top = textpage.get_charbox(index)
		if not (bounds.l - 0.25 <= (left + right) / 2 <= bounds.r + 0.25 and bounds.b - 0.25 <= y.value <= bounds.t + 0.25):
			continue
		if pdfium.raw.FPDFText_IsGenerated(textpage.raw, index):
			if codepoint == 32:
				continue
			raise ValueError("generated non-whitespace character")
		if codepoint < 32 or codepoint > 0x10ffff or 0xd800 <= codepoint <= 0xdfff or pdfium.raw.FPDFText_HasUnicodeMapError(textpage.raw, index):
			raise ValueError("unmapped or control character")
		obj = textpage.get_textobj(index)
		if obj is None:
			raise ValueError("character has no native text object")
		matrix = obj.get_matrix()
		if abs(matrix.b) > 1e-5 or abs(matrix.c) > 1e-5 or matrix.a <= 0 or matrix.d <= 0 or abs(pdfium.raw.FPDFText_GetCharAngle(textpage.raw, index)) > 1e-5:
			raise ValueError("rotated or skewed text")
		if pdfium.raw.FPDFTextObj_GetTextRenderMode(obj.raw) in (3, 7):
			raise ValueError("invisible text layer")
		font, size = obj.get_font(), obj.get_font_size()
		font_key = (ctypes.cast(font.raw, ctypes.c_void_p).value, size, matrix.a)
		def width(character):
			value = ctypes.c_float()
			if not pdfium.raw.FPDFFont_GetGlyphWidth(font.raw, ord(character), size, ctypes.byref(value)):
				raise ValueError("unavailable glyph advance")
			return value.value * matrix.a
		if font_key not in font_cache:
			advances = [width(character) for character in " iMW0"]
			if min(advances) <= 0 or max(advances) - min(advances) > max(0.01, advances[0] * 0.002):
				raise ValueError("proportional font")
			font_cache[font_key] = advances[0]
		pitch = font_cache[font_key]
		advance = width(chr(codepoint))
		cells = round(advance / pitch)
		if cells not in (1, 2) or abs(advance / pitch - cells) > 0.02:
			raise ValueError("character advance is not an integral grid width")
		chars.append({"index": index, "character": chr(codepoint), "x": x.value, "y": y.value, "cells": cells})
		pitches.append(pitch)
		font_heights.append(size * matrix.d)
	if not chars:
		raise ValueError("no visible native text in this region")
	pitch = sum(pitches) / len(pitches)
	if max(pitches) - min(pitches) > max(0.01, pitch * 0.002):
		raise ValueError("mixed glyph advances")
	rows = []
	for char in sorted(chars, key=lambda value: (-value["y"], value["x"])):
		if not rows or abs(rows[-1][0]["y"] - char["y"]) > 0.15:
			rows.append([])
		rows[-1].append(char)
	gaps = [rows[i][0]["y"] - rows[i + 1][0]["y"] for i in range(len(rows) - 1)]
	line_advance = min(gaps) if gaps else None
	gap_cells = []
	if line_advance is not None:
		if line_advance < pitch or line_advance > 2 * min(font_heights):
			raise ValueError("baseline spacing cannot establish a continuous line grid")
		for gap in gaps:
			cells = round(gap / line_advance)
			if cells < 1 or cells > 8 or abs(gap / line_advance - cells) > 0.025:
				raise ValueError("non-integral baseline gaps may contain significant blank lines")
			gap_cells.append(cells)
	origin = min(char["x"] for char in chars)
	lines = []
	for row_index, row in enumerate(rows):
		if row_index:
			# Empty rows preserve measured visual gaps, without interpreting syntax.
			lines.extend([""] * (gap_cells[row_index - 1] - 1))
		line, cursor = "", 0
		for char in sorted(row, key=lambda value: value["x"]):
			column = (char["x"] - origin) / pitch
			cell = round(column)
			if cell < cursor or cell > 2000 or abs(column - cell) > 0.025:
				raise ValueError("overlapping or non-integral character positions")
			line += " " * (cell - cursor) + char["character"]
			cursor = cell + char["cells"]
		lines.append(line.rstrip())
	return "\n".join(lines), {"advance": pitch, "lineAdvance": line_advance, "rowPitch": line_advance, "baselineGaps": gaps, "gapRows": gap_cells, "originX": origin, "baselines": [row[0]["y"] for row in rows], "characters": chars}


def recover_native_code(document, source):
	"""Mutate qualified Docling text/code items; return auditable recovery metadata."""
	import pypdfium2 as pdfium
	from docling_core.types.doc import CodeItem
	items = [item for item, _level in document.iterate_items() if str(getattr(item, "label", "")) in ("code", "text") and (str(item.label) == "code" or _SIGNATURE.match(getattr(item, "text", "")))]
	result = {"recovered": 0, "warnings": [], "needs_review": False, "recoveries": []}
	if not items:
		return result
	with pdfium.PdfDocument(source) as pdf:
		for item in items:
			try:
				if len(item.prov) != 1:
					raise ValueError("code spans multiple or unspecified regions")
				prov = item.prov[0]
				page = pdf[prov.page_no - 1]
				try:
					textpage = page.get_textpage()
					try:
						text, evidence = _native_region(page, textpage, prov.bbox)
					finally:
						textpage.close()
				finally:
					page.close()
				if _compact(text) not in {_compact(item.text), _compact(item.orig)}:
					raise ValueError("native characters differ from the recognized region")
				if any(delimiter in text or delimiter in item.text for delimiter in ('"""', "'''", "`")):
					raise ValueError("multiline string whitespace requires explicit review")
				if str(item.label) != "code" and "\n" not in text:
					continue
				data = item.model_dump()
				data.update(label="code", text=text, orig=text)
				new_item = CodeItem(**data)
				new_item.prov[0].charspan = (0, len(text))
				document.replace_item(old_item=item, new_item=new_item)
				result["recovered"] += 1
				result["recoveries"].append({"id": new_item.self_ref, "page": prov.page_no, "bbox": prov.bbox.model_dump(mode="json"), "originalText": item.text, "text": text, **evidence})
			except Exception as error:
				result["needs_review"] = True
				result["warnings"].append(f"Native code layout could not be verified for {item.self_ref}: {error}; recognized text was preserved for review.")
	return result
