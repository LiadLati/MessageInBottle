import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';

// Manual review round 1, item 7: user-facing English copy does not join sentences with a
// semicolon — it read like generated code. Scans every string, template and JSX text in the web
// app's source (never code syntax: CSS inside a string is recognised and skipped).

function copyIn(file: string): string[] {
  const src = readFileSync(file, 'utf8');
  const sf = ts.createSourceFile(file, src, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const found: string[] = [];
  const visit = (n: ts.Node) => {
    let text: string | null = null;
    if (ts.isStringLiteral(n) || ts.isNoSubstitutionTemplateLiteral(n)) text = n.text;
    else if (ts.isTemplateExpression(n))
      text = n.head.text + n.templateSpans.map((s) => ` ${s.literal.text}`).join('');
    else if (ts.isJsxText(n)) text = n.text;
    // HTML entities (&amp;) are markup, not punctuation.
    if (text) text = text.replace(/&[a-z]+;/g, '&');
    if (text && /[A-Za-z’'")]; +[A-Za-z]|[a-z]; *$/.test(text) && !/[\w-]+:\s*[^;]+;/.test(text))
      found.push(`${file}: ${text.trim().slice(0, 80)}`);
    ts.forEachChild(n, visit);
  };
  visit(sf);
  return found;
}

describe('user-facing copy', () => {
  it('never joins sentences with a semicolon', () => {
    const offenders: string[] = [];
    const walk = (dir: string) => {
      for (const name of readdirSync(dir)) {
        const path = join(dir, name);
        if (statSync(path).isDirectory()) walk(path);
        else if (/\.tsx?$/.test(name) && !/\.test\.tsx?$/.test(name))
          offenders.push(...copyIn(path));
      }
    };
    walk(join(__dirname, '..'));
    expect(offenders).toEqual([]);
  });
});
