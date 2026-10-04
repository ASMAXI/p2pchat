import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/** Load a shared JSON fixture from repo-root `testdata/`. */
export function loadTestdata<T>(relativeName: string): T {
  const here = dirname(fileURLToPath(import.meta.url));
  // artifacts/p2pchat/src/lib → repo root is ../../../../
  const root = join(here, "../../../..");
  return JSON.parse(readFileSync(join(root, "testdata", relativeName), "utf8")) as T;
}
