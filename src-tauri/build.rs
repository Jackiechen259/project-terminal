use std::fs;
use std::path::PathBuf;

fn main() {
    tauri_build::build();

    // The application binary gets a Common-Controls v6 manifest (tauri-build
    // emits it), which is what lets the loader bind the SxS comctl32 that
    // exports TaskDialogIndirect. `cargo test` harnesses are NOT processed by
    // tauri-build, so without this the test process would bind the system
    // comctl32 (v5), fail to resolve TaskDialogIndirect (imported by muda's
    // tray/menu implementation) and die at load time with
    // STATUS_ENTRYPOINT_NOT_FOUND before a single test runs.
    if std::env::var("CARGO_CFG_WINDOWS").is_ok() {
        let out_dir = PathBuf::from(std::env::var("OUT_DIR").unwrap());
        let manifest = out_dir.join("test-harness.manifest");
        fs::write(
            &manifest,
            r#"<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<assembly xmlns="urn:schemas-microsoft-com:asm.v1" manifestVersion="1.0">
  <dependency>
    <dependentAssembly>
      <assemblyIdentity type="win32" name="Microsoft.Windows.Common-Controls" version="6.0.0.0" processorArchitecture="*" publicKeyToken="6595b64144ccf1df" language="*"></assemblyIdentity>
    </dependentAssembly>
  </dependency>
</assembly>
"#,
        )
        .expect("write test harness manifest");
        // `rustc-link-arg-tests` targets the explicit `[[test]]` unit target
        // declared in Cargo.toml. It must not use the plain `rustc-link-arg`
        // form: that also hits the bin targets, which already receive
        // tauri-build's manifest resource and would fail to link on a
        // duplicate MANIFEST resource.
        println!("cargo:rustc-link-arg-tests=/MANIFEST:EMBED");
        println!(
            "cargo:rustc-link-arg-tests=/MANIFESTINPUT:{}",
            manifest.display()
        );
    }

    // Vendor the xterm.js runtime into the daemon binary so the mobile remote
    // page renders ANSI terminal output without depending on a CDN. The files
    // live in the frontend's node_modules; build.rs copies them into OUT_DIR
    // where `include_str!` can pick them up at compile time.
    let manifest_dir = PathBuf::from(std::env::var("CARGO_MANIFEST_DIR").unwrap());
    let node_modules = manifest_dir
        .parent()
        .expect("src-tauri has a parent")
        .join("node_modules");
    let out_dir = PathBuf::from(std::env::var("OUT_DIR").unwrap());

    let assets = [
        ("@xterm/xterm/lib/xterm.js", "xterm.js"),
        ("@xterm/xterm/css/xterm.css", "xterm.css"),
        ("@xterm/addon-fit/lib/addon-fit.js", "xterm-addon-fit.js"),
        (
            "@xterm/addon-image/lib/addon-image.js",
            "xterm-addon-image.js",
        ),
        // Character widths. Without it the phone renders the same PTY bytes
        // at different widths than the desktop, so CJK and emoji columns do
        // not line up when a session is taken over mid-command.
        (
            "@xterm/addon-unicode-graphemes/lib/addon-unicode-graphemes.js",
            "xterm-addon-unicode-graphemes.js",
        ),
    ];

    for (src_rel, dst_name) in assets {
        let src = node_modules.join(src_rel);
        let dst = out_dir.join(dst_name);
        if let Err(error) = fs::read(&src).and_then(|data| fs::write(&dst, &data)) {
            panic!("Could not vendor {src_rel} for the mobile remote page: {error}. Run `pnpm install` first.");
        }
        println!("cargo:rerun-if-changed={}", src.display());
    }
}
