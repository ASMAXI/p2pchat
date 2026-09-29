fn main() {
    // Some Nix environments expose zlib to pkg-config but do not forward
    // its library directory to the final Rust linker invocation. Tauri's
    // WebKit stack pulls zlib transitively, so add the discovered directory
    // explicitly when it is available.
    if let Ok(output) = std::process::Command::new("pkg-config")
        .args(["--variable=libdir", "zlib"])
        .output()
    {
        let path = String::from_utf8_lossy(&output.stdout).trim().to_owned();
        if !path.is_empty() {
            println!("cargo:rustc-link-search=native={path}");
            // WebKit's transitive zlib link can be emitted by a dependency
            // crate, so also pass the search path to the final linker.
            println!("cargo:rustc-link-arg=-L{path}");
        }
    }

    println!("cargo:rerun-if-changed=build.rs");
    tauri_build::build()
}