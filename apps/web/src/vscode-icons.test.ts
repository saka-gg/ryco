import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { assert, describe, it } from "vite-plus/test";

import lookup from "./vscode-icons-lookup.json";
import { getVscodeIconUrlForEntry } from "./vscode-icons";

describe("getVscodeIconUrlForEntry", () => {
  it("uses exact filename matches from the vscode-icons manifest", () => {
    const darkUrl = getVscodeIconUrlForEntry("pnpm-workspace.yaml", "file", "dark");
    const lightUrl = getVscodeIconUrlForEntry("pnpm-workspace.yaml", "file", "light");

    assert.isTrue(darkUrl.endsWith("/file_type_pnpm.svg"));
    assert.isTrue(lightUrl.endsWith("/file_type_light_pnpm.svg"));
  });

  it("uses longest extension match for compound extensions", () => {
    const iconUrl = getVscodeIconUrlForEntry("tsconfig.tsbuildinfo", "file", "dark");
    const manifestStyleUrl = getVscodeIconUrlForEntry("buf.yaml", "file", "dark");
    assert.isTrue(iconUrl.endsWith("/file_type_tsbuildinfo.svg"));
    assert.isTrue(manifestStyleUrl.endsWith("/file_type_buf.svg"));
  });

  it("uses folder mappings and light-aware filename mappings", () => {
    const folderUrl = getVscodeIconUrlForEntry("packages/src", "directory", "light");
    const fileUrl = getVscodeIconUrlForEntry("AGENTS.md", "file", "light");

    assert.isTrue(folderUrl.endsWith("/folder_type_src.svg"));
    assert.isTrue(fileUrl.endsWith("/file_type_light_agents.svg"));
  });

  it("falls back to language-based mappings for path-only cases", () => {
    const tsxUrl = getVscodeIconUrlForEntry("checkbox.tsx", "file", "light");
    const dockerfileUrl = getVscodeIconUrlForEntry("Dockerfile", "file", "dark");
    const shellUrl = getVscodeIconUrlForEntry("entrypoint.sh", "file", "dark");
    const htmlUrl = getVscodeIconUrlForEntry("index.html", "file", "dark");
    const cursorRulesUrl = getVscodeIconUrlForEntry("general.mdc", "file", "dark");
    const githubWorkflowUrl = getVscodeIconUrlForEntry(".github/workflows/ci.yml", "file", "light");

    assert.isTrue(tsxUrl.endsWith("/file_type_reactts.svg"));
    assert.isTrue(dockerfileUrl.endsWith("/file_type_docker.svg"));
    assert.isTrue(shellUrl.endsWith("/file_type_shell.svg"));
    assert.isTrue(htmlUrl.endsWith("/file_type_html.svg"));
    assert.isTrue(cursorRulesUrl.endsWith("/file_type_markdown.svg"));
    assert.isTrue(githubWorkflowUrl.endsWith("/file_type_light_yaml.svg"));
  });

  it("falls back to defaults when there is no match", () => {
    const fileUrl = getVscodeIconUrlForEntry("foo.unknown-ext", "file", "dark");
    const folderUrl = getVscodeIconUrlForEntry("totally-unknown-folder", "directory", "dark");

    assert.isTrue(fileUrl.endsWith("/default_file.svg"));
    assert.isTrue(folderUrl.endsWith("/default_folder.svg"));
  });
});

describe("vscode icon assets", () => {
  it("serves icons from the app under a version-pinned path", () => {
    const url = getVscodeIconUrlForEntry("README.md", "file", "dark");
    assert.isTrue(url.startsWith(`/vscode-icons/v${lookup.version}/`));
    assert.notInclude(url, "://");
  });

  it("ships every icon the lookup can resolve to", () => {
    const iconsDir = fileURLToPath(
      new URL(`../public/vscode-icons/v${lookup.version}/`, import.meta.url),
    );
    const missing = lookup.icons.filter((name) => !existsSync(`${iconsDir}${name}.svg`));
    assert.deepEqual(missing, []);
  });
});
