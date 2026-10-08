Wiki heading fonts: Source Serif 4 and Noto Serif SC, weight 500.

Source: fonts embedded in the user-provided `页面重设计优化 (22).zip` design export (Google Fonts distributions). OFL licenses are included in each font directory, retrieved from google/fonts `ofl/sourceserif4/OFL.txt` and `ofl/notoserifsc/OFL.txt`.

The supplied WOFF2 faces were subset with fontTools to Latin, punctuation, full-width symbols, and GB2312 level-one Chinese characters. `web/src/styles.css` declares the actual remaining Unicode ranges, so browsers load only needed faces. Other characters fall back to the system serif font. Body text continues to use the existing sans-serif family.
