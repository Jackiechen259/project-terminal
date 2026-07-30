use std::fs;
use std::path::PathBuf;

fn main() {
    tauri_build::build();

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
        ("@xterm/addon-image/lib/addon-image.js", "xterm-addon-image.js"),
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
