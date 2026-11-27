/**
 * 「这个文件在不在分析目标里」的唯一判定。只看路径，不依赖任何别的模块，所以谁都能引用它：
 * 文件选择（切片规划器）、推送窗口、变更文件清单、证据允许集、覆盖率的分母、影响分类、PR 预演、
 * 客户端发布，都问这同一个函数，答案只有一种。
 *
 * 为什么要它：产品行为账本要的是「产品运行时怎么表现」。测试、文档、迁移脚本、构建和部署的配置、
 * 生成的代码、第三方代码的副本、示例和基准，读得再多也长不出产品行为，却实打实地花模型额度，
 * 还会让模型写出引用它们的场景（2026-11-27 实测：codelphi 的账本里 844 条场景引用 scripts/，
 * 433 条引用测试）。迁移脚本在 2026-11-25 移出过一次，那次改了 19 处；这次把规则收成一处。
 *
 * 规则要跨技术栈。下面列的是各种语言和构建系统的通用约定，不是某一个仓库的目录名。
 * 认不准的宁可不排除：漏掉一类噪声只是多花一点额度；错排一段产品代码，账本里就悄悄少一块，
 * 而且覆盖率上看不出来，因为它也不再算进实现面。
 *
 * 只靠路径认不出来、要看内容或清单的规则（重复的文件、原样拷进来的上游项目、开发工具脚本、
 * 带生成标记的文件头）不在这里，在 lib/slice-planner 里。
 */

/** 不在分析目标里的原因。顺序就是给用户看时的顺序。 */
export type AnalysisNoiseKind =
  | "schema"
  | "test"
  | "doc"
  | "example"
  | "bench"
  | "ci"
  | "config"
  | "build"
  | "deployment"
  | "generated"
  | "types"
  | "vendored";

export const ANALYSIS_NOISE_KINDS: ReadonlyArray<AnalysisNoiseKind> = [
  "schema", "test", "doc", "example", "bench", "ci", "config", "build", "deployment", "generated", "types", "vendored",
];

const basename = (path: string): string => {
  const index = path.lastIndexOf("/");
  return index === -1 ? path : path.slice(index + 1);
};

const stem = (name: string): string => {
  const index = name.lastIndexOf(".");
  return index <= 0 ? name : name.slice(0, index);
};

/** 路径里的目录段，不含文件名。 */
const directorySegments = (path: string): string[] => {
  const parts = path.split("/").filter((part) => part !== "");
  parts.pop();
  return parts;
};

/** 去掉分隔符、转小写：ab-test、abTest、ABTest 都是 abtest。 */
const plain = (value: string): string => value.toLowerCase().replace(/[^a-z0-9]/g, "");

// ───────────────────────────── 清单 ─────────────────────────────

/**
 * 规划器用来认技术栈的清单。它们算在分析目标里，所以会被选中；但不进给模型的提示词
 * （见 isModelContextFile），改动也不算行为变更。清单内容换了不会让产品多出一个功能。
 */
const BUILD_MANIFEST =
  /(?:^|\/)(?:package\.json|go\.mod|cargo\.toml|pom\.xml|composer\.json|requirements\.txt|pyproject\.toml|build\.gradle(?:\.kts)?|libs\.versions\.toml|androidmanifest\.xml|.*\.csproj|.*\.sln)$/i;

export function isBuildManifest(path: string): boolean {
  return BUILD_MANIFEST.test(path);
}

/**
 * 进不进给模型的提示词。清单不进，除了 Android 的 AndroidManifest.xml：它声明的权限、入口组件
 * 和导出方式，是这个平台上最接近「路由表」的东西。
 */
export function isModelContextFile(path: string): boolean {
  return isAnalysisTarget(path) && (!isBuildManifest(path) || basename(path).toLowerCase() === "androidmanifest.xml");
}

// ───────────────────────────── 目录 ─────────────────────────────

