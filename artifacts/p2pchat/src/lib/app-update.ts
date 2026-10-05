export type AppUpdateInfo = {
  upToDate: boolean;
  currentVersion: string;
  latestVersion: string;
  releaseUrl: string;
  downloadUrl: string | null;
  /** GitHub Releases asset digest (`sha256:…`) when present. */
  sha256: string | null;
  name: string;
  body: string;
};

export const GITHUB_REPO = "ASMAXI/p2pchat";

/** Pulls `x.y.z` out of tags like `v0.8.9`, `drift-v0.8.9`, `p2pchat-v0.2.0`. */
function normalizeVersion(value: string): string {
  return value.match(/\d+\.\d+\.\d+/)?.[0] ?? value.trim().replace(/^v/i, "");
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

/** Accepts GitHub `digest` (`sha256:hex`) or a bare 64-char hex. */
export function normalizeAssetSha256(value: string | null | undefined): string | null {
  if (!value) return null;
  const trimmed = value.trim().replace(/^sha256:/i, "");
  return /^[a-f0-9]{64}$/i.test(trimmed) ? trimmed.toLowerCase() : null;
}

export async function currentAppVersion(): Promise<string> {
  try {
    if ("__TAURI_INTERNALS__" in window) {
      const { getVersion } = await import("@tauri-apps/api/app");
      return await getVersion();
    }
  } catch {
    // fall through
  }
  return "0.10.2";
}

type GithubReleaseAsset = {
  name: string;
  browser_download_url: string;
  digest?: string;
};

export function pickInstallerAsset(assets: GithubReleaseAsset[]): GithubReleaseAsset | null {
  return (
    assets.find((asset) => /setup\.exe$/i.test(asset.name)) ||
    assets.find((asset) => /\.msi$/i.test(asset.name)) ||
    assets.find((asset) => /drift.*\.exe$/i.test(asset.name) && !/portable/i.test(asset.name)) ||
    assets.find((asset) => /\.exe$/i.test(asset.name) && !/portable/i.test(asset.name)) ||
    null
  );
}

export async function checkForAppUpdate(): Promise<AppUpdateInfo> {
  const currentVersion = await currentAppVersion();
  const response = await fetch(`https://api.github.com/repos/${GITHUB_REPO}/releases/latest`, {
    headers: { Accept: "application/vnd.github+json" },
  });
  if (response.status === 404) {
    throw new Error("На GitHub пока нет опубликованного релиза");
  }
  if (!response.ok) {
    throw new Error(`GitHub Releases: HTTP ${response.status}`);
  }
  const release = (await response.json()) as {
    tag_name?: string;
    html_url?: string;
    name?: string;
    body?: string;
    assets?: GithubReleaseAsset[];
  };
  const latestVersion = normalizeVersion(release.tag_name || release.name || currentVersion);
  const assets = release.assets ?? [];
  const installer = pickInstallerAsset(assets);
  const upToDate = compareSemver(currentVersion, latestVersion) >= 0;
  return {
    upToDate,
    currentVersion,
    latestVersion,
    releaseUrl: release.html_url || `https://github.com/${GITHUB_REPO}/releases`,
    downloadUrl: installer?.browser_download_url ?? null,
    sha256: normalizeAssetSha256(installer?.digest),
    name: release.name || latestVersion,
    body: (release.body || "").slice(0, 2000),
  };
}

/** Desktop: downloads the installer with progress, verifies SHA-256, runs it and closes the app. */
export async function installAppUpdate(
  downloadUrl: string,
  onProgress?: (loaded: number, total: number | null, phase: string) => void,
  sha256?: string | null,
): Promise<void> {
  const digest = normalizeAssetSha256(sha256);
  if (!digest) {
    throw new Error(
      "В релизе нет SHA-256 установщика — обновление через приложение недоступно. Откройте страницу релиза и скачайте вручную.",
    );
  }
  const { invoke } = await import("@tauri-apps/api/core");
  let unlisten: (() => void) | undefined;
  try {
    const { listen } = await import("@tauri-apps/api/event");
    unlisten = await listen<{ loaded: number; total?: number | null; phase?: string }>(
      "update-progress",
      (event) => {
        onProgress?.(event.payload.loaded, event.payload.total ?? null, event.payload.phase ?? "download");
      },
    );
  } catch (error) {
    // Older ACL without core:event:allow-listen — still install, just no progress bar.
    console.warn("update-progress listen unavailable", error);
  }
  try {
    await invoke("install_update", { url: downloadUrl, sha256: digest });
  } finally {
    unlisten?.();
  }
}
