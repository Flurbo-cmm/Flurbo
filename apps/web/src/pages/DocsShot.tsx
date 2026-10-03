// A captioned screenshot for /docs. The images come from scripts/docs-screenshots.ts at twice the CSS size, so
// width and height are half the file's pixels: they reserve the space before the image loads.
export default function DocsShot({ src, alt, caption, width, height }: { src: string; alt: string; caption: string; width: number; height: number }) {
  return <figure className={'docs-shot' + (width < 600 ? ' docs-shot-narrow' : '')}>
    <img src={src} alt={alt} width={width} height={height} loading="lazy" decoding="async"/>
    <figcaption>{caption}</figcaption>
  </figure>;
}