/** 整段目录名就是这些的，是测试目录。各种语言和框架的惯例都在这里。 */
const TEST_DIRECTORIES: ReadonlySet<string> = new Set([
  "test", "tests", "__tests__", "spec", "specs", "__specs__", "testing", "testdata", "test-data", "test_data",
  "testutils", "test-utils", "test_utils", "testsupport", "test-support", "test_support", "test-fixtures", "test_fixtures",
  "__snapshots__", "snapshots", "__stories__", "stories", "e2e", "cypress", "playwright", "karma",
  "__fixtures__", "fixtures", "fixture", "__mocks__", "mocks", "mock",
]);

/**
 * 名字里带 test 但不是测试的：A/B 测试是很多产品都有的功能。
 * 归一化之后（ab-test、abTest、ABTest 都是 abtest）等于这些的，任何测试规则都不碰它。
 */
const NOT_A_TEST_NAME: ReadonlySet<string> = new Set(["abtest", "abtests", "splittest", "splittests", "multivariatetest", "buckettest"]);

/**
 * kebab / snake 分隔、以 test 结尾的目录名：integration-test、unit_test。Go 的集成测试惯例就是 `foo-test/`。
 * 不认 spec 结尾的：Superset 的 db_engine_specs 是数据库引擎的规格模块，不是测试。
 */
const SEPARATED_TEST_DIRECTORY = /^(?:[a-z0-9]+[-_.])+tests?$/;

/**
 * 驼峰：开头一个词，中间若干个首字母大写的词，最后是大写开头的 Test / Tests / TestFixtures——
 * Gradle 和 Kotlin 多平台的源码集就是这样命名的（androidUnitTest、commonTest、iosSimulatorArm64Test）。
 * 另外认 Gradle 的 testFixtures。`latest`、`contest` 的后缀不是大写开头，不算。
 */
const CAMEL_TEST_DIRECTORY = /^(?:[A-Za-z0-9]+(?:[A-Z][a-z0-9]+)*Tests?(?:Fixtures)?|testFixtures)$/;

function isTestSegment(segment: string): boolean {
  if (NOT_A_TEST_NAME.has(plain(segment))) return false;
  const lower = segment.toLowerCase();
  if (TEST_DIRECTORIES.has(lower) || SEPARATED_TEST_DIRECTORY.test(lower) || /\.tests?$/.test(lower)) return true;
  // 点号前的部分是 .NET 的项目名：Acme.UnitTests、Acme.Tests。
  const lastPart = segment.slice(segment.lastIndexOf(".") + 1);
  return CAMEL_TEST_DIRECTORY.test(segment) || CAMEL_TEST_DIRECTORY.test(lastPart);
}

const SCHEMA_DIRECTORIES: ReadonlySet<string> = new Set(["migration", "migrations", "migrate", "alembic"]);
const GENERATED_DIRECTORIES: ReadonlySet<string> = new Set(["generated", "__generated__"]);
const EXAMPLE_DIRECTORIES = /^(?:examples?|samples?|demos?|tutorials?|cookbooks?|designs|evals?|prototypes?|mockups?)$/;
const BENCH_DIRECTORIES = /^(?:benchmarks?|bench(?:es)?|perf(?:ormance)?)$/;
const DOC_DIRECTORIES = /^(?:docs?|documentation|changelogs?)$/;
const CI_DIRECTORIES: ReadonlySet<string> = new Set(["ci", "cicd"]);

/** 哪一层都可以出现的第三方目录名。没有产品会把自己的模块叫 node_modules 或 third_party。 */
const VENDORED_ANYWHERE: ReadonlySet<string> = new Set([
  "node_modules", "vendor", "third_party", "third-party", "thirdparty", "3rd_party", "3rd-party", "3rdparty", "_vendor", "bower_components",
]);

/**
 * 只在仓库顶层才算的第三方目录名。嵌在产品代码里的同名目录往往是功能模块：
 * app/external/sync.ts 是对接外部服务，iosApp/Features/Pods/ 可能是播客列表。
 */
const VENDORED_TOP_LEVEL: ReadonlySet<string> = new Set(["pods", "carthage", "external", "extern", "externals", "deps"]);

/**
 * 只在仓库顶层才算的部署目录。app/deployments/page.tsx 是一个部署平台产品的功能页，
 * lib/terraform/plan.go 可能是一个 Terraform 工具的核心；顶层的 deploy/、infra/ 才是仓库自己的运维文件。
 */
