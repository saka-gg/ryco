import { GitHubIcon } from "@/assets/brands";
import { useEffect } from "react";
import { Link } from "react-router-dom";
import { ArrowDown, ArrowLeft, ArrowUpRight, Download } from "lucide-react";
import { RycoMark, RycoWordmark } from "@/assets/RycoLogo";
import { CHANGELOG_RELEASES, type ChangelogRelease } from "@/data/changelog";
import { SITE } from "@/data/content";
import { cn } from "@/lib/cn";
import { MagneticButton } from "@/versions/v4/MagneticButton";
import { ACCENT, focusRing } from "@/versions/v4/theme";
import { useDownload, type DownloadInfo } from "@/versions/v4/useDownload";

function ChangelogNav({ dl }: { dl: DownloadInfo }) {
  return (
    <header className="fixed inset-x-0 top-0 z-50">
      <div className="mx-auto flex max-w-7xl items-center justify-between gap-3 px-3 pt-3 sm:px-6">
        <Link
          to="/"
          aria-label="Ryco home"
          className={cn(
            "group flex items-center gap-2.5 rounded-full border border-white/12 bg-[#0b0c0e]/82 px-4 py-2.5 shadow-lg shadow-black/20 backdrop-blur-xl",
            focusRing,
          )}
        >
          <RycoMark className="size-7 transition-transform duration-300 group-hover:rotate-[8deg]" />
        </Link>

        <nav
          aria-label="Primary"
          className="hidden items-center gap-1 rounded-full border border-white/12 bg-[#0b0c0e]/82 p-1.5 text-sm text-white/60 shadow-lg shadow-black/20 backdrop-blur-xl md:flex"
        >
          <Link
            to="/"
            className={cn(
              "rounded-full px-3.5 py-1.5 transition-colors hover:text-white",
              focusRing,
            )}
          >
            Home
          </Link>
          <span
            aria-current="page"
            className="rounded-full bg-white/[0.08] px-3.5 py-1.5 text-white"
          >
            Changelog
          </span>
          <a
            href={SITE.releases}
            target="_blank"
            rel="noreferrer"
            className={cn(
              "rounded-full px-3.5 py-1.5 transition-colors hover:text-white",
              focusRing,
            )}
          >
            Releases
          </a>
        </nav>

        <div className="flex items-center gap-1.5 rounded-full border border-white/12 bg-[#0b0c0e]/82 p-1.5 shadow-lg shadow-black/20 backdrop-blur-xl">
          <Link
            to="/"
            aria-label="Back to the Ryco home page"
            className={cn(
              "grid size-9 place-items-center rounded-full text-white/65 transition hover:bg-white/10 hover:text-white md:hidden",
              focusRing,
            )}
          >
            <ArrowLeft className="size-[18px]" />
          </Link>
          <a
            href={SITE.repo}
            target="_blank"
            rel="noreferrer"
            aria-label="Ryco on GitHub"
            className={cn(
              "hidden size-9 place-items-center rounded-full text-white/65 transition hover:bg-white/10 hover:text-white sm:grid",
              focusRing,
            )}
          >
            <GitHubIcon className="size-[18px]" />
          </a>
          <MagneticButton
            href={dl.href}
            external={!dl.isDirect}
            size="sm"
            magnetic={false}
            className="rounded-full"
            ariaLabel={dl.osLabel ? `Download Ryco for ${dl.osLabel}` : "Download Ryco"}
          >
            <Download className="size-4" />
            <span>Download</span>
          </MagneticButton>
        </div>
      </div>
    </header>
  );
}

