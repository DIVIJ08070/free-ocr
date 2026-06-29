# Indian ID OCR — Web Service (Node.js)

Offline OCR HTTP service for Indian ID documents. **100% local** — no cloud OCR,
no API keys, no per-call cost. OCR runs in-process via `tesseract.js` (WebAssembly),
so you do **not** need to install the Tesseract engine separately.

Pipeline: upload (image/PDF) → `sharp` cleanup → `tesseract.js` read →
regex + checksum extract → JSON.

**Supported:** PAN, Aadhaar (with Verhoeff checksum), Voter ID (EPIC),
Driving License, Passport.

## Setup

```bash
cd id-ocr-service
npm install      # downloads sharp + tesseract.js wasm/lang data (one time)
npm start        # listens on http://localhost:3001
```

Requires Node.js >= 18.18. No system packages needed.

## API

### `POST /ocr`
Multipart form-data upload. Field name **`files`** — send one or many images/PDFs.
Optional query `?raw=1` includes the raw OCR text per page.

```bash
# single image
curl -F "files=@card.jpg" http://localhost:3001/ocr

# multiple files at once (mixed images + PDFs)
curl -F "files=@pan.jpg" -F "files=@scan.pdf" http://localhost:3001/ocr

# include raw OCR text (useful for tuning regex on failed extractions)
curl -F "files=@card.jpg" "http://localhost:3001/ocr?raw=1"
```

Response — a JSON array, one record per page/file:

```json
[
  {
    "document_type": "PAN",
    "name": "RAMESH KUMAR",
    "dob": "01/01/1990",
    "gender": null,
    "pan_number": "ABCDE1234F",
    "source_file": "card.jpg",
    "page": "page_1"
  }
]
```

Per-file failures don't fail the whole request — they come back as
`{ "source_file": "...", "error": "..." }` in the array.

### `GET /health`
Returns `{ "status": "ok" }`.

## Configuration

| Env var       | Default | Meaning                                  |
| ------------- | ------- | ---------------------------------------- |
| `PORT`        | `3001`  | HTTP port                                |
| `OCR_WORKERS` | `2`     | Tesseract worker pool size (concurrency) |

## How it works / accuracy notes

- **Both inputs handled.** PDFs are rendered per-page to PNG (pure JS, no
  Ghostscript), images are read directly.
- **Multi-variant preprocessing.** Each page is OCR'd three ways — global
  threshold (clean scans), CLAHE local contrast (phone photos / uneven light),
  and plain normalized grayscale — keeping whichever reading detects a valid ID.
- **ID numbers are reliable** because formats are strict; Aadhaar additionally
  passes a Verhoeff checksum, so false positives are rare.
- **Driving License** formats vary by state — that regex is the most likely to
  need tuning against your real samples.
- **Name is the weakest field.** Treat it as "verify me" rather than trusting it
  blindly; consider a human-correction step where accurate names matter.

## Adding a new document type

Add one entry to `DOC_TYPES` in `src/extract.js` with its keywords, output field
name, and an extractor function — no other changes needed.

## ⚠️ Handling sensitive data

This processes Aadhaar / PAN and similar regulated identifiers. Keep uploads and
any stored JSON local and secured; the no-cloud design already supports this, but
storage, retention, and access are your responsibility.
