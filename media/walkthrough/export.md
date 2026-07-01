## Export your document

Run **Markdown: Export to File** from the Command Palette — or right-click an editor / a workspace folder and choose **Export Markdown to File** — then pick a format:

- **Self-contained HTML** — a single file with styles and images embedded.
- **PDF / PNG / JPEG** — rendered with a bundled Chromium. On first use it is downloaded once, with your consent, and reused afterwards.

When it finishes, use **Open** to view the file in your default app, or **Reveal** to show it in your file manager. Exports land in the `out/` folder by default.

**Per-file overrides** — set page options in the document's YAML front matter:

```
---
puppeteer:
    pdf:
        format: A4
        margin: { top: 1.5cm, bottom: 1cm }
---
```
