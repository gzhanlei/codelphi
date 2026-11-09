// CLI-only side effect. Tests inject their own DB/environment stubs, so
// importing a CLI script must not load the real .env (and the VM test pool
// cannot evaluate dotenv/config's CJS wrapper). Keeping this empty also
// preserves the original semantics for tests that assert on a missing env var.
export {};
