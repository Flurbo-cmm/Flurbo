# Official archived captures

These JSON envelopes contain complete HTML responses fetched directly from official BLS and Federal Reserve URLs during September 2026. Each includes requested/final URL, retrieval time, response status/content type, UTF-8 bytes, SHA-256 and raw body. They are retrospective parser fixtures, not contemporaneous 2025 evidence and not forecast inputs.

`bls-november-2025.json` is the December 16, 2025 initial Employment Situation archive. `fed-december-2025.json` and `fed-october-2025.json` are the dated FOMC statements. Government publication dates and measured values are extracted from the captured bodies. Transport Last-Modified is not used as a publication date.

No historical correction, cancellation or dispute has been fabricated into these sources. Exceptional-path records in the unit tests are explicitly synthetic.
