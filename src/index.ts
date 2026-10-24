import {
    Dialog,
    fetchSyncPost,
    getFrontend,
    hideMessage,
    Plugin,
    showMessage,
} from "siyuan";
import "./index.scss";

const STORAGE = "config.json";
const PAPERS = ["A4", "A3", "A5", "B5", "Letter", "Legal"];
// Portrait sizes in mm, for the preset editor's page preview.
const PAPER_MM: Record<string, [number, number]> = {
    A4: [210, 297],
    A3: [297, 420],
    A5: [148, 210],
    B5: [176, 250],
    Letter: [215.9, 279.4],
    Legal: [215.9, 355.6],
};
// Strings the export page's renderers (mind maps, task lists, code copy) look up.
const LANG_KEYS = new Set([
    "copy",
    "mindmap",
    "fontSize",
    "bold",
    "italic",
    "colorFont",
    "color",
    "undo",
    "redo",
    "fold",
    "collapse",
    "expand",
    "fullscreen",
    "exitFullscreen",
    "zoomIn",
    "zoomOut",
    "delete",
    "close",
    "connect",
    "text",
    "task",
    "taskStatusTodo",
    "taskStatusInProgress",
    "taskStatusDone",
    "taskStatusCanceled",
    "customTaskStatus",
    "expandLevel",
    "expandAll",
    "foldAll",
    "htmlBlockError",
]);
// The renderers mutate the page while they work; printing starts after QUIET_MS without
// mutations, or after MAX_WAIT_MS whatever happens.
const QUIET_MS = 800;
const MAX_WAIT_MS = 20000;
const SAVE_DELAY_MS = 400;

interface PageSettings {
    paper: string;
    landscape: boolean;
    margins: number[]; // top right bottom left, mm
    fontSize: number; // pt; 0 follows the editor
    themeMode: "light" | "current";
    headingBreaks: number[];
}

interface Preset {
    id: string;
    name: string;
    base: "theme" | "daylight";
    css: string;
    page: PageSettings;
}

interface Config {
    presetId: string;
    // Per export, not per preset: what goes into the PDF.
    titleImage: boolean;
    keepFold: boolean;
    merge: boolean;
    presets: Preset[];
}

interface ExportDoc {
    name: string;
    content: string;
}

// Page settings travel with each preset.
const PAGE_DEFAULTS: PageSettings = {
    paper: "A4",
    landscape: false,
    margins: [15, 15, 15, 15],
    fontSize: 0,
    themeMode: "light",
    headingBreaks: [],
};

const CLEAN_CSS = `/* Clean print: serif body, black and white. #preview is the content container.
   The font size comes from the font size setting; headings scale with it in em. */
#preview {
  font-family: "Noto Serif CJK SC", "Source Han Serif SC", "Songti SC", Georgia, serif;
  line-height: 1.75;
  color: #111;
}
#preview .h1 { font-size: 1.8em; border-bottom: 1px solid #999; padding-bottom: .2em; }
#preview .h2 { font-size: 1.45em; }
#preview .h3 { font-size: 1.2em; }
#preview [data-type="NodeHeading"] { break-after: avoid; }
#preview .code-block, #preview table, #preview .img { break-inside: avoid; }
`;

