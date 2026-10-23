[中文](https://github.com/JeffeyChou/siyuan-print-pdf/blob/main/README.zh-CN.md)

# Print to PDF

SiYuan's desktop browser and Docker builds have no PDF export: the native item only works in the desktop app and the mobile apps. This plugin adds it. The kernel renders the whole document (long documents are not cut off by the editor's lazy loading), the plugin lays it out with the same template as SiYuan's own export, and the browser's print dialog saves it with **Save as PDF**.

## Usage

* Open the menu of a document's title icon, or right-click a document in the document tree, and choose **Export PDF**. You can also bind a key to **Export PDF** in Settings → Keymap.
* Pick a style preset and the page settings, then click **Export**. In the print dialog, choose **Save as PDF**. The file is named after the document.

## Style presets

* **Current rendering**: your current theme plus your CSS snippets and plugin CSS, as the editor shows the document.
* **Clean print** and your own presets: start from your current theme or the default daylight theme and add your own CSS. **Edit styles** shows the CSS on the left and a live, paper-sized preview on the right. The content container is `#preview`.

Each preset saves its own page settings:

* paper size and orientation
* margins (mm)
* font size (pt). Leave it empty to follow the editor. Headings, code and tables scale with it. It overrides a font size set in the preset CSS.
* light theme, or follow the current light/dark mode
* page break before the selected heading levels

Per export: include the title image, keep folded blocks folded, include subdocuments (merged into one PDF).

Changes are saved automatically to `data/storage/petal/siyuan-print-pdf/config.json`.

## Notes

* Page numbers, headers and footers: turn on **More settings → Headers and footers** in Chrome's print dialog. Chrome does not support `@page` margin boxes, so CSS cannot draw them.
* `@page` rules and page breaks only take effect when printing, not in the preview.
* Wide tables are shrunk to the page width and their cells wrap.

## Development

```bash
pnpm i
pnpm run build   # writes dist/ and package.zip
```

Unzip `package.zip` into `{workspace}/data/plugins/siyuan-print-pdf/` to install a local build.

## License

MIT
