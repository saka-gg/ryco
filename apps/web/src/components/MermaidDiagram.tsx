import { useEffect, useRef, useState, type ReactNode } from "react";
import { cachedMermaid, renderMermaid, type MermaidTheme } from "../lib/mermaidRenderer";

/** Parent keys by theme/source so async results never cross message generations. */
export function MermaidDiagram({
  source,
  theme,
  fallback,
}: {
  source: string;
  theme: MermaidTheme;
  fallback: ReactNode;
}) {
  const [image, setImage] = useState(() => cachedMermaid(source, theme));
  const [showSource, setShowSource] = useState(false);
  const [failed, setFailed] = useState(false);
  const [visible, setVisible] = useState(() => typeof IntersectionObserver === "undefined");
  const host = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (image || visible) return;
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) {
          setVisible(true);
          observer.disconnect();
        }
      },
      { rootMargin: "200px" },
    );
    if (host.current) observer.observe(host.current);
    return () => observer.disconnect();
  }, [image, visible]);
  useEffect(() => {
    if (!visible || image || failed || showSource) return;
    let active = true;
    void renderMermaid(source, theme, () => active).then(
      (result) => {
        if (!active) return;
        if (result) setImage(result);
        else setFailed(true);
      },
      () => {
        if (active) setFailed(true);
      },
    );
    return () => {
      active = false;
    };
  }, [source, theme, visible, image, failed, showSource]);
  return (
    <div
      ref={host}
      className="chat-markdown-mermaid"
      data-mermaid={image && !showSource && !failed ? "diagram" : "source"}
    >
      {image && !failed ? (
        <button
          type="button"
          className="chat-markdown-mermaid-toggle"
          aria-pressed={showSource}
          onClick={() => {
            setShowSource((value) => !value);
          }}
        >
          {showSource ? "Show diagram" : "Show source"}
        </button>
      ) : null}
      {image && !showSource && !failed ? (
        <img
          src={image.src}
          width={image.width}
          height={image.height}
          alt="Mermaid diagram; use Show source to read its definition"
          onError={() => setFailed(true)}
        />
      ) : (
        fallback
      )}
    </div>
  );
}
