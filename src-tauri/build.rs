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

    println!("cargo:rerun-if-changed=src/remote/remote_page.html");
    println!("cargo:rerun-if-changed=src/remote/remote_renderer.js");
}
