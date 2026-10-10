// Builds a small valid PDF: one Helvetica font, one content stream per page, a correct xref table and trailer.
export function minimalPdf(pages: string[][]): Buffer {
  const escape = (text: string) => text.replace(/[\\()]/g, '\\$&');
  const objects: string[] = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    `<< /Type /Pages /Kids [${pages.map((_, index) => `${4 + 2 * index} 0 R`).join(' ')}] /Count ${pages.length} >>`,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
  ];
  pages.forEach((lines, index) => {
    objects.push(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 3 0 R >> >> /Contents ${5 + 2 * index} 0 R >>`);
    const stream = `BT /F1 12 Tf 72 720 Td 14 TL ${lines.map(line => `(${escape(line)}) '`).join(' ')} ET`;
    objects.push(`<< /Length ${Buffer.byteLength(stream)} >>\nstream\n${stream}\nendstream`);
  });
  let out = '%PDF-1.4\n';
  const offsets: number[] = [];
  objects.forEach((body, index) => { offsets.push(Buffer.byteLength(out)); out += `${index + 1} 0 obj\n${body}\nendobj\n`; });
  const xref = Buffer.byteLength(out);
  out += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets.map(offset => `${String(offset).padStart(10, '0')} 00000 n \n`).join('')}`;
  out += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(out, 'latin1');
}
