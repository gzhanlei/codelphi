import { prepareArchify, readArchifyRelease } from "../lib/archify-runtime";

async function prepare() {
  const release = readArchifyRelease();
  const bin = await prepareArchify();
  console.log(JSON.stringify({ version: release.version, license: release.license, sha256: release.sha256, bin }, null, 2));
}

prepare().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
