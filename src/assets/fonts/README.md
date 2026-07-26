# 打包字体

## source-han-serif-sc-regular-gb2312.woff2

思源宋体（Source Han Serif SC）Regular 的自制子集，用于「书写字体 · 衬线」模式下的
中文正文。Android 系统不预装任何中文衬线字体，不打包就永远回落到黑体，
所以这个文件是衬线书写体验在手机上成立的前提。

- 来源：adobe-fonts/source-han-serif `2.003R` · `SubsetOTF/CN/SourceHanSerifCN-Regular.otf`
- 子集范围：GB2312 全集 6763 汉字 + CJK 标点（U+3000–303F）+ 全角符号（U+FF00–FF65）
  + 西文补充标点（U+2013–2026、U+00B7、U+3007）
- 生成命令见 `docs/UX-VISUAL-DIRECTION.md` 字体一节；重新生成用
  `python -m fontTools.subset`（fonttools + brotli）
- 许可：SIL Open Font License 1.1（© Adobe，Source Han Serif 项目）。
  OFL 允许子集化与随应用分发，需保留版权与许可声明，即本文件。

子集外的生僻字会回落到系统黑体：GB2312 覆盖日常写作 99.9% 以上，
偶发缺字是可接受的取舍，不要为此把全量 8MB 字体塞进包里。
