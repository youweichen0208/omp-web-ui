"""Rebuild UI SC: fonttools[woff]==4.60.2; supply the pinned Noto Sans SC variable TTF.
Source: notofonts/noto-cjk f8d157532fbfaeda587e826d4cd5b21a49186f7c
Sans/Variable/TTF/Subset/NotoSansSC-VF.ttf; license: Sans/LICENSE (SIL OFL 1.1).
"""
import hashlib
import json
from pathlib import Path
import re
import sys
from fontTools.ttLib import TTFont
from fontTools.varLib.instancer import instantiateVariableFont
from fontTools import subset

root = Path(__file__).resolve().parent.parent
source = Path(sys.argv[1])
license_path = Path(sys.argv[2])
out = root / "web/src/assets/fonts"
out.mkdir(parents=True, exist_ok=True)
characters = set()
for first in range(0xB0, 0xD8):
	for second in range(0xA1, 0xFF):
		try:
			characters.add(bytes([first, second]).decode("gb2312"))
		except UnicodeDecodeError:
			pass
assert len(characters) == 3755
for path in (root / "web/src").rglob("*"):
	if path.suffix in (".ts", ".tsx", ".json"):
		characters.update(re.findall(r"[\u3400-\u9fff]", path.read_text(encoding="utf8")))
for start, end in [(0x20, 0x7F), (0x3000, 0x3040), (0xFF00, 0xFFF0)]:
	characters.update(chr(value) for value in range(start, end))
manifest = {"source": "https://github.com/notofonts/noto-cjk/blob/f8d157532fbfaeda587e826d4cd5b21a49186f7c/Sans/Variable/TTF/Subset/NotoSansSC-VF.ttf", "sourceSha256": hashlib.sha256(source.read_bytes()).hexdigest(), "fonttools": "4.60.2", "characters": "".join(sorted(characters)), "files": {}}
for weight, style in [(400, "Regular"), (500, "Medium"), (600, "SemiBold")]:
	font = instantiateVariableFont(TTFont(source), {"wght": weight}, inplace=True)
	options = subset.Options()
	options.flavor = "woff2"
	options.layout_features = ["*"]
	subsetter = subset.Subsetter(options=options)
	subsetter.populate(unicodes=[ord(char) for char in characters])
	subsetter.subset(font)
	for name_id, value in {1: "UI SC", 2: style, 4: f"UI SC {style}", 6: f"UI-SC-{style}", 16: "UI SC", 17: style}.items():
		font["name"].setName(value, name_id, 3, 1, 0x409)
	font.flavor = "woff2"
	path = out / f"ui-sc-{weight}.woff2"
	font.save(path)
	assert path.stat().st_size <= 650 * 1024, "Subset exceeds the font byte budget"
	manifest["files"][path.name] = {"weight": weight, "bytes": path.stat().st_size, "sha256": hashlib.sha256(path.read_bytes()).hexdigest()}
(out / "OFL.txt").write_bytes(license_path.read_bytes())
(out / "manifest.json").write_text(json.dumps(manifest, ensure_ascii=False, indent=2) + "\n", encoding="utf8")
print(json.dumps(manifest["files"], indent=2))