function ReleaseEntry({ release, latest }: { release: ChangelogRelease; latest: boolean }) {
  return (
    <article
      id={`v${release.version}`}
      className="scroll-mt-28 border-t border-white/12 py-14 sm:py-20"
    >
      <div className="grid gap-8 lg:grid-cols-[minmax(10rem,0.7fr)_minmax(0,2fr)] lg:gap-16">
        <div className="lg:sticky lg:top-28 lg:self-start">
          <p
            className="font-['JetBrains_Mono'] text-sm font-medium tabular-nums"
            style={{ color: ACCENT }}
          >
            v{release.version}
          </p>
          <time
            dateTime={release.dateTime}
            className="mt-2 block font-['JetBrains_Mono'] text-xs uppercase tracking-[0.14em] text-white/45"
          >
            {release.date}
          </time>
          {latest && (
            <span className="mt-5 inline-flex rounded-full border border-[#c6ff3a]/25 bg-[#c6ff3a]/[0.07] px-3 py-1.5 font-['JetBrains_Mono'] text-[10px] font-medium uppercase tracking-[0.15em] text-[#d9ff78]">
              Latest release
            </span>
          )}
        </div>

        <div>
          <h2 className="max-w-3xl font-['Space_Grotesk'] text-3xl font-semibold leading-tight tracking-[-0.025em] text-white sm:text-4xl">
            {release.summary}
          </h2>

          <div className="mt-10 grid gap-x-10 gap-y-9 sm:grid-cols-2">
            {release.highlights.map((highlight) => (
              <div key={highlight.title} className="group">
                <h3 className="font-['Space_Grotesk'] text-lg font-semibold text-white transition-colors group-hover:text-[#d9ff78]">
                  {highlight.title}
                </h3>
                <p className="mt-2 text-[15px] leading-relaxed text-white/58">
                  {highlight.summary}
                </p>
              </div>
            ))}
          </div>

          <a
            href={release.releaseUrl}
            target="_blank"
            rel="noreferrer"
            className={cn(
              "group mt-10 inline-flex items-center gap-2 text-sm font-semibold text-white/75 transition hover:text-white",
              focusRing,
            )}
          >
            Read the complete v{release.version} release notes
            <ArrowUpRight className="size-4 transition-transform group-hover:translate-x-0.5 group-hover:-translate-y-0.5" />
          </a>
        </div>
      </div>
    </article>
  );
}

