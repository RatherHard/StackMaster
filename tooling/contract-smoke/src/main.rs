//! 冒烟入口:`cargo run -p contract-smoke`(或经根 package.json 的
//! `pnpm smoke:contract`)。任一检查失败即非零退出。

fn main() {
    match contract_smoke::smoke::run_all() {
        Ok(report) => {
            println!(
                "契约冒烟通过:Schema 编译 {} 个,有效样例 {} 接受,非法样例 {} 拒绝,摘要比对 {} 条,serde/schemars 消费 {} 项,private-bundle 消费 {} 项",
                report.schemas_compiled,
                report.valid_instances_checked,
                report.invalid_instances_rejected,
                report.manifest_entries_compared,
                report.serde_mirrors_checked,
                report.private_bundle_checks,
            );
        }
        Err(message) => {
            eprintln!("契约冒烟失败:{message}");
            std::process::exit(1);
        }
    }
}
