import { Fragment } from 'react';
import { openItemsOf, segmentsOf, type PolicyBlock, type PolicyDocument } from '@mib/shared';

// Renders one of the three documents from its structured blocks: real headings, lists and
// tables, right-to-left Hebrew, and every unresolved field as a highlighted "to be completed"
// mark that a screen reader announces as such. While the document is a draft a banner says
// so, in both languages, and lists the facts the text still depends on.

function Inline({ text }: { text: string }) {
  return (
    <>
      {segmentsOf(text).map((seg, i) =>
        seg.kind === 'open' ? (
          <mark key={i} className="policy-open" aria-label={`טרם הושלם: ${seg.text}`}>
            [{seg.text}]
          </mark>
        ) : (
          <Fragment key={i}>{seg.text}</Fragment>
        ),
      )}
    </>
  );
}

function Block({ block }: { block: PolicyBlock }) {
  switch (block.type) {
    case 'h2':
      return (
        <h2>
          <Inline text={block.text} />
        </h2>
      );
    case 'h3':
      return (
        <h3>
          <Inline text={block.text} />
        </h3>
      );
    case 'p':
      return (
        <p>
          <Inline text={block.text} />
        </p>
      );
    case 'ul':
      return (
        <ul>
          {block.items.map((item, i) => (
            <li key={i}>
              <Inline text={item} />
            </li>
          ))}
        </ul>
      );
    case 'ol':
      return (
        <ol>
          {block.items.map((item, i) => (
            <li key={i}>
              <Inline text={item} />
            </li>
          ))}
        </ol>
      );
    case 'table':
      return (
        <div className="policy-table-wrap">
          <table>
            <thead>
              <tr>
                {block.head.map((h, i) => (
                  <th key={i} scope="col">
                    <Inline text={h} />
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {block.rows.map((row, r) => (
                <tr key={r}>
                  {row.map((cell, c) =>
                    c === 0 ? (
                      <th key={c} scope="row">
                        <Inline text={cell} />
                      </th>
                    ) : (
                      <td key={c}>
                        <Inline text={cell} />
                      </td>
                    ),
                  )}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      );
  }
}

export function PolicyDocumentView({
  doc,
  headingId,
}: {
  doc: PolicyDocument;
  headingId?: string | undefined;
}) {
  const open = openItemsOf(doc);
  return (
    <article className="policy-doc" lang={doc.lang} dir={doc.dir}>
      <header className="policy-doc-head">
        <h1 id={headingId} className="t-title">
          {doc.titleHe}
        </h1>
        <p className="t-meta" dir="ltr" lang="en">
          {doc.title} · version {doc.version}
          {doc.effectiveAt ? ` · effective ${doc.effectiveAt}` : ' · not yet in force'}
        </p>
      </header>
      {doc.status === 'draft' ? (
        <aside className="note amber policy-draft" role="note" aria-label="Draft notice">
          <p>
            <strong>טיוטת עבודה — נוסח זה אינו סופי ואינו מחייב.</strong> הוא נבדק מול פעולת השירות
            בפועל, אך טרם עבר בדיקה משפטית, ו-{open.length} פרטים בו עדיין ממתינים להחלטה ומסומנים
            בגוף הטקסט.
          </p>
          <p dir="ltr" lang="en">
            <strong>Working draft — not final, not binding.</strong> Checked against what the
            service actually does, not yet legally reviewed; {open.length} field
            {open.length === 1 ? '' : 's'} still await a decision and are marked in the text.
          </p>
          {doc.dependsOn.length ? (
            <details dir="ltr" lang="en">
              <summary>Statements that depend on work not yet released</summary>
              <ul>
                {doc.dependsOn.map((d, i) => (
                  <li key={i}>{d}</li>
                ))}
              </ul>
            </details>
          ) : null}
        </aside>
      ) : null}
      <div className="policy-body">
        {doc.blocks.map((b, i) => (
          <Block key={i} block={b} />
        ))}
      </div>
    </article>
  );
}
