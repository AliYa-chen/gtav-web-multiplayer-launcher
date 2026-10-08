#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]
fn main() {
    let args: Vec<_> = std::env::args_os().collect();
    if args.get(1).and_then(|s| s.to_str()) == Some("--verify-resources") {
        if args.len() != 4 { eprintln!("用法：启动器 --verify-resources 游戏目录 外部测试缓存目录"); std::process::exit(2); }
        match gta5data_launcher_lib::verify_resources(std::path::Path::new(&args[2]), std::path::Path::new(&args[3])) {
            Ok(report) => println!("{}", serde_json::to_string_pretty(&report).unwrap()),
            Err(error) => { eprintln!("{error}"); std::process::exit(1); }
        }
    } else { gta5data_launcher_lib::run(); }
}
