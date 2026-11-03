import { describe, expect, it } from "vitest";
import { buildArchitectureDocument } from "../lib/architecture-generic";

const paths = [
  "app/products/[slug]/page.tsx",
  "components/product-navigation.tsx",
  "lib/chandler.ts",
  "app/auth/callback/route.ts",
  "app/api/products/route.ts",
  "lib/db.ts",
  "migrations/002_spec_versions.sql",
  "app/api/webhooks/github/route.ts",
  "lib/github-webhook.ts",
  "lib/analysis.ts",
  "lib/spec-versions.ts",
  "lib/github.ts",
  "lib/github-app.ts",
  "lib/ai.ts",
];

function sources(values = paths) {
  const markers = "ProductView ProductTabs getProductDetails registerProduct POST mysql2 databaseConfig spec_versions CREATE TABLE WorkMembership OAuth chandler completeChandlerOAuth processGitHubWebhook verifyGitHubSignature push analyzeWithAI insertSpecVersion api.github.com resolveGitHubToken installation createAppJwt chatCompletionsUrl AI_API_KEY LLMGateway";
  return values.map((path) => ({ path, content: `1: ${path} ${markers}` }));
}

describe("architecture draft", () => {
  it("builds a deterministic evidence-backed architecture document", () => {
    const input = {
      productName: "Radar",
      productSlug: "radar",
      owner: "gzhanlei",
      name: "radar",
      revision: "43d8ce7b96f7e7deff9bb3b8429eb8ca361466ea",
      sources: sources().reverse(),
    };
    const document = buildArchitectureDocument(input);
    expect(document.meta).toMatchObject({ title: "Radar 系统架构", output: "radar-architecture.html", quality_profile: "showcase" });
    expect(document.meta.repository).toMatchObject({ url: "https://github.com/gzhanlei/radar", revision: input.revision });
    expect(document.components.map((component) => component.id)).toEqual(["users", "radar-ui", "chandler", "next-api", "mysql", "webhook", "analysis", "github", "llm"]);
    expect(document.components.flatMap((component) => component.sources ?? []).every((source) => paths.includes(source.path))).toBe(true);
    expect(buildArchitectureDocument(input)).toEqual(document);
  });

  it("omits components and relationships whose evidence is absent", () => {
    const document = buildArchitectureDocument({
      productName: "Radar",
      productSlug: "radar",
      owner: "gzhanlei",
      name: "radar",
      revision: "43d8ce7b96f7e7deff9bb3b8429eb8ca361466ea",
      sources: sources(paths.filter((path) => path !== "lib/ai.ts")),
    });
    expect(document.components.some((component) => component.id === "llm")).toBe(false);
    expect(document.connections.some((connection) => connection.id === "analysis-to-llm")).toBe(false);
  });

  it("accepts a minimal user interface and frontend component", () => {
    const document = buildArchitectureDocument({
      productName: "Radar",
      productSlug: "radar",
      owner: "gzhanlei",
      name: "radar",
      revision: "43d8ce7b96f7e7deff9bb3b8429eb8ca361466ea",
      sources: sources(["components/product-navigation.tsx"]),
    });
    expect(document.components.map((component) => component.id)).toEqual(["users", "radar-ui"]);
  });

  it("builds a generic architecture for non-Radar repositories with matching source evidence", () => {
    const document = buildArchitectureDocument({
      productName: "Chandler",
      productSlug: "chandler",
      owner: "gzhanlei",
      name: "workmembership",
      revision: "43d8ce7b96f7e7deff9bb3b8429eb8ca361466ea",
      sources: [
        { path: "web/app/page.tsx", content: "1: export default function Home() {}" },
        { path: "internal/oauth/service.go", content: "1: package oauth\n2: // OAuth WorkMembership PKCE\n3: func Authorize() {}" },
        { path: "internal/db/db.go", content: "1: package db\n2: import _ \"github.com/go-sql-driver/mysql\"" },
      ],
    });
    expect(document.components.map((component) => component.id)).toEqual(["users", "frontend", "backend", "auth", "db"]);
    expect(document.meta.viewBox).toEqual([1200, 376]);
    expect(document.components.some((component) => component.id === "llm")).toBe(false);
    expect(document.components.flatMap((component) => component.sources ?? []).every((source) => source.line && source.line > 0)).toBe(true);
    expect(document.connections).toContainEqual(expect.objectContaining({ from: "backend", to: "db", label: "SQL" }));
    expect(document.connections.some((connection) => connection.id === "analysis-to-llm")).toBe(false);
    expect(document.connections.some((connection) => connection.id === "backend-to-analysis")).toBe(false);
  });

  it("sizes the desktop canvas for all detected components", () => {
    const document = buildArchitectureDocument({
      productName: "Chandler",
      productSlug: "chandler",
      owner: "gzhanlei",
      name: "workmembership",
      revision: "43d8ce7b96f7e7deff9bb3b8429eb8ca361466ea",
      sources: sources(),
    });
    expect(document.components.some((component) => component.id === "llm")).toBe(true);
    expect(document.meta.viewBox).toEqual([1200, 696]);
  });

  it("accepts a minimal generic frontend and caps component evidence", () => {
    const document = buildArchitectureDocument({
      productName: "Chandler",
      productSlug: "chandler",
      owner: "gzhanlei",
      name: "workmembership",
      revision: "43d8ce7b96f7e7deff9bb3b8429eb8ca361466ea",
      sources: ["page", "a", "b", "c"].map((name) => ({ path: `web/app/${name}/page.tsx`, content: "1: export default function Page() {}" })),
    });
    expect(document.components.map((component) => component.id)).toEqual(["users", "frontend"]);
    expect(document.meta.viewBox).toEqual([960, 376]);
    expect(document.components[1].sources).toHaveLength(3);
  });

  it("builds an Android native application architecture from application evidence", () => {
    const document = buildArchitectureDocument({
      productName: "Android AirPlay Receiver",
      productSlug: "android-airplay-receiver",
      owner: "gzhanlei",
      name: "uxplay-android",
      revision: "43d8ce7b96f7e7deff9bb3b8429eb8ca361466ea",
      sources: [
        { path: "app/src/main/java/com/codelphi/airplay/MirrorActivity.java", content: "1: public class MirrorActivity extends Activity {}" },
        { path: "app/src/main/java/com/codelphi/airplay/AirPlayService.java", content: "1: public class AirPlayService extends Service {}" },
        { path: "app/src/main/java/com/codelphi/airplay/NativeBridge.java", content: "1: static { System.loadLibrary(\"airplay-jni\"); }" },
        { path: "app/src/main/cpp/airplay_jni.c", content: "1: JNIEXPORT jint JNI_OnLoad(JavaVM *vm, void *reserved) {}" },
        { path: "uxplay/lib/raop.c", content: "1: void *raop_init(raop_callbacks_t *callbacks) {}" },
        { path: "app/src/main/java/com/codelphi/airplay/VideoSink.java", content: "1: MediaCodec codec;" },
      ],
    });
    expect(document.components.map((component) => component.id)).toEqual(["users", "android-ui", "android-service", "native-bridge", "native-core", "media-sink"]);
    expect(document.connections).toContainEqual(expect.objectContaining({ from: "android-service", to: "native-bridge" }));
    expect(document.components.flatMap((component) => component.sources ?? []).every((source) => source.line && source.line > 0)).toBe(true);
  });

  it("builds an Android Compose data architecture from repository evidence", () => {
    const document = buildArchitectureDocument({
      productName: "Now in Android",
      productSlug: "android-kotlin",
      owner: "android",
      name: "nowinandroid",
      revision: "43d8ce7b96f7e7deff9bb3b8429eb8ca361466ea",
      sources: [
        { path: "app/src/main/kotlin/com/google/samples/apps/nowinandroid/MainActivity.kt", content: "1: class MainActivity : ComponentActivity() {}" },
        { path: "core/data/src/main/kotlin/com/google/samples/apps/nowinandroid/core/data/repository/OfflineFirstNewsRepository.kt", content: "1: class OfflineFirstNewsRepository : NewsRepository {}" },
        { path: "core/database/src/main/kotlin/com/google/samples/apps/nowinandroid/core/database/NiaDatabase.kt", content: "1: @Database\n2: abstract class NiaDatabase : RoomDatabase() {}" },
        { path: "core/network/src/main/kotlin/com/google/samples/apps/nowinandroid/core/network/NiaNetworkDataSource.kt", content: "1: interface NiaNetworkDataSource {}" },
      ],
    });
    expect(document.components.map((component) => component.id)).toEqual(["users", "android-ui", "android-data", "android-local-db", "android-network"]);
    expect(document.connections).toContainEqual(expect.objectContaining({ from: "android-ui", to: "android-data" }));
    expect(document.connections).toContainEqual(expect.objectContaining({ from: "android-data", to: "android-local-db" }));
  });

  it("builds a FastAPI and SQLModel service architecture", () => {
    const document = buildArchitectureDocument({
      productName: "FastAPI Template",
      productSlug: "fastapi-react",
      owner: "fastapi",
      name: "full-stack-fastapi-template",
      revision: "43d8ce7b96f7e7deff9bb3b8429eb8ca361466ea",
      sources: [
        { path: "frontend/src/main.tsx", content: "1: createRoot(document.getElementById(\"root\")!).render(<App />)" },
        { path: "backend/app/main.py", content: "1: app = FastAPI()" },
        { path: "backend/app/models.py", content: "1: from sqlmodel import SQLModel\n2: class User(SQLModel, table=True): pass" },
      ],
    });
    expect(document.components.map((component) => component.id)).toEqual(["users", "frontend", "backend", "db"]);
  });

  it("rejects stale source content", () => {
    const stale = { productName: "Radar", productSlug: "radar", owner: "gzhanlei", name: "radar", revision: "43d8ce7b96f7e7deff9bb3b8429eb8ca361466ea", sources: sources().map((source) => ({ ...source, content: "1: unrelated" })) };
    expect(() => buildArchitectureDocument(stale)).toThrow("No architecture components detected");
  });

  it("rejects unsupported repositories and invalid revisions", () => {
    const input = { productName: "Empty", productSlug: "empty", owner: "gzhanlei", name: "radar", revision: "43d8ce7b96f7e7deff9bb3b8429eb8ca361466ea", sources: [] };
    expect(() => buildArchitectureDocument(input)).toThrow("No architecture components detected");
    expect(() => buildArchitectureDocument({ ...input, revision: "short", sources: sources() })).toThrow();
  });
});
