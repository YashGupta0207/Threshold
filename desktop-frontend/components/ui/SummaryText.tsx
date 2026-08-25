"use client";
import { Fragment } from "react";

/**
 * Minimal renderer for the markdown subset the summary prompt asks for:
 * `## headings`, `- bullets`, and paragraphs. Deliberately not a full markdown
 * parser -- pulling one in for four constructs would add a dependency to the
 * installer for no visible gain, and anything the model emits outside this
 * subset still renders readably as plain text.
 */
export default function SummaryText({ text }: { text: string }) {
  const lines = text.split("\n");
  const out: React.ReactNode[] = [];
  let bullets: string[] = [];

  const flushBullets = (key: string) => {
    if (bullets.length === 0) return;
    out.push(
      <ul key={key} className="mb-3 ml-4 list-disc space-y-1">
        {bullets.map((b, i) => (
          <li key={i} className="text-[13px] leading-relaxed text-slate-700">
            {renderInline(b)}
          </li>
        ))}
      </ul>,
    );
    bullets = [];
  };

  lines.forEach((raw, i) => {
    const line = raw.trim();

    if (/^#{1,6}\s/.test(line)) {
      flushBullets(`u${i}`);
      out.push(
        <h3
          key={`h${i}`}
          className="mb-1.5 mt-4 text-[11px] font-bold uppercase tracking-widest text-indigo-500 first:mt-0"
        >
          {line.replace(/^#{1,6}\s*/, "")}
        </h3>,
      );
      return;
    }

    if (/^[-*]\s+/.test(line)) {
      bullets.push(line.replace(/^[-*]\s+/, ""));
      return;
    }

    flushBullets(`u${i}`);
    if (line) {
      out.push(
        <p
          key={`p${i}`}
          className="mb-3 text-[13px] leading-relaxed text-slate-700"
        >
          {renderInline(line)}
        </p>,
      );
    }
  });

  flushBullets("uend");
  return <>{out}</>;
}

/** Bold **spans** only -- the one inline marker the prompt tends to produce. */
function renderInline(text: string): React.ReactNode {
  const parts = text.split(/(\*\*[^*]+\*\*)/g);
  return parts.map((p, i) =>
    p.startsWith("**") && p.endsWith("**") && p.length > 4 ? (
      <strong key={i} className="font-semibold text-slate-900">
        {p.slice(2, -2)}
      </strong>
    ) : (
      <Fragment key={i}>{p}</Fragment>
    ),
  );
}
