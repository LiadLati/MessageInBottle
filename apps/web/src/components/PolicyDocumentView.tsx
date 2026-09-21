import type { PolicyBlock, PolicyDocument } from '@mib/shared';

// Renders a legal document from its structured blocks: real headings and lists, English
// left-to-right, readable measure. The same content is served on the public web pages, so what
// a person reads in the App and what they read at the public URL are the same text.

function Block({ block }: { block: PolicyBlock }) {
  switch (block.type) {
    case 'h2':
      return <h2>{block.text}</h2>;
    case 'h3':
      return <h3>{block.text}</h3>;
    case 'p':
      return <p>{block.text}</p>;
    case 'ul':
      return (
        <ul>
          {block.items.map((item, i) => (
            <li key={i}>{item}</li>
          ))}
        </ul>
      );
    case 'ol':
      return (
        <ol>
          {block.items.map((item, i) => (
            <li key={i}>{item}</li>
          ))}
        </ol>
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
  return (
    <article className="policy-doc" lang={doc.lang} dir={doc.dir}>
      <header className="policy-doc-head">
        <h1 id={headingId} className="t-title">
          {doc.title}
        </h1>
        <p className="t-meta">
          Version {doc.version} · {doc.effective}
        </p>
      </header>
      <div className="policy-body">
        {doc.blocks.map((b, i) => (
          <Block key={i} block={b} />
        ))}
      </div>
    </article>
  );
}
