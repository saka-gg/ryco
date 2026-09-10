/**
 * Serialized into a short-lived Node/Bun child. Keep this function self-contained:
 * opening a cloud-backed file can block in the kernel even after an async read
 * is cancelled. A separate process keeps optional icons out of the node's shared
 * filesystem/DNS worker pool, and lets the parent terminate a stalled read.
 */
export function projectFaviconWorkerMain(): void {
  const fs = process.getBuiltinModule("node:fs");
  const path = process.getBuiltinModule("node:path");
  const iconLimit = 512 * 1024;
  const sourceLimit = 256 * 1024;
  const candidates = [
    "favicon.svg",
    "favicon.ico",
    "favicon.png",
    "public/favicon.svg",
    "public/favicon.ico",
    "public/favicon.png",
    "app/favicon.ico",
    "app/favicon.png",
    "app/icon.svg",
    "app/icon.png",
    "app/icon.ico",
    "src/favicon.ico",
    "src/favicon.svg",
    "src/app/favicon.ico",
    "src/app/icon.svg",
    "src/app/icon.png",
    "assets/icon.svg",
    "assets/icon.png",
    "assets/logo.svg",
    "assets/logo.png",
    ".idea/icon.svg",
  ];
  const sources = [
    "index.html",
    "public/index.html",
    "app/routes/__root.tsx",
    "src/routes/__root.tsx",
    "app/root.tsx",
    "src/root.tsx",
    "src/index.html",
  ];
  try {
    const root = fs.realpathSync(process.argv[1]!);
    const read = (relative: string, limit: number): { path: string; bytes: Buffer } | null => {
      let fd: number | undefined;
      try {
        const filename = fs.realpathSync(path.resolve(root, relative));
        const within = path.relative(root, filename);
        if (within === ".." || within.startsWith(`..${path.sep}`) || path.isAbsolute(within))
          return null;
        fd = fs.openSync(filename, fs.constants.O_RDONLY | fs.constants.O_NONBLOCK);
        const stats = fs.fstatSync(fd);
        if (!stats.isFile() || stats.size > limit) return null;
        const bytes = Buffer.alloc(limit + 1);
        let length = 0;
        while (length < bytes.length) {
          const count = fs.readSync(fd, bytes, length, bytes.length - length, null);
          if (count === 0) break;
          length += count;
        }
        return length > limit ? null : { path: filename, bytes: bytes.subarray(0, length) };
      } catch {
        return null;
      } finally {
        if (fd !== undefined) fs.closeSync(fd);
      }
    };
    const send = (icon: { path: string; bytes: Buffer }) => {
      process.stdout.write(
        JSON.stringify({ path: icon.path, base64: icon.bytes.toString("base64") }),
      );
    };
    for (const candidate of candidates) {
      const icon = read(candidate, iconLimit);
      if (icon) {
        send(icon);
        return;
      }
    }
    for (const source of sources) {
      const text = read(source, sourceLimit)?.bytes.toString("utf8");
      if (!text) continue;
      const href =
        text.match(
          /<link\b(?=[^>]*\brel=["'](?:icon|shortcut icon)["'])(?=[^>]*\bhref=["']([^"'?]+))[^>]*>/i,
        )?.[1] ??
        text.match(
          /(?=[^}]*\brel\s*:\s*["'](?:icon|shortcut icon)["'])(?=[^}]*\bhref\s*:\s*["']([^"'?]+))[^}]*/i,
        )?.[1];
      if (!href) continue;
      const clean = href.replace(/^\//, "");
      for (const candidate of [path.join("public", clean), clean]) {
        const icon = read(candidate, iconLimit);
        if (icon) {
          send(icon);
          return;
        }
      }
    }
  } catch {
    // Missing, unreadable and unsupported project files all use the folder icon.
  }
  process.stdout.write("null");
}
