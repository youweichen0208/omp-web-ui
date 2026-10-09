"""Offline native-glyph checks; run with the qualified document runtime's Python."""
import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "server/document-conversion/python"))
from native_code import recover_native_code
from docling_core.types.doc import BoundingBox, CoordOrigin, DocItemLabel, DoclingDocument, ProvenanceItem


def write_pdf(path, lines, font="Courier", size=12, positions=None, invisible=False):
	positions = positions or [(72, 700 - index * 18) for index in range(len(lines))]
	commands = []
	for text, (x, y) in zip(lines, positions):
		escaped = text.replace("\\", "\\\\").replace("(", "\\(").replace(")", "\\)")
		commands.append(f"BT /F1 {size} Tf {3 if invisible else 0} Tr 1 0 0 1 {x} {y} Tm ({escaped}) Tj ET")
	stream = "\n".join(commands).encode("ascii")
	objects = [b"<< /Type /Catalog /Pages 2 0 R >>", b"<< /Type /Pages /Kids [3 0 R] /Count 1 >>", b"<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>", f"<< /Type /Font /Subtype /Type1 /BaseFont /{font} >>".encode(), b"<< /Length " + str(len(stream)).encode() + b" >>\nstream\n" + stream + b"\nendstream"]
	output = bytearray(b"%PDF-1.7\n")
	offsets = [0]
	for index, value in enumerate(objects, 1):
		offsets.append(len(output))
		output.extend(f"{index} 0 obj\n".encode() + value + b"\nendobj\n")
	xref = len(output)
	output.extend(f"xref\n0 {len(objects) + 1}\n0000000000 65535 f \n".encode())
	for offset in offsets[1:]:
		output.extend(f"{offset:010d} 00000 n \n".encode())
	output.extend(f"trailer\n<< /Size {len(objects) + 1} /Root 1 0 R >>\nstartxref\n{xref}\n%%EOF\n".encode())
	path.write_bytes(output)


def make_document(text, code=False):
	document = DoclingDocument(name="native-code-fixture")
	prov = ProvenanceItem(page_no=1, bbox=BoundingBox(l=70, r=550, b=100, t=750, coord_origin=CoordOrigin.BOTTOMLEFT), charspan=(0, len(text)))
	if code:
		document.add_code(text=text, prov=prov)
	else:
		document.add_text(label=DocItemLabel.TEXT, text=text, prov=prov)
	return document


class NativeCodeTest(unittest.TestCase):
	def setUp(self):
		self.folder = tempfile.TemporaryDirectory(prefix="native-code-check-")
		self.path = Path(self.folder.name) / "fixture.pdf"

	def tearDown(self):
		self.folder.cleanup()

	def test_collapsed_short_code_preserves_native_four_space_columns(self):
		lines = ["def calculate_total(values):", "    return sum(values)"]
		write_pdf(self.path, lines)
		document = make_document(" ".join(line.strip() for line in lines))
		result = recover_native_code(document, self.path)
		self.assertEqual(result["recovered"], 1)
		self.assertFalse(result["needs_review"])
		self.assertIn("```\n" + "\n".join(lines) + "\n```", document.export_to_markdown())
		self.assertTrue(result["recoveries"][0]["characters"])
		self.assertEqual(document.body.children[0].cref, "#/texts/0")
		self.assertEqual(document.texts[0].prov[0].charspan, (0, len("\n".join(lines))))

	def test_font_size_and_indentation_are_measured_not_assumed(self):
		lines = ["def first(values):", "  return sum(values)", "def second(values):", "  return first(values)"]
		write_pdf(self.path, lines, font="Courier-Bold", size=10, positions=[(101, 680 - index * 16) for index in range(4)])
		document = make_document("\n".join(line.strip() for line in lines), code=True)
		result = recover_native_code(document, self.path)
		self.assertEqual(result["recovered"], 1)
		self.assertEqual(document.texts[0].text, "\n".join(lines))
		self.assertAlmostEqual(result["recoveries"][0]["advance"], 6, places=4)

	def test_integer_baseline_grid_preserves_visible_blank_rows(self):
		lines = ["def first(values):", "    return sum(values)", "def second(values):", "    return first(values)"]
		write_pdf(self.path, lines, positions=[(72, 700), (72, 682), (72, 646), (72, 628)])
		document = make_document("\n".join(lines), code=True)
		result = recover_native_code(document, self.path)
		self.assertEqual(result["recovered"], 1)
		self.assertEqual(document.texts[0].text, "\n".join(lines[:2]) + "\n\n" + "\n".join(lines[2:]))
		self.assertAlmostEqual(result["recoveries"][0]["lineAdvance"], 18, places=4)

	def test_ambiguous_geometry_or_source_keeps_recognized_output_for_review(self):
		cases = [
			("proportional", ["def calculate_total(values):", "    return sum(values)"], {"font": "Helvetica"}),
			("off-grid", ["def calculate_total(values):", "    return sum(values)"], {"positions": [(72, 700), (72.8, 682)]}),
			("non-integral-blank-gap", ["def first(values):", "    return sum(values)", "def second(values):"], {"positions": [(72, 700), (72, 682), (72, 650)]}),
			("invisible", ["def calculate_total(values):", "    return sum(values)"], {"invisible": True}),
			("multiline-string", ["def quote():", '    return """value"""'], {}),
		]
		for name, lines, options in cases:
			with self.subTest(name=name):
				write_pdf(self.path, lines, **options)
				document = make_document(" ".join(line.strip() for line in lines), code=True)
				before = document.model_dump()
				result = recover_native_code(document, self.path)
				self.assertEqual(result["recovered"], 0)
				self.assertTrue(result["needs_review"])
				self.assertEqual(document.model_dump(), before)

	def test_recognized_code_without_native_text_requires_review(self):
		write_pdf(self.path, [])
		document = make_document("def sample():\n    return 1", code=True)
		result = recover_native_code(document, self.path)
		self.assertEqual(result["recovered"], 0)
		self.assertTrue(result["needs_review"])


if __name__ == "__main__":
	unittest.main()
