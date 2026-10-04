import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { normalizeAssetSha256, pickInstallerAsset } from "./app-update";

describe("app-update", () => {
  it("normalizes GitHub asset digests", () => {
    assert.equal(
      normalizeAssetSha256("sha256:95572fc81114a806eebf5c189e5e94ed36311b1a5bb273dfb30eebbba2e98cad"),
      "95572fc81114a806eebf5c189e5e94ed36311b1a5bb273dfb30eebbba2e98cad",
    );
    assert.equal(normalizeAssetSha256("deadbeef"), null);
    assert.equal(normalizeAssetSha256(null), null);
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
