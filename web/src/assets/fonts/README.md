# UI SC

Noto Sans SC, renamed UI SC after subsetting. Licensed under SIL OFL 1.1; see OFL.txt.

Upstream: https://github.com/notofonts/noto-cjk/tree/f8d157532fbfaeda587e826d4cd5b21a49186f7c/Sans

Rebuild with Python, fonttools 4.60.2, brotli 1.2.0 and zopfli 0.2.3.post1:

```sh
python scripts/build-ui-fonts.py /path/to/NotoSansSC-VF.ttf /path/to/OFL.txt
```

The builder instantiates real 400/500/600 weights, includes GB2312 level-one
characters, Han characters from UI sources, ASCII and Chinese punctuation.
The manifest records upstream and output hashes, weights and the character set.
