import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { analyzeSwiftcReadme, analyzeTypescriptImports } from "../lib/validation-impact";

async function fixture(prefix: string) {
  return mkdtemp(join(tmpdir(), prefix));
}

describe("Swift validation command impact", () => {
  it("returns only commands that compile the target but omit a new dependency", async () => {
    const repo = await fixture("validation-swift-");
    await mkdir(join(repo, "ios", "Tests"), { recursive: true });
    await writeFile(join(repo, "ios", "Tests", "README.md"), [
      "```bash",
      "SRC=Tingfeng",
      "swiftc $SRC/DSP/A.swift Tests/a/main.swift -o /tmp/t1 && /tmp/t1",
      "swiftc $SRC/DSP/A.swift $SRC/DSP/B.swift Tests/b/main.swift -o /tmp/t2 && /tmp/t2",
      "swiftc $SRC/DSP/C.swift Tests/c/main.swift -o /tmp/t3 && /tmp/t3",
      "```",
    ].join("\n"));
    const result = await analyzeSwiftcReadme(repo, { path: "ios/Tingfeng/DSP/A.swift", requires: ["ios/Tingfeng/DSP/B.swift"] });
    expect(result.affected.map((item) => item.id)).toEqual(["a"]);
    expect(result.affected[0].evidencePath).toBe("ios/Tests/README.md");
    expect(result.coverage.commandCount).toBe(3);
  });
});

describe("TypeScript and Vue validation impact", () => {
  it("follows relative imports to affected test files with dependency chains", async () => {
    const web = await fixture("validation-web-");
    const files = new Map([
      ["src/utils/linkify.ts", "import { helper } from './helper'\nexport const links = helper"],
      ["src/utils/helper.ts", "export const helper = () => []"],
      ["src/components/Answer.vue", "import { links } from '../utils/linkify'\nexport default { links }"],
      ["src/components/Drawer.vue", "import Answer from './Answer.vue'\nexport default { Answer }"],
      ["src/App.vue", "import Drawer from './components/Drawer.vue'\nexport default { Drawer }"],
      ["src/components/__tests__/Drawer.spec.ts", "import Drawer from '../Drawer.vue'\ntest('drawer', () => {})"],
      ["src/components/__tests__/App.spec.ts", "import App from '../../App.vue'\ntest('app', () => {})"],
      ["src/utils/__tests__/unrelated.spec.ts", "test('unrelated', () => {})"],
    ]);
    for (const [path, content] of files) {
      await mkdir(join(web, path, ".."), { recursive: true });
      await writeFile(join(web, path), content);
    }
    const result = await analyzeTypescriptImports(web, { path: "src/utils/linkify.ts", requires: ["src/utils/newDependency.ts"] });
    expect(result.affected.map((item) => item.id).sort()).toEqual([
      "src/components/__tests__/App.spec.ts",
      "src/components/__tests__/Drawer.spec.ts",
    ]);
    expect(result.affected.find((item) => item.id.endsWith("App.spec.ts"))?.dependencyChain).toEqual([
      "src/utils/linkify.ts",
      "src/components/Answer.vue",
      "src/components/Drawer.vue",
      "src/App.vue",
      "src/components/__tests__/App.spec.ts",
    ]);
  });
});