const DEPLOYMENT_TOP_LEVEL: ReadonlySet<string> = new Set([
  "k8s", "kubernetes", "helm", "charts", "deploy", "deployment", "deployments", "infra", "infrastructure",
  "terraform", "ansible", "kustomize", "argocd", "ops", "operation", "operations", "sre", "provisioning",
]);

function directoryNoiseKind(segments: string[]): AnalysisNoiseKind | null {
  if (segments.length === 0) return null;
  const lower = segments.map((segment) => segment.toLowerCase());
  if (VENDORED_TOP_LEVEL.has(lower[0])) return "vendored";
  if (lower.some((segment) => VENDORED_ANYWHERE.has(segment))) return "vendored";
  if (DEPLOYMENT_TOP_LEVEL.has(lower[0])) return "deployment";
  if (lower.some((segment) => GENERATED_DIRECTORIES.has(segment))) return "generated";
  if (lower.some((segment) => SCHEMA_DIRECTORIES.has(segment))) return "schema";
  if (segments.some((segment) => isTestSegment(segment))) return "test";
  if (lower.some((segment) => EXAMPLE_DIRECTORIES.test(segment))) return "example";
  if (lower.some((segment) => BENCH_DIRECTORIES.test(segment))) return "bench";
  // 隐藏目录（.github、.circleci、.idea、.storybook）：没有产品代码放在点开头的目录里。
  if (lower.some((segment) => segment.startsWith(".") || CI_DIRECTORIES.has(segment))) return "ci";
  if (lower.some((segment) => DOC_DIRECTORIES.test(segment))) return "doc";
  return null;
}

// ───────────────────────────── 文件 ─────────────────────────────

/**
 * 文件名里的测试约定，只认工具链自己强制的那些。
 * `foo-test.ts` 不算：图形学里有 hit-test（命中测试）、密码学里有 primality-test（素性测试），都是产品代码。
 */
const TEST_FILE = [
  // Jest、Vitest、Mocha、Angular：foo.test.ts、foo.spec.tsx、app.e2e-spec.ts；Django 的 tests.py。
  // 光叫 test.py 或 spec.py 的不算：那可以是一个叫 spec 的模块。
  /\.tests?\.[a-z0-9]+$/,
  /\.specs?\.[a-z0-9]+$/,
  /e2e-spec\.[a-z0-9]+$/,
  /^tests\.[a-z0-9]+$/,
  // 工具链按后缀收集测试的语言：go test、pytest、minitest、package:test、ExUnit；RSpec 和 Crystal Spec 认 _spec
  /_test\.(?:go|py|rb|dart|ex|exs)$/,
  /_spec\.(?:rb|cr)$/,
  // pytest / unittest：test_foo.py
  /^test_[^/]+\.py$/,
  /^conftest\.py$/,
  /(?:^|_)suite\.erl$/,
  // shell（bats）、Jest 的快照、Cucumber 的特性文件
  /\.(?:bats|snap|feature)$/,
  /\.(?:stories|story)\.[a-z0-9]+$/,
  // jest：setupTests.ts
  /^setuptests?\.[a-z0-9]+$/,
];

/** Apple、JVM、Dart 的惯例把测试类写成 FooTest / FooTests，Xcode 和一些 Android 工程把它们直接放在源码旁边。 */
const TEST_SUFFIX_EXTENSIONS = "kt|kts|java|groovy|scala|cs|vb|fs|swift|m|mm|h|php|dart";
const TEST_CLASS_FILE = [
  new RegExp(`^[A-Z][A-Za-z0-9]*(?:Tests?|TestCase|TestSuite|TestListener)\\.(?:${TEST_SUFFIX_EXTENSIONS})$`),
  new RegExp(`^[a-z0-9]+(?:[A-Z][a-z0-9]+)*Tests?\\.(?:${TEST_SUFFIX_EXTENSIONS})$`),
  // Maven failsafe：FooIT.java
  /^[A-Z][A-Za-z0-9]*IT\.(?:java|kt|kts|groovy)$/,
];

