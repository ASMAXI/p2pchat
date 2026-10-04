import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { normalizeAssetSha256, pickInstallerAsset } from "./app-update";
import { loadTestdata } from "./test-fixtures";

type ShaFixture = {
  cases: Array<{ input: string; expected: string | null }>;
};

describe("app-update", () => {
  it("normalizes GitHub asset digests from shared fixtures", () => {
    const fixture = loadTestdata<ShaFixture>("sha256-digests.json");
    for (const item of fixture.cases) {
      assert.equal(normalizeAssetSha256(item.input), item.expected);
    }
  });

  it("prefers setup.exe over msi/portable", () => {
    const picked = pickInstallerAsset([
      { name: "Drift_0.10.1_x64_portable.exe", browser_download_url: "https://x/portable" },
      { name: "Drift_0.10.1_x64_en-US.msi", browser_download_url: "https://x/msi", digest: "sha256:11".padEnd(71, "0") },
      {
        name: "Drift_0.10.1_x64-setup.exe",
        browser_download_url: "https://x/setup",
        digest: "sha256:95572fc81114a806eebf5c189e5e94ed36311b1a5bb273dfb30eebbba2e98cad",
      },
    ]);
    assert.equal(picked?.name, "Drift_0.10.1_x64-setup.exe");
    assert.equal(
      normalizeAssetSha256(picked?.digest),
      "95572fc81114a806eebf5c189e5e94ed36311b1a5bb273dfb30eebbba2e98cad",
    );
  });
});
