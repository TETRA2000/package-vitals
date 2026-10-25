import MarkdownIt from 'markdown-it';

// Report text comes from untrusted repos. With raw HTML off and the link, image, and reference rules
// disabled, markdown-it (which escapes all text) can produce no script, img, a, or raw HTML.
const md = new MarkdownIt({ html: false, linkify: false, typographer: false })
  .disable(['image', 'link', 'autolink', 'reference', 'html_inline', 'html_block']);

// markdown-it aligns a table column with an inline `style="text-align:…"`, which the CSP (style-src 'self')
// blocks. Swap it for a class that styles.css styles.
md.core.ruler.push('table_align_classes', (state) => {
  for (const token of state.tokens) {
    if (token.type !== 'th_open' && token.type !== 'td_open') continue;
    const style = token.attrGet('style');
    if (style === null) continue;
    token.attrs = (token.attrs ?? []).filter(([name]) => name !== 'style');
    const align = /^text-align:(left|center|right)$/.exec(String(style))?.[1];
    if (align !== undefined) token.attrJoin('class', `align-${align}`);
  }
});

/** The only place in the app that sets innerHTML. */
export function Markdown({ source }: { source: string }) {
  return <article className="report" dangerouslySetInnerHTML={{ __html: md.render(source) }} />;
}
