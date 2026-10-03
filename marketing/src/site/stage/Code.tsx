/**
 * A tiny TypeScript line highlighter for the replica's diff and file views.
 * Colours approximate the app's dark syntax theme (see public/shots/files.png):
 * salmon keywords, violet calls, green strings, blue numbers.
 */
const RULES: Array<[RegExp, string]> = [
  [/^\/\/.*/, "#6b6b73"],
  [/^"(?:[^"\\]|\\.)*"|^'(?:[^'\\]|\\.)*'|^`(?:[^`\\]|\\.)*`/, "#9ecb7a"],
  [
    /^(?:export|function|const|let|return|private|if|import|from|await|async|new|this|interface|readonly|type)\b/,
    "#f08d7a",
  ],
  [/^\d[\d_]*(?:\.\d+)?/, "#7cb7ff"],
  [/^[A-Za-z_$][\w$]*(?=\()/, "#c3a6ff"],
  [/^[A-Z][A-Z_]+\b/, "#7cb7ff"],
  [/^[A-Za-z_$][\w$]*/, ""],
  [/^\s+/, ""],
  [/^./, "#a8a8b0"],
];

export function Code({ code }: { code: string }) {
  const out: React.ReactNode[] = [];
  let rest = code;
  let i = 0;
  while (rest.length) {
    for (const [re, color] of RULES) {
      const m = re.exec(rest);
      if (!m) continue;
      out.push(
        color ? (
          <span key={i++} style={{ color }}>
            {m[0]}
          </span>
        ) : (
          m[0]
        ),
      );
      rest = rest.slice(m[0].length);
      break;
    }
  }
  return <>{out}</>;
}