const esc = (s: string) =>
    String(s).replace(/[&<>"]/g, (c) => ({"&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;"})[c]);
const errText = (e: unknown) => (e instanceof Error ? e.message : String(e));
const newId = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
const opt = (v: string, label: string, sel = false) =>
    `<option value="${esc(v)}"${sel ? " selected" : ""}>${esc(label)}</option>`;

export default class PrintPdfPlugin extends Plugin {
    private conf: Config;
    private saveTimer = 0;
    private lastSave = 0;
    private openDialogs = 0;
    private petalCss: string;

    private get tr() {
        return this.i18n as Record<string, string>;
    }

    async onload() {
        this.conf = this.normalize((await this.loadData(STORAGE)) || {});

        this.addCommand({
            langKey: "exportPdf",
            callback: () => {
                const id = this.currentDocId();
                if (id) {
                    this.openExportDialog(id);
                } else {
                    showMessage(this.tr.noDoc);
                }
            },
        });
        this.eventBus.on("click-editortitleicon", this.onTitleMenu);
        this.eventBus.on("open-menu-doctree", this.onTreeMenu);
    }

    onunload() {
        this.eventBus.off("click-editortitleicon", this.onTitleMenu);
        this.eventBus.off("open-menu-doctree", this.onTreeMenu);
        if (this.saveTimer) {
            this.saveNow();
        }
        document.getElementById("print-pdf-frame")?.remove();
    }

    // SiYuan reloads a plugin whose data files change, its own saveData included,
    // unless the plugin handles the change itself. A reload would leave open dialogs
    // writing into a dead instance. Our own writes are ignored; a change from another
    // device is read in when no dialog is open.
    async onDataChanged() {
        if (this.saveTimer || Date.now() - this.lastSave < 3000 || this.openDialogs > 0) {
            return;
        }
        this.conf = this.normalize((await this.loadData(STORAGE)) || {});
    }

    private onTitleMenu = ({detail}: CustomEvent) => {
        const id = detail.protyle?.block?.rootID;
        if (id) {
            detail.menu.addItem({
                icon: "iconPDF",
                label: this.tr.exportPdf,
                click: () => this.openExportDialog(id),
            });
        }
    };

    private onTreeMenu = ({detail}: CustomEvent) => {
        if (detail.type !== "doc") {
            return;
        }
        const id = detail.elements?.[0]?.getAttribute("data-node-id");
        if (id) {
            detail.menu.addItem({
                icon: "iconPDF",
                label: this.tr.exportPdf,
                click: () => this.openExportDialog(id),
            });
        }
    };

    private currentDocId(): string | null {
        const el = document.querySelector(".layout__wnd--active .protyle:not(.fn__none) .protyle-background") ||
            document.querySelector(".protyle:not(.fn__none) .protyle-background");
        return el?.getAttribute("data-node-id") || null;
    }

    private normalize(saved: Partial<Config>): Config {
        const defaults: Config = {
            presetId: "theme",
            titleImage: true,
            keepFold: false,
            merge: false,
            presets: [
                {id: "theme", name: this.tr.presetTheme, base: "theme", css: "", page: {...PAGE_DEFAULTS}},
                {
                    id: "clean",
                    name: this.tr.presetClean,
                    base: "daylight",
                    css: CLEAN_CSS,
                    page: {...PAGE_DEFAULTS, fontSize: 11},
                },
            ],
        };
        const conf: Config = {...defaults, ...saved};
        if (!Array.isArray(conf.presets) || conf.presets.length === 0) {
            conf.presets = defaults.presets;
        }
        conf.presets = conf.presets.map((p) => ({
            id: p.id || newId(),
            name: p.name || "",
            base: p.base === "daylight" ? "daylight" : "theme",
            css: p.css || "",
            page: {...PAGE_DEFAULTS, ...p.page},
        }));
        return conf;
    }

    // Every change is written to data/storage/petal/siyuan-print-pdf/config.json shortly
    // after it is made; there is no separate save step.
    private saveSoon() {
        clearTimeout(this.saveTimer);
        this.saveTimer = window.setTimeout(() => this.saveNow(), SAVE_DELAY_MS);
    }

    private async saveNow() {
        clearTimeout(this.saveTimer);
        this.saveTimer = 0;
        this.lastSave = Date.now();
        try {
            await this.saveData(STORAGE, this.conf);
            this.lastSave = Date.now();
        } catch (e) {
            console.error("[print-pdf] save failed", e);
            showMessage(`${this.tr.saveFailed}: ${errText(e)}`, 6000, "error");
        }
    }

    private preset(id = this.conf.presetId): Preset {
        return this.conf.presets.find((p) => p.id === id) || this.conf.presets[0];
    }

    // ---------- page settings form, shared by both dialogs ----------

    private pageFields(withBreaks: boolean) {
        const t = this.tr;
        const margin = (i: number, label: string) =>
            `<label class="print-pdf__margin">${label}<input class="b3-text-field" type="number" min="0" max="60" step="1" data-margin="${i}"></label>`;
        const levels = [1, 2, 3, 4, 5, 6].map((n) => `<label><input type="checkbox" value="${n}"> H${n}</label>`)
            .join("");
        return `<div class="print-pdf__page">
  <label class="fn__flex b3-label"><div class="fn__flex-1 fn__flex-center">${t.paper}</div><span class="fn__space"></span>
    <select data-f="paper" class="b3-select fn__flex-center">${
            PAPERS.map((p) => opt(p, p)).join("")
        }</select><span class="fn__space"></span>
    <select data-f="orient" class="b3-select fn__flex-center">${opt("0", t.portrait)}${
            opt("1", t.landscape)
        }</select></label>
  <div class="b3-label"><div>${t.margins}</div><div class="fn__hr"></div>
    <div class="fn__flex print-pdf__margins">${margin(0, t.top)}${margin(1, t.right)}${margin(2, t.bottom)}${
            margin(3, t.left)
        }</div></div>
  <label class="fn__flex b3-label"><div class="fn__flex-1 fn__flex-center">${t.fontSize}<div class="b3-label__text">${t.fontSizeTip}</div></div><span class="fn__space"></span>
    <input data-f="fontSize" class="b3-text-field fn__flex-center print-pdf__num" type="number" min="6" max="40" step="0.5" placeholder="${t.fontFollow}"></label>
  <label class="fn__flex b3-label"><div class="fn__flex-1 fn__flex-center">${t.themeMode}<div class="b3-label__text">${t.themeModeTip}</div></div><span class="fn__space"></span>
    <select data-f="themeMode" class="b3-select fn__flex-center">${opt("light", t.modeLight)}${
            opt("current", t.modeCurrent)
        }</select></label>
  ${
            withBreaks ?
                `<div class="b3-label"><div>${t.headingBreaks}</div><div class="b3-label__text">${t.headingBreaksTip}</div><div class="fn__hr"></div>
    <div class="fn__flex print-pdf__levels">${levels}</div></div>` :
                ""
        }
</div>`;
    }

    private fillPage(root: HTMLElement, page: PageSettings) {
        root.querySelector<HTMLSelectElement>('[data-f="paper"]').value = page.paper;
        root.querySelector<HTMLSelectElement>('[data-f="orient"]').value = page.landscape ? "1" : "0";
        root.querySelectorAll<HTMLInputElement>("[data-margin]").forEach((i) => {
            i.value = String(page.margins[Number(i.dataset.margin)]);
        });
        root.querySelector<HTMLInputElement>('[data-f="fontSize"]').value = page.fontSize ? String(page.fontSize) : "";
        root.querySelector<HTMLSelectElement>('[data-f="themeMode"]').value = page.themeMode;
        root.querySelectorAll<HTMLInputElement>(".print-pdf__levels input").forEach((i) => {
            i.checked = page.headingBreaks.includes(Number(i.value));
        });
    }

    private readPage(root: HTMLElement, page: PageSettings) {
        page.paper = root.querySelector<HTMLSelectElement>('[data-f="paper"]').value;
        page.landscape = root.querySelector<HTMLSelectElement>('[data-f="orient"]').value === "1";
        page.margins = [...root.querySelectorAll<HTMLInputElement>("[data-margin]")].map((i) =>
            Math.min(60, Math.max(0, Number(i.value) || 0))
        );
        const fs = Number(root.querySelector<HTMLInputElement>('[data-f="fontSize"]').value);
        page.fontSize = fs > 0 ? Math.min(40, Math.max(6, fs)) : 0;
        page.themeMode = root.querySelector<HTMLSelectElement>('[data-f="themeMode"]').value === "current" ?
            "current" :
            "light";
        const levels = root.querySelectorAll<HTMLInputElement>(".print-pdf__levels input");
        if (levels.length) {
            page.headingBreaks = [...levels].filter((i) => i.checked).map((i) => Number(i.value));
        }
    }

    // ---------- export dialog ----------

    private openExportDialog(docId: string) {
        const t = this.tr;
        const c = this.conf;
        const row = (label: string, control: string) =>
            `<label class="fn__flex b3-label"><div class="fn__flex-1 fn__flex-center">${label}</div><span class="fn__space"></span>${control}</label>`;
        const sw = (id: string, on: boolean) =>
            `<input id="${id}" class="b3-switch fn__flex-center" type="checkbox"${on ? " checked" : ""}>`;

        const dialog = new Dialog({
            title: t.exportPdf,
            width: "520px",
            content: `<div class="b3-dialog__content print-pdf__form">
  ${
                row(
                    t.preset,
                    `<select id="pp-preset" class="b3-select fn__flex-center"></select><span class="fn__space"></span><button id="pp-edit" class="b3-button b3-button--outline fn__flex-center">${t.editPresets}</button>`,
                )
            }
  <div class="b3-label__text print-pdf__hint">${t.presetPageTip}</div>
  ${this.pageFields(true)}
  ${row(t.titleImage, sw("pp-title-image", c.titleImage))}
  ${row(t.keepFold, sw("pp-keep-fold", c.keepFold))}
  ${row(`${t.merge}<div class="b3-label__text">${t.mergeTip}</div>`, sw("pp-merge", c.merge))}
</div>
<div class="b3-dialog__action">
  <button class="b3-button b3-button--cancel">${t.close}</button><div class="fn__space"></div>
  <button class="b3-button b3-button--text" id="pp-go">${t.export}</button>
</div>`,
            destroyCallback: () => {
                this.openDialogs--;
                this.saveNow();
            },
        });
        this.openDialogs++;
        const el = dialog.element;
        const $ = <T extends HTMLElement = HTMLElement>(s: string) => el.querySelector<T>(s);
        const pageRoot = $(".print-pdf__page");

        const refresh = () => {
            $("#pp-preset").innerHTML = c.presets.map((p) => opt(p.id, p.name, p.id === this.preset().id)).join("");
            this.fillPage(pageRoot, this.preset().page);
        };
        refresh();

        const read = () => {
            this.readPage(pageRoot, this.preset().page);
            c.titleImage = $<HTMLInputElement>("#pp-title-image").checked;
            c.keepFold = $<HTMLInputElement>("#pp-keep-fold").checked;
            c.merge = $<HTMLInputElement>("#pp-merge").checked;
        };

        $("#pp-preset").addEventListener("change", () => {
            c.presetId = $<HTMLSelectElement>("#pp-preset").value;
            this.fillPage(pageRoot, this.preset().page);
            this.saveSoon();
        });
        pageRoot.addEventListener("change", () => {
            read();
            this.saveSoon();
        });
        el.querySelectorAll(".b3-switch").forEach((s) =>
            s.addEventListener("change", () => {
                read();
                this.saveSoon();
            })
        );

        $(".b3-button--cancel").addEventListener("click", () => dialog.destroy());
        $("#pp-edit").addEventListener("click", () => {
            read();
            this.openPresetEditor(docId, refresh);
        });
        $("#pp-go").addEventListener("click", async () => {
            read();
            dialog.destroy();
            try {
                await this.print(docId);
            } catch (e) {
                console.error("[print-pdf]", e);
                showMessage(`${t.failed}: ${errText(e)}`, 6000, "error");
            }
        });
    }

    // ---------- building the export page ----------

    private async fetchDoc(docId: string): Promise<ExportDoc> {
        const c = this.conf;
        // SiYuan's own print sends pdf and excludeTitleImage too, but the generated request
        // type omits them, so the call goes through the untyped signature.
        const url: string = "/api/export/exportPreviewHTML";
        const res = await fetchSyncPost(url, {
            id: docId,
            pdf: true,
            excludeTitleImage: !c.titleImage,
            keepFold: c.keepFold,
            merge: c.merge,
        });
        if (res.code !== 0) {
            throw new Error(res.msg || "exportPreviewHTML");
        }
        // The kernel marks headings with pdf-outline:// links for Electron's PDF outline;
        // in a browser print they would end up as dead links. Hidden iframes never load
        // lazy images, so every image loads eagerly.
        const tpl = document.createElement("template");
        tpl.innerHTML = res.data.content;
        tpl.content.querySelectorAll('a[href^="pdf-outline://"]').forEach((a) => a.remove());
        tpl.content.querySelectorAll('img[loading="lazy"]').forEach((img) => img.setAttribute("loading", "eager"));
        return {name: res.data.name, content: tpl.innerHTML};
    }

    private async sharedCss() {
        if (this.petalCss === undefined) {
            const res = await fetchSyncPost("/api/petal/loadPetals", {frontend: getFrontend()});
            const petals: {css?: string;}[] = res.code === 0 && Array.isArray(res.data) ? res.data : [];
            this.petalCss = petals.map((p) => p.css || "").join("\n");
        }
        return this.petalCss;
    }

    private pageCss(page: PageSettings) {
        const [t, r, b, l] = page.margins;
        return `@page { size: ${page.paper} ${
            page.landscape ? "landscape" : "portrait"
        }; margin: ${t}mm ${r}mm ${b}mm ${l}mm; }
html, body { -webkit-print-color-adjust: exact; print-color-adjust: exact; }
body { margin: 0; }
#preview { max-width: none !important; margin: 0 !important; padding: 0 !important; }
/* Tables are max-content wide in a scroll box on screen; paper has no scrolling. */
#preview .table > div:first-child { overflow: visible !important; }
#preview .table table { display: table !important; width: auto !important; max-width: 100% !important; }
#preview .table td, #preview .table th { white-space: normal !important; overflow-wrap: anywhere; }
#preview .table tr, #preview img { break-inside: avoid; }`;
    }

    // On screen (the preset editor) the body is drawn as one paper-width sheet.
    private previewCss(page: PageSettings) {
        let [w, h] = PAPER_MM[page.paper] || PAPER_MM.A4;
        if (page.landscape) {
            [w, h] = [h, w];
        }
        const [t, r, b, l] = page.margins;
        return `@media screen {
  html { background: #8a8a8a; }
  body { box-sizing: border-box; width: ${w}mm; min-height: ${h}mm; margin: 16px auto !important; padding: ${t}mm ${r}mm ${b}mm ${l}mm; box-shadow: 0 2px 14px rgba(0,0,0,.35); }
}`;
    }

    // Everything in protyle is sized in em from --b3-font-size-editor, so overriding it
    // scales headings, code and tables together. It comes after the user CSS: a font
    // size set here wins over one in the CSS.
    private fontCss(page: PageSettings) {
        if (!page.fontSize) {
            return "";
        }
        return `#preview { --b3-font-size-editor: ${page.fontSize}pt; font-size: ${page.fontSize}pt !important; }`;
    }

    private async buildHtml(doc: ExportDoc, preset: Preset, forPreview: boolean) {
        const page = preset.page;
        const siyuan = window.siyuan as any;
        const ap = siyuan.config.appearance;
        const ed = siyuan.config.editor;
        const ver = siyuan.config.system.kernelVersion;
        const base = `${location.protocol}//${location.host}/`;
        const useTheme = preset.base === "theme";
        const dark = useTheme && page.themeMode === "current" && ap.mode === 1;
        const theme = useTheme ? (dark ? ap.themeDark : ap.themeLight) : "daylight";

        // Fonts and editor variables SiYuan computes at runtime; snippet and plugin CSS
        // only go with the user's theme, a custom preset starts from plain daylight.
        const inline = document.getElementById("siyuanStyle")?.textContent || "";
        let extra = "";
        if (useTheme) {
            document.querySelectorAll('style[id^="snippetCSS"]').forEach((s) => (extra += s.outerHTML));
            extra += `<style>${await this.sharedCss()}</style>`;
        }
        const icons = (ap.icon === "litheness" ?
            "" :
            `<script src="${base}appearance/icons/litheness/icon.js?v=${ver}"><\/script>`) +
            `<script src="${base}appearance/icons/${ap.icon}/icon.js?v=${ver}"><\/script>`;
        // U+2028/2029 are legal in JSON but end a line in a script.
        const languages = JSON.stringify(Object.fromEntries(
            Object.entries(siyuan.languages).filter(([k]: [string, unknown]) =>
                LANG_KEYS.has(k) || k.startsWith("listMindmap")
            ),
        ))
            .replace(/</g, "\\u003c")
            .replace(new RegExp("[\\u2028\\u2029]", "g"), (ch) => "\\u" + ch.charCodeAt(0).toString(16));
        const wysiwygClass = "protyle-wysiwyg" + (ed.displayBookmarkIcon ? " protyle-wysiwyg--attr" : "");

        return `<!DOCTYPE html>
<html lang="${ap.lang}" data-theme-mode="${
            dark ? "dark" : "light"
        }" data-light-theme="${ap.themeLight}" data-dark-theme="${ap.themeDark}">
<head>
<base href="${base}">
<meta charset="utf-8">
<link rel="stylesheet" href="${base}stage/build/export/base.css?v=${ver}">
<link rel="stylesheet" href="${base}appearance/themes/${theme}/theme.css?v=${ver}">
<!-- <protyle-html> reads window.siyuan as soon as each HTML block is parsed. -->
<script>
window.siyuan = {
  config: {
    appearance: { mode: ${
            dark ? 1 : 0
        }, codeBlockThemeDark: "${ap.codeBlockThemeDark}", codeBlockThemeLight: "${ap.codeBlockThemeLight}" },
    editor: {
      codeLineWrap: true,
      fontSize: ${ed.fontSize},
      codeLigatures: ${ed.codeLigatures},
      plantUMLServePath: "${ed.plantUMLServePath}",
      codeSyntaxHighlightLineNum: ${ed.codeSyntaxHighlightLineNum},
      allowHTMLBLockScript: ${!!ed.allowHTMLBLockScript},
      katexMacros: decodeURI(\`${encodeURI(ed.katexMacros)}\`),
    }
  },
  languages: ${languages}
};
<\/script>
<script src="${base}stage/protyle/js/protyle-html.js?v=${ver}"><\/script>
<title>${esc(doc.name)}</title>
<style>
body {font-family: var(--b3-font-family);background-color: var(--b3-theme-background);color: var(--b3-theme-on-background)}
${inline}
</style>
${extra}
<style id="print-pdf-page">${this.pageCss(page)}${forPreview ? "\n" + this.previewCss(page) : ""}</style>
<style id="print-pdf-user">${preset.css}</style>
<style id="print-pdf-font">${this.fontCss(page)}</style>
</head>
<body>
<div class="${wysiwygClass}" style="max-width: 800px;margin: 0 auto;" id="preview">${doc.content}</div>
${icons}
<script src="${base}stage/build/export/protyle-method.js?v=${ver}"><\/script>
<script src="${base}stage/protyle/js/lute/lute.min.js?v=${ver}"><\/script>
<script>
const previewElement = document.getElementById("preview");
Protyle.highlightRender(previewElement, "stage/protyle");
Protyle.setAutoDirection(previewElement, ${!!ed.autoDirection});
Protyle.mathRender(previewElement, "stage/protyle", true);
Protyle.mermaidRender(previewElement, "stage/protyle");
Protyle.flowchartRender(previewElement, "stage/protyle");
Protyle.graphvizRender(previewElement, "stage/protyle");
Protyle.chartRender(previewElement, "stage/protyle");
Protyle.mindmapRender(previewElement, "stage/protyle");
Protyle.abcRender(previewElement, "stage/protyle");
Protyle.htmlRender(previewElement);
Protyle.plantumlRender(previewElement, "stage/protyle");
Protyle.applyExportHeadingPageBreaks(previewElement, ${JSON.stringify(page.headingBreaks)});
<\/script>
</body></html>`;
    }

    // ---------- printing ----------

    private async print(docId: string) {
        const t = this.tr;
        await this.saveNow();
        showMessage(t.preparing, -1, "info", "print-pdf");
        try {
            const doc = await this.fetchDoc(docId);
            const html = await this.buildHtml(doc, this.preset(), false);
            document.getElementById("print-pdf-frame")?.remove();
            const frame = document.createElement("iframe");
            frame.id = "print-pdf-frame";
            // Off screen but laid out at a real width, so renderers measure correctly.
            frame.style.cssText =
                "position:fixed;left:-10000px;top:0;width:210mm;height:297mm;border:0;opacity:0;pointer-events:none;";
            const loaded = new Promise((resolve) => (frame.onload = resolve));
            frame.srcdoc = html;
            document.body.appendChild(frame);
            await loaded;
            const win = frame.contentWindow;
            await waitForRender(win);

            // Chrome names the file after the top document's title.
            const oldTitle = document.title;
            document.title = doc.name;
            const cleanup = () => {
                document.title = oldTitle;
                frame.remove();
            };
            win.addEventListener("afterprint", () => setTimeout(cleanup, 0), {once: true});
            showMessage(t.ready, 2000, "info", "print-pdf");
            win.focus();
            win.print();
        } catch (e) {
            hideMessage("print-pdf");
            throw e;
        }
    }

    // ---------- preset editor ----------

    private openPresetEditor(docId: string, onClose?: () => void) {
        const t = this.tr;
        const c = this.conf;
        let current = this.preset();
        let doc: ExportDoc = null;
        let resizeObserver: ResizeObserver = null;

        const dialog = new Dialog({
            title: t.editPresets,
            width: "94vw",
            height: "88vh",
            content: `<div class="print-pdf__editor">
  <div class="print-pdf__side">
    <div class="fn__flex">
      <select class="b3-select fn__flex-1" id="pe-list"></select>
    </div>
    <div class="fn__hr"></div>
    <div class="fn__flex print-pdf__btns">
      <button class="b3-button b3-button--outline" id="pe-new">${t.newPreset}</button>
      <button class="b3-button b3-button--outline" id="pe-dup">${t.duplicate}</button>
      <button class="b3-button b3-button--outline" id="pe-del">${t.delete}</button>
    </div>
    <div class="fn__hr"></div>
    <input class="b3-text-field fn__block" id="pe-name" placeholder="${t.presetName}">
    <div class="fn__hr"></div>
    <label class="fn__flex"><span class="fn__flex-1 fn__flex-center">${t.base}</span>
      <select class="b3-select" id="pe-base">${opt("theme", t.baseTheme)}${
                opt("daylight", t.baseDaylight)
            }</select></label>
    <details class="print-pdf__details" open><summary>${t.pageSettings}</summary>${this.pageFields(false)}</details>
    <textarea class="b3-text-field print-pdf__css" id="pe-css" spellcheck="false" placeholder="${t.cssPlaceholder}"></textarea>
    <div class="b3-label__text">${t.cssTip}</div>
  </div>
  <div class="print-pdf__preview"><iframe id="pe-frame"></iframe><div class="print-pdf__loading" id="pe-loading">${t.loading}</div></div>
</div>
<div class="b3-dialog__action">
  <span class="b3-label__text fn__flex-1 fn__flex-center">${t.autoSaved}</span>
  <button class="b3-button b3-button--text" id="pe-done">${t.done}</button>
</div>`,
            destroyCallback: () => {
                this.openDialogs--;
                resizeObserver?.disconnect();
                c.presets.forEach((p) => (p.name = p.name.trim() || t.untitled));
                this.saveNow();
                onClose?.();
            },
        });
        this.openDialogs++;
        const el = dialog.element;
        const $ = <T extends HTMLElement = HTMLElement>(s: string) => el.querySelector<T>(s);
        const frame = $<HTMLIFrameElement>("#pe-frame");
        const loading = $("#pe-loading");
        const css = $<HTMLTextAreaElement>("#pe-css");
        const pageRoot = $(".print-pdf__page");

        const fillList = () => {
            $("#pe-list").innerHTML = c.presets.map((p) => opt(p.id, p.name, p === current)).join("");
            $<HTMLInputElement>("#pe-name").value = current.name;
            $<HTMLSelectElement>("#pe-base").value = current.base;
            css.value = current.css;
            $<HTMLButtonElement>("#pe-del").disabled = c.presets.length < 2;
            this.fillPage(pageRoot, current.page);
        };

        let renderSeq = 0;
        const render = async () => {
            const seq = ++renderSeq;
            loading.textContent = t.loading;
            loading.classList.remove("fn__none");
            try {
                doc ||= await this.fetchDoc(docId);
                const html = await this.buildHtml(doc, current, true);
                if (seq !== renderSeq) {
                    return;
                }
                frame.onload = () => {
                    fit();
                    if (seq === renderSeq) {
                        loading.classList.add("fn__none");
                    }
                };
                frame.srcdoc = html;
            } catch (e) {
                loading.textContent = `${t.failed}: ${errText(e)}`;
            }
        };
        // CSS, font size, paper and margins go straight into the loaded page; only a
        // change of base style or theme mode reloads it.
        const restyle = () => {
            const d = frame.contentDocument;
            if (!d?.getElementById("print-pdf-user")) {
                return;
            }
            d.getElementById("print-pdf-user").textContent = current.css;
            d.getElementById("print-pdf-font").textContent = this.fontCss(current.page);
            d.getElementById("print-pdf-page").textContent = this.pageCss(current.page) + "\n" +
                this.previewCss(current.page);
            fit();
        };
        // Scale the sheet down when the pane is narrower than the paper, so the
        // whole page width stays visible.
        const fit = () => {
            const d = frame.contentDocument;
            if (!d?.documentElement) {
                return;
            }
            const [w, h] = PAPER_MM[current.page.paper] || PAPER_MM.A4;
            const sheetPx = ((current.page.landscape ? h : w) * 96) / 25.4 + 32;
            d.documentElement.style.zoom = String(Math.min(1, frame.clientWidth / sheetPx));
        };
        resizeObserver = new ResizeObserver(fit);
        resizeObserver.observe(frame);
        const select = (p: Preset) => {
            current = p;
            c.presetId = p.id;
            fillList();
            render();
            this.saveSoon();
        };

        let cssTimer = 0;
        css.addEventListener("input", () => {
            current.css = css.value;
            clearTimeout(cssTimer);
            cssTimer = window.setTimeout(restyle, 250);
            this.saveSoon();
        });
        css.addEventListener("keydown", (e) => {
            e.stopPropagation(); // keep SiYuan hotkeys out of the editor
            if (e.key !== "Tab" || e.shiftKey) {
                return;
            }
            e.preventDefault();
            css.setRangeText("  ", css.selectionStart, css.selectionEnd, "end");
            css.dispatchEvent(new Event("input"));
        });
        pageRoot.addEventListener("input", () => {
            const mode = current.page.themeMode;
            this.readPage(pageRoot, current.page);
            if (current.page.themeMode !== mode) {
                render();
            } else {
                restyle();
            }
            this.saveSoon();
        });
        $<HTMLInputElement>("#pe-name").addEventListener("input", (e) => {
            current.name = (e.target as HTMLInputElement).value;
            $<HTMLSelectElement>("#pe-list").selectedOptions[0].textContent = current.name;
            this.saveSoon();
        });
        $<HTMLSelectElement>("#pe-base").addEventListener("change", (e) => {
            current.base = (e.target as HTMLSelectElement).value === "daylight" ? "daylight" : "theme";
            render();
            this.saveSoon();
        });
        $<HTMLSelectElement>("#pe-list").addEventListener("change", (e) => {
            select(c.presets.find((p) => p.id === (e.target as HTMLSelectElement).value));
        });
        const add = (p: Preset) => {
            c.presets.push(p);
            select(p);
            $<HTMLInputElement>("#pe-name").select();
        };
        $("#pe-new").addEventListener("click", () => {
            add({id: newId(), name: t.newPreset, base: "daylight", css: "", page: {...PAGE_DEFAULTS}});
        });
        $("#pe-dup").addEventListener("click", () => {
            add({...structuredClone(current), id: newId(), name: `${current.name} ${t.copySuffix}`});
        });
        $("#pe-del").addEventListener("click", () => {
            if (c.presets.length < 2) {
                return;
            }
            c.presets.splice(c.presets.indexOf(current), 1);
            select(c.presets[0]);
        });
        $("#pe-done").addEventListener("click", () => dialog.destroy());

        fillList();
        render();
    }
}

// Resolves once the export page's fonts and images are in and its renderers
// (math, mermaid, charts...) have stopped changing the DOM.
async function waitForRender(win: Window) {
    const doc = win.document;
    await new Promise<void>((resolve) => {
        let timer = 0;
        const observer = new MutationObserver(() => {
            clearTimeout(timer);
            timer = window.setTimeout(done, QUIET_MS);
        });
        const cap = window.setTimeout(() => done(), MAX_WAIT_MS);
        function done() {
            observer.disconnect();
            clearTimeout(timer);
            clearTimeout(cap);
            resolve();
        }
        observer.observe(doc.body, {subtree: true, childList: true, attributes: true, characterData: true});
        timer = window.setTimeout(done, QUIET_MS);
    });
    await doc.fonts.ready;
    await Promise.all(
        [...doc.images].filter((img) => !img.complete).map((img) =>
            new Promise((r) => {
                img.addEventListener("load", r, {once: true});
                img.addEventListener("error", r, {once: true});
            })
        ),
    );
}
