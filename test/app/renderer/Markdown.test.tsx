import { render } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { Markdown } from '../../../src/app/renderer/components/Markdown.js';

describe('Markdown', () => {
  it('renders headings and tables', () => {
    const { container } = render(<Markdown source={'# Title\n\n| a | b |\n|---|---|\n| 1 | 2 |\n'} />);
    expect(container.querySelector('article.report h1')).toHaveTextContent('Title');
    expect(container.querySelectorAll('table th')).toHaveLength(2);
    expect(container.querySelector('td')).toHaveTextContent('1');
  });

  it('never produces script, images, links, or raw HTML', () => {
    const source = [
      '<script>window.x=1</script>',
      '',
      '<img src=x onerror=alert(1)>',
      '',
      '![i](https://evil.example/i.png)',
      '',
      '[click](javascript:alert(1))',
      '',
      '<https://evil.example>',
      '',
      '[r]: https://evil.example',
    ].join('\n');
    const { container } = render(<Markdown source={source} />);
    expect(container.querySelector('script, img, a, iframe')).toBeNull();
    expect(container.textContent).toContain('<img src=x onerror=alert(1)>');
    expect(container.textContent).toContain('[click](javascript:alert(1))');
  });

  it('shows escaped report text literally', () => {
    const { container } = render(<Markdown source={'\\_\\_proto\\_\\_'} />);
    expect(container.querySelector('article')).toHaveTextContent('__proto__');
  });
});