const DOC_NAMES =
  /^(?:readme|changelog|changes|history|releases|news|license|licence|copying|copyright|notice|authors|contributors|maintainers|codeowners|code_of_conduct|security|governance|support|pull_request_template|issue_template|patents|version|unlicense)$/i;
/** 纯文本的文档和数据。清单（requirements.txt 等）在此之前已经放行。 */
const DOC_EXTENSIONS = /\.(?:md|mdx|rst|adoc|asciidoc|txt|text)$/i;

const CI_FILE =
  /^(?:jenkinsfile|\.gitlab-ci\.yml|\.travis\.yml|\.drone\.yml|azure-pipelines\.yml|\.azure-pipelines\.yml|bitbucket-pipelines\.yml|appveyor\.yml|cloudbuild\.yaml|buildspec\.yml|\.pre-commit-config\.ya?ml|lefthook\.ya?ml|\.woodpecker\.ya?ml)$/i;

/** 构建和测试工具的前缀。只认 `<工具>.config.<后缀>` 和 `<工具>.json`：`metro.ts`、`next.ts` 可能是产品模块。 */
const TOOL = "jest|vitest|playwright|cypress|webpack|rollup|vite|esbuild|babel|tailwind|postcss|metro|storybook|turbo|nx|lerna|next|nuxt|svelte|astro|angular|ionic|capacitor";
/** 这些工具的配置还会写成 webpack.common.js、karma.conf.js。它们不会是产品模块的前缀。 */
const UNAMBIGUOUS_TOOL = "jest|vitest|playwright|cypress|webpack|rollup|vite|esbuild|karma|protractor|babel|tailwind|postcss|metro|storybook";
const CONFIG_FILE = [
  new RegExp(`^(?:${TOOL})(?:\\.[-\\w]+)?\\.config\\.[a-z0-9]+$`, "i"),
  new RegExp(`^(?:${UNAMBIGUOUS_TOOL})(?:\\.[-\\w]+)+\\.[a-z0-9]+$`, "i"),
  /^(?:tsconfig|jsconfig)(?:\.[-\w]+)?\.json$/i,
  new RegExp(`^(?:${TOOL})\\.json$`, "i"),
  /^(?:lint-staged\.config|renovate|codecov|tslint|tox|pytest|ruff)\.[a-z0-9]+$/i,
];

const BUILD_FILE = [
  /(?:^|\/)(?:package-lock\.json|npm-shrinkwrap\.json|go\.sum|go\.work|go\.work\.sum|package\.resolved)$/i,
  /[-.]lock\.(?:ya?ml|json|toml)$/i,
  /\.(?:lock|pbxproj|xcconfig|xcscheme|xcprivacy|entitlements|properties|cmake|mk)$/i,
  /(?:^|\/)(?:gradlew(?:\.bat)?|proguard-rules\.pro)$/i,
  /\.(?:pro|pem|crt|cer|der|p12|pfx|jks|keystore|mobileprovision)$/i,
  /(?:^|\/)(?:buck|build|build\.bazel|workspace|workspace\.bazel|module\.bazel)$/i,
  /(?:^|\/)(?:meson\.build|sconstruct|configure(?:\.ac|\.in)?|cmakelists\.txt|cmakecache\.txt)$/i,
  /(?:^|\/)(?:makefile|gnumakefile|makefile\.am|makefile\.in)$/i,
];

/**
 * 以 build、compile 这类词开头的脚本：buildAndroidRelease.sh、build.py、compile-bundle.js。
 * release、publish、package 只在 shell 脚本上算：lib/release-notes.ts、release_channel.rb 是产品代码。
 */
const BUILD_SCRIPT = /^(?:build|compile|bundle|dist)(?:[-_.]|[A-Z0-9]|$)/;
const BUILD_SHELL_SCRIPT = /^(?:release|publish|pack|package)(?:[-_.]|[A-Z0-9]|$)/;
const SCRIPT_EXTENSIONS = /\.(?:sh|bash|zsh|ps1|bat|cmd|py|js|mjs|cjs)$/i;
const SHELL_EXTENSIONS = /\.(?:sh|bash|zsh|ps1|bat|cmd)$/i;

