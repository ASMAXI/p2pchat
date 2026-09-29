---
name: Tauri Linux packaging
description: Environment-specific constraints for building the Tauri desktop shell on Replit's Nix Linux environment
---

Tauri's Linux WebKit stack can expose zlib through pkg-config without passing
its library directory to the final Rust linker. The build script should
discover the zlib `-L` path through pkg-config and emit it as a native linker
search path.

**Why:** Without that path, release linking fails with `ld: cannot find -lz`
even after zlib is installed as a Nix system dependency.

**How to apply:** Prefer the Debian bundle for a distributable Linux package
in a headless Replit environment. AppImage bundling may additionally expect
`/usr/bin/xdg-open`; Windows installers still require a Windows-capable build
runner.