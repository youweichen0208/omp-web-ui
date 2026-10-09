"""Offline CHM regression; run with the isolated CHM runtime's Python 3.12."""
import hashlib
import json
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "server/document-conversion/python/chm"))
import bridge
from fixture import archive_bytes, sample_files


class ChmTests(unittest.TestCase):
	def setUp(self):
		self.temp = tempfile.TemporaryDirectory(prefix="pi-chm-test-")
		self.addCleanup(self.temp.cleanup)
		self.root = Path(self.temp.name)
		self.source = self.root / "manual.chm"
		self.output = self.root / "converted"

	def convert(self, files):
		self.source.write_bytes(archive_bytes(files))
		result = bridge.convert({"inputPath": str(self.source), "outputDir": str(self.output), "sourceHash": hashlib.sha256(self.source.read_bytes()).hexdigest()})
		text = (self.output / "document.md").read_text("utf-8")
		structure = json.loads((self.output / "structure.json").read_text("utf-8"))
		blocks = json.loads((self.output / "source-map.json").read_text("utf-8"))["blocks"]
		return result, text, structure, blocks

	def test_real_archive_chinese_order_links_tables_code_and_provenance(self):
		result, text, structure, blocks = self.convert(sample_files())
		self.assertEqual(result["status"], "complete", result)
		self.assertEqual([t["member"] for t in structure["topics"]], ["start.htm", "api.htm"])
		self.assertIn("中文内容", text)
		self.assertIn("| limit | 42 |", text)
		self.assertIn("```python\ndef total(values):\n    return sum(values)\n```", text)
		self.assertIn("#api-1)", text)
		self.assertIn("![图示](assets/", text)
		self.assertEqual(blocks[0]["locator"]["member"], "start.htm")
		self.assertTrue(any("return" in b["text"] and b["locator"]["member"] == "api.htm" for b in blocks))
		for topic in structure["topics"]:
			self.assertTrue((self.output / topic["markdownPath"]).is_file())
		self.assertIn("../assets/", (self.output / structure["topics"][0]["markdownPath"]).read_text("utf-8"))

	def test_preformatted_blank_lines_and_long_backtick_fences(self):
		files = sample_files()
		code = 'def example():\n\n\n    value = "```"\n\treturn value\n'
		files["api.htm"] = ('<h1 id="call">API</h1><pre><code>' + code + '</code></pre>').encode()
		result, text, _, blocks = self.convert(files)
		self.assertEqual(result["status"], "complete")
		self.assertIn("````\n" + code + "````", text)
		self.assertTrue(any(code.rstrip("\n") in block["text"] for block in blocks))

	def test_preformatted_html_linebreaks(self):
		files = sample_files()
		files["api.htm"] = b'<h1 id="call">API</h1><pre>def total():<br>    return 42</pre>'
		_, text, _, _ = self.convert(files)
		self.assertIn("def total():\n    return 42", text)

	def test_unlisted_topics_and_unknown_encoding_are_not_silently_dropped(self):
		files = sample_files()
		del files["manual.hhc"]
		files["extra.html"] = b'<meta charset="invalid-encoding"><p>Other evidence</p>'
		result, text, structure, _ = self.convert(files)
		self.assertEqual(result["status"], "partial")
		self.assertIn("Other evidence", text)
		self.assertEqual(len(structure["topics"]), 3)
		self.assertTrue(any("contents" in warning for warning in result["warnings"]))

	def test_merged_cells_missing_images_and_links_remain_partial(self):
		files = sample_files()
		files["api.htm"] = b'<h1 id="call">API</h1><table><tr><td colspan="2">Combined</td></tr><tr><td>A</td><td>B</td></tr></table><img src="missing.png"><a href="absent.htm">Missing</a><a href="start.htm#absent">Anchor</a>'
		result, text, structure, _ = self.convert(files)
		self.assertEqual(result["status"], "partial")
		self.assertIn("Combined", text)
		self.assertEqual(structure["tables"][0]["rows"][0][0]["colspan"], "2")
		self.assertTrue(any("image not archived" in w for w in result["warnings"]))
		self.assertTrue(any("link not resolved" in w for w in result["warnings"]))
		self.assertTrue(any("fragment" in w for w in result["warnings"]))

	def test_relative_case_insensitive_and_ms_its_links(self):
		files = sample_files()
		files["sub/child.html"] = b'<h1>Child</h1><a href="../START.HTM">Parent</a><a href="ms-its:manual.chm::/api.htm#call">API</a><img src="../images/dot.png">'
		result, text, _, _ = self.convert(files)
		self.assertEqual(result["status"], "complete", result)
		self.assertNotIn("ms-its:", text)
		self.assertIn("[Parent](topics/", text)

	def test_no_network_or_script_execution(self):
		files = sample_files()
		files["api.htm"] = b'<h1 id="call">API</h1><script>throw new Error("DO_NOT_RUN")</script><img src="https://example.invalid/image.png"><a href="javascript:alert(1)">unsafe</a>'
		result, text, _, _ = self.convert(files)
		self.assertEqual(result["status"], "partial")
		self.assertNotIn("DO_NOT_RUN", text)
		self.assertNotIn("javascript:", text)

	def test_traversal_and_duplicate_paths_are_rejected(self):
		for name in ["../outside.htm", "nested/../../outside.htm", "C:/outside.htm", "START.HTM"]:
			with self.subTest(name=name):
				with self.assertRaisesRegex(ValueError, "Unsafe|duplicate"):
					self.convert({**sample_files(), name: b"no write"})
		self.assertFalse((self.root / "outside.htm").exists())

	def test_size_budget_checked_before_conversion(self):
		with patch.object(bridge, "MAX_TOTAL", 10):
			with self.assertRaisesRegex(ValueError, "uncompressed"):
				self.convert(sample_files())
		self.assertFalse(self.output.exists())

	def test_corrupt_chm_fails_instead_of_empty_success(self):
		self.source.write_bytes(b"ITSF truncated")
		with self.assertRaises(Exception):
			bridge.convert({"inputPath": str(self.source), "outputDir": str(self.output), "sourceHash": "0" * 64})
		self.assertFalse(self.output.exists())


if __name__ == "__main__":
	bridge.offline()
	unittest.main()