const DEPLOYMENT_FILE = [
  /(?:^|\/)(?:dockerfile[^/]*|[^/]+\.dockerfile)$/i,
  /^(?:docker-)?compose(?:[.\-][-\w]+)*\.ya?ml$/i,
  /^(?:procfile|tiltfile|vagrantfile|ansible\.cfg|skaffold\.ya?ml|kustomization\.ya?ml|chart\.ya?ml|chart\.lock|firebase\.json|heroku\.yml|render\.yaml|fly\.toml)$/i,
  /^deploy(?:[-_.][-\w]+)*\.(?:sh|py|ps1|rb)$/,
  /\.(?:tf|tfvars|hcl|service|socket|timer)$/i,
];

/** 代码生成器的输出后缀：protobuf、gRPC、json_serializable、freezed、mockito、wire、OpenAPI、Xcode 的设计器文件，以及缩过的包。 */
const GENERATED_FILE =
  /(?:\.(?:pb\.go|pb\.validate\.go|pb\.(?:cc|h|c|js|ts)|g\.dart|g\.cs|g\.ii|freezed\.dart|mocks\.dart|designer\.cs|generated\.[a-z0-9]+|gen\.(?:go|ts|js)|min\.(?:js|css|mjs))|_pb2(?:_grpc)?\.py|_pb\.(?:ts|js)|_generated\.[a-z0-9]+|_gen\.go)$/i;

/** TypeScript 的类型声明：有的生成、有的手写，但都只描述形状，不描述运行时怎么表现。 */
const TYPES_FILE = /\.d\.[cm]?ts$/i;

function isTestFileName(name: string): boolean {
  if (NOT_A_TEST_NAME.has(plain(stem(name)))) return false;
  const lower = name.toLowerCase();
  return TEST_FILE.some((pattern) => pattern.test(lower)) || TEST_CLASS_FILE.some((pattern) => pattern.test(name));
}

function fileNoiseKind(name: string): AnalysisNoiseKind | null {
  const lower = name.toLowerCase();
  if (CI_FILE.test(name)) return "ci";
  if (CONFIG_FILE.some((pattern) => pattern.test(name))) return "config";
  // 点开头的文件（.gitignore、.nvmrc、.eslintrc、.env.example）是工具和环境的配置。
  if (lower.startsWith(".")) return "config";
  if (BUILD_FILE.some((pattern) => pattern.test(name))) return "build";
  if ((SCRIPT_EXTENSIONS.test(name) && BUILD_SCRIPT.test(stem(name))) || (SHELL_EXTENSIONS.test(name) && BUILD_SHELL_SCRIPT.test(stem(name)))) return "build";
  if (DEPLOYMENT_FILE.some((pattern) => pattern.test(name))) return "deployment";
  if (GENERATED_FILE.test(name)) return "generated";
  if (TYPES_FILE.test(name)) return "types";
  if (/\.(?:sql|ddl)$/i.test(name)) return "schema";
  if (isTestFileName(name)) return "test";
  // 只认「没有后缀的惯例名」和文档后缀：security.ts、support.ts、authors.ts 是产品代码，不是文档。
  if (DOC_EXTENSIONS.test(name) || DOC_NAMES.test(name)) return "doc";
  return null;
}

// ───────────────────────────── 判定 ─────────────────────────────

/**
 * 一个路径在不在分析目标里；不在的话是哪一类噪声。
 * 目录规则先于清单：测试目录里的 package.json 是测试夹具，不是这个产品的清单。
 */
export function analysisNoiseKind(path: string): AnalysisNoiseKind | null {
  // 读不出路径（数据库里的旧行、测试替身）时不替调用方做决定：按在分析目标里算。
  if (typeof path !== "string" || path === "" || path.endsWith("/")) return null;
  const byDirectory = directoryNoiseKind(directorySegments(path));
  if (byDirectory !== null) return byDirectory;
  if (isBuildManifest(path)) return null;
  return fileNoiseKind(basename(path));
}

export function isAnalysisTarget(path: string): boolean {
  return analysisNoiseKind(path) === null;
}
