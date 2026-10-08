use std::{env, fs, path::PathBuf};

fn main() {
    // 白名单嵌入网页源码；client/runtime 和所有玩家游戏资源都不能进入应用。
    let root = PathBuf::from(env::var("CARGO_MANIFEST_DIR").unwrap()).join("../../client");
    let output = PathBuf::from(env::var("OUT_DIR").unwrap()).join("embedded-client");
    if output.exists() { fs::remove_dir_all(&output).expect("清理网页嵌入缓存"); }
    fn copy_tree(source: &std::path::Path, target: &std::path::Path) {
        fs::create_dir_all(target).expect("创建网页嵌入目录");
        for entry in fs::read_dir(source).expect("读取客户端源码") {
            let entry = entry.unwrap(); let path = entry.path();
            if entry.file_name() == "runtime" || entry.file_name() == ".DS_Store" { continue; }
            if entry.file_type().unwrap().is_symlink() { panic!("嵌入源码不能为符号链接"); }
            if path.is_dir() { copy_tree(&path, &target.join(entry.file_name())); }
            else if matches!(path.extension().and_then(|v| v.to_str()), Some("html"|"js"|"css"|"json"|"svg")) {
                fs::copy(&path, target.join(entry.file_name())).expect("嵌入客户端源码");
            }
        }
    }
    copy_tree(&root, &output);
    println!("cargo:rerun-if-changed={}", root.display());
    tauri_build::build();
}