export default function ChangelogPage() {
  const dl = useDownload();

  useEffect(() => {
    const previousTitle = document.title;
    const description = document.querySelector<HTMLMetaElement>('meta[name="description"]');
    const previousDescription = description?.content;

    document.title = "Changelog | Ryco";
    if (description) {
      description.content =
        "Read every Ryco release, with concise summaries of new coding-agent workflows, performance improvements, provider support, and product polish.";
    }

    return () => {
      document.title = previousTitle;
      if (description && previousDescription) description.content = previousDescription;
    };
  }, []);

  return (
    <div className="relative min-h-screen bg-[#0a0b0d] text-white antialiased">
      <ChangelogNav dl={dl} />

      <main>
        <section className="mx-auto grid min-h-[100dvh] max-w-7xl items-center gap-12 px-5 pb-20 pt-32 sm:px-8 sm:pt-36 lg:grid-cols-[0.82fr_1.18fr] lg:gap-16">
          <div className="changelog-intro max-w-xl">
            <p className="font-['JetBrains_Mono'] text-xs font-medium uppercase tracking-[0.2em] text-[#d9ff78]">
              Changelog
            </p>
            <h1 className="mt-5 font-['Space_Grotesk'] text-[clamp(3rem,7vw,5.8rem)] font-bold leading-[0.94] tracking-[-0.045em] text-white">
              The Ryco changelog.
            </h1>
            <p className="mt-6 max-w-md text-lg leading-relaxed text-white/62">
              Every public release, distilled into the improvements you can feel.
            </p>
            <div className="mt-9 flex flex-wrap items-center gap-3">
              <a
                href={`#v${CHANGELOG_RELEASES[0]?.version ?? ""}`}
                className={cn(
                  "inline-flex items-center gap-2 rounded-full bg-[#c6ff3a] px-5 py-3 text-sm font-semibold text-[#11140b] transition-transform hover:-translate-y-0.5 active:translate-y-px",
                  focusRing,
                )}
              >
                Latest release <ArrowDown className="size-4" />
              </a>
              <a
                href={SITE.releases}
                target="_blank"
                rel="noreferrer"
                className={cn(
                  "inline-flex items-center gap-2 rounded-full border border-white/14 bg-white/[0.03] px-5 py-3 text-sm font-semibold text-white/80 transition hover:border-white/28 hover:text-white active:translate-y-px",
                  focusRing,
                )}
              >
                GitHub releases <ArrowUpRight className="size-4" />
              </a>
            </div>
          </div>

          <figure className="changelog-visual mx-auto w-full max-w-3xl lg:mx-0">
            <div className="overflow-hidden rounded-3xl border border-white/12 bg-white/[0.025] p-2 shadow-2xl shadow-black/35">
              <img
                src="/shots/overview.png"
                alt="Ryco desktop workspace showing coding agent sessions and project activity"
                width={1920}
                height={1080}
                fetchPriority="high"
                className="aspect-[16/10] w-full rounded-[1.15rem] object-cover object-left-top"
              />
            </div>
            <figcaption className="mt-3 text-right font-['JetBrains_Mono'] text-[11px] uppercase tracking-[0.14em] text-white/38">
              The Ryco desktop workspace
            </figcaption>
          </figure>
        </section>

        <section aria-labelledby="release-history" className="mx-auto max-w-6xl px-5 pb-28 sm:px-8">
          <div className="mb-4 max-w-2xl">
            <p className="font-['JetBrains_Mono'] text-xs font-medium uppercase tracking-[0.2em] text-[#d9ff78]">
              Release history
            </p>
            <h2
              id="release-history"
              className="mt-5 font-['Space_Grotesk'] text-4xl font-semibold tracking-[-0.03em] text-white sm:text-5xl"
            >
              From the first public build to today.
            </h2>
          </div>

          <div className="mt-14">
            {CHANGELOG_RELEASES.map((release, index) => (
              <ReleaseEntry key={release.version} release={release} latest={index === 0} />
            ))}
          </div>
        </section>

        <section className="mx-auto max-w-6xl px-5 pb-28 sm:px-8">
          <div className="grid gap-8 rounded-3xl border border-white/12 bg-white/[0.025] px-6 py-10 sm:px-10 lg:grid-cols-[1fr_auto] lg:items-center">
            <div>
              <h2 className="font-['Space_Grotesk'] text-3xl font-semibold tracking-[-0.025em] text-white">
                Ready to try the latest build?
              </h2>
              <p className="mt-3 max-w-xl text-white/58">
                Download Ryco, bring your coding agents, and keep every project on your machine.
              </p>
            </div>
            <MagneticButton href={dl.href} external={!dl.isDirect} variant="primary">
              <Download className="size-[18px]" /> Download Ryco
            </MagneticButton>
          </div>
        </section>
      </main>

      <footer className="border-t border-white/10 pb-12 pt-10">
        <div className="mx-auto flex max-w-6xl flex-col gap-8 px-5 sm:px-8 md:flex-row md:items-center md:justify-between">
          <div className="flex items-center gap-2.5">
            <RycoMark className="size-7" />
            <RycoWordmark className="h-[18px] text-white" />
          </div>
          <nav
            aria-label="Footer"
            className="flex flex-wrap items-center gap-x-6 gap-y-3 text-sm text-white/58"
          >
            <Link to="/" className="transition hover:text-white">
              Home
            </Link>
            <a
              href={SITE.repo}
              target="_blank"
              rel="noreferrer"
              className="transition hover:text-white"
            >
              GitHub
            </a>
            <a
              href={SITE.releases}
              target="_blank"
              rel="noreferrer"
              className="transition hover:text-white"
            >
              Releases
            </a>
          </nav>
          <p className="text-xs text-white/38">
            {SITE.license} licensed. © {SITE.company}
          </p>
        </div>
      </footer>
    </div>
  );
}
