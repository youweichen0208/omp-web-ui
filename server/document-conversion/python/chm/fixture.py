"""Small generated, uncompressed CHM used by the offline runtime self-check.

Header field layout: libmspack/mspack/chm.h (ITSF v3, ITSP, PMGL).
Contains only synthetic project-owned text; no downloaded manual is bundled.
"""
import base64
import struct


def archive_bytes(files):
	def enc(value):
		groups = [value & 127]
		while value >> 7:
			value >>= 7
			groups.append((value & 127) | 128)
		return bytes(reversed(groups))

	entries, payload = bytearray(), bytearray()
	for name, data in sorted(files.items()):
		name = ("/" + name.lstrip("/")).encode("utf-8")
		entries.extend(enc(len(name)) + name + enc(0) + enc(len(payload)) + enc(len(data)))
		payload.extend(data)
	chunk_size = 4096
	if len(entries) > chunk_size - 22:
		raise ValueError("Fixture directory exceeds one PMGL chunk")
	chunk = bytearray(chunk_size)
	struct.pack_into("<4sIIII", chunk, 0, b"PMGL", chunk_size - 20 - len(entries), 0, 0xFFFFFFFF, 0xFFFFFFFF)
	chunk[20:20 + len(entries)] = entries
	struct.pack_into("<H", chunk, chunk_size - 2, len(files))
	directory = bytearray(84)
	struct.pack_into("<4s11I", directory, 0, b"ITSP", 1, 84, 10, chunk_size, 2, 1, 0xFFFFFFFF, 0, 0, 0xFFFFFFFF, 1)
	struct.pack_into("<I", directory, 48, 0x804)
	header = bytearray(96)
	struct.pack_into("<4sIIIII", header, 0, b"ITSF", 3, 96, 1, 0, 0x804)
	header[24:56] = bytes.fromhex("10fd017caa7bd0119e0c00a0c922e6ec11fd017caa7bd0119e0c00a0c922e6ec")
	content_offset = 96 + 24 + len(directory) + len(chunk)
	struct.pack_into("<QQQQQ", header, 56, 96, 24, 120, len(directory) + len(chunk), content_offset)
	section = struct.pack("<IIQII", 0x1FE, 0, content_offset + len(payload), 0, 0)
	return bytes(header + section + directory + chunk + payload)


def sample_files():
	return {
		"manual.hhc": b'<ul><li><object type="text/sitemap"><param name="Name" value="Start"><param name="Local" value="start.htm"></object><ul><li><object type="text/sitemap"><param name="Name" value="API"><param name="Local" value="api.htm#call"></object></ul></ul>',
		"start.htm": '<meta charset="gb2312"><title>使用指南</title><h1>开始</h1><p>中文内容</p><a href="api.htm#call">调用接口</a><img src="images/dot.png" alt="图示">'.encode("gb18030"),
		"api.htm": b'<meta charset="utf-8"><h1 id="call">API</h1><pre><code class="language-python">def total(values):\n    return sum(values)\n</code></pre><table><tr><th>Name</th><th>Value</th></tr><tr><td>limit</td><td>42</td></tr></table>',
		"images/dot.png": base64.b64decode("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aZI0AAAAASUVORK5CYII="),
	}
