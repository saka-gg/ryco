// Vite emits these as local, versioned assets. Only resources requested by the
// current document are fetched; no PDF bytes or fonts go to an external viewer.
const assets = import.meta.glob<string>(
  [
    "/node_modules/pdfjs-dist/cmaps/*.bcmap",
    "/node_modules/pdfjs-dist/standard_fonts/*.{pfb,ttf}",
    "/node_modules/pdfjs-dist/wasm/*.wasm",
  ],
  { eager: true, query: "?url", import: "default" },
);
const directories: Record<string, string> = {
  cMapUrl: "cmaps",
  standardFontDataUrl: "standard_fonts",
  wasmUrl: "wasm",
};

export class PdfAttachmentBinaryDataFactory {
  async fetch({ kind, filename }: { kind: string; filename: string }): Promise<Uint8Array> {
    const url = assets[`/node_modules/pdfjs-dist/${directories[kind]}/${filename}`];
    if (!url) throw new Error("Unknown PDF rendering resource.");
    const response = await fetch(url);
    if (!response.ok) throw new Error("PDF rendering resource unavailable.");
    return new Uint8Array(await response.arrayBuffer());
  }
}
