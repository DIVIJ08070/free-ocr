// Render each PDF page to a PNG buffer (pure JS — no Ghostscript/ImageMagick).

import { pdfToPng } from "pdf-to-png-converter";

export async function renderPdfToImages(buffer) {
  const pages = await pdfToPng(buffer, {
    viewportScale: 3.5, // ~250 DPI — good balance of OCR quality vs. speed
    outputFileMask: "page",
  });
  return pages.map((p) => p.content); // each .content is a PNG Buffer
}
