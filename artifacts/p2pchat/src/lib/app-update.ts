export type AppUpdateInfo = {
  upToDate: boolean;
  currentVersion: string;
  latestVersion: string;
  releaseUrl: string;
  downloadUrl: string | null;
  name: string;
  body: string;
};

const GITHUB_REPO = "ASMAXI/p2pchat";

function normalizeVersion(value: string): string {
  return value.trim().replace(/^v/i, "");
}

function compareSemver(a: string, b: string): number {
  const pa = normalizeVersion(a).split(".").map((part) => Number.parseInt(part, 10) || 0);
  const pb = normalizeVersion(b).split(".").map((part) => Number.parseInt(part, 10) || 0);
  const len = Math.max(pa.length, pb.length);
  for (let i = 0; i < len; i += 1) {
    const left = pa[i] ?? 0;
    const right = pb[i] ?? 0;
    if (left > right) return 1;
    if (left < right) return -1;
  }
  return 0;
}

async function currentAppVersion(): Promise<string> {
  try {
    if ("__TAURI_INTERNALS__" in window) {
      const { getVersion } = await import("@tauri-apps/api/app");
      return await getVersion();
    }
  } catch {
    // fall through
  }
  return "0.1.0";
}

export async function checkForAppUpdate(): Promise<AppUpdateInfo> {
  const currentVersion = await currentAppVersion();
  const response = await fetch(`https://api.github.com/repos/${GITHUB_REPO}/releases/latest`, {
    headers: { Accept: "application/vnd.github+json" },
  });
  if (!response.ok) {
    throw new Error(`GitHub Releases: HTTP ${response.status}`);
  }
  const release = (await response.json()) as {
    tag_name?: string;
    html_url?: string;
    name?: string;
    body?: string;
    assets?: Array<{ name: string; browser_download_url: string }>;
  };
  const latestVersion = normalizeVersion(release.tag_name || release.name || currentVersion);
  const assets = release.assets ?? [];
  const installer =
    assets.find((asset) => /\.exe$/i.test(asset.name) && /setup|nsis|p2pchat/i.test(asset.name)) ||
    assets.find((asset) => /\.exe$/i.test(asset.name)) ||
    assets.find((asset) => /\.msi$/i.test(asset.name));
  const upToDate = compareSemver(currentVersion, latestVersion) >= 0;
  return {
    upToDate,
    currentVersion,
    latestVersion,
    releaseUrl: release.html_url || `https://github.com/${GITHUB_REPO}/releases`,
    downloadUrl: installer?.browser_download_url ?? null,
    name: release.name || latestVersion,
    body: (release.body || "").slice(0, 2000),
  };
}
