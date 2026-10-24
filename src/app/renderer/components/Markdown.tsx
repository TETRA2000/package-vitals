import MarkdownIt from 'markdown-it';

// Report text comes from untrusted repos. With raw HTML off and the link, image, and reference rules
// disabled, markdown-it (which escapes all text) can produce no script, img, a, or raw HTML.
const md = new MarkdownIt({ html: false, linkify: false, typographer: false })
  .disable(['image', 'link', 'autolink', 'reference', 'html_inline', 'html_block']);

/** The only place in the app that sets innerHTML. */
export function Markdown({ source }: { source: string }) {
  return <article className="report" dangerouslySetInnerHTML={{ __html: md.render(source) }} />;
}
