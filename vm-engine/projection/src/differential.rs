//! 投影差分测试套件(T-SC1 / T-SC4 / ZR-P3 / ZR-P5 / ZR-P6;WP-1 §10.2 / §10.5
//! 方法,WP-7 完成标准)。
//!
//! # 方法(WP-1 §10.2 冻结方法的引擎侧落地)
//!
//! 取 fixture 题目,仅替换秘密(长度变体 8 / 16 / 32 / 64 字节 + 同长不同值
//! 变体),布局、代码与玩家动作脚本完全相同;动作脚本包含**探针变体**——
//! 对可见区域外固定地址(`PROBE_ADDR`)的写动作在双布局下执行:布局 A 该
//! 地址为隐藏映射,布局 B 为未映射(I-9:两者的全部可观测结果必须一致);
//! 逐动作回放收集响应,判定:**全部响应经规范化序列化后逐字节相等**
//! (差异字段注册表 = 空集,I-10 默认无豁免)。
//!
//! # 动作脚本的执行语义(模拟 WP-8 编排侧接线的小型闭环)
//!
//! 玩家写动作先经 [`crate::policy::ProjectionPolicy::classify_write_range`]
//! 三分类闸:Covered 才进引擎(权限不足由引擎教学性失败);CrossesBoundary /
//! Invisible 执行前拒绝(revision 不动)——拒绝与教学失败的响应面形态
//! 一并在差分断言的覆盖之内。

use alloc::string::String;
use alloc::vec;
use alloc::vec::Vec;

use vm_core::arch::ArchValue;
use vm_core::exec::{PauseOn, RunOutcome};

use crate::error::{RejectionReason, from_exec_error};
use crate::policy::{ErrorDetailLevel, WriteTargetClass};
use crate::project::{ProjectionStatics, full_projection};
use crate::response::{executed_action, rejected_from_reason};
use crate::testkit::{
    self, A32, BUFFER_BASE, GATE_BASE, PROBE_ADDR, build_engine, policy_with_level, statics,
    view_for,
};
use crate::types::CanonicalText;

/// 玩家动作脚本步(教学动作子集;覆盖执行 / 教学失败 / 执行前拒绝三形态)。
enum Step {
    /// `write_bytes`(执行前三分类闸)。
    Write { addr: u64, data: &'static [u8] },
    /// `push`。
    Push(u64),
    /// `pop`。
    Pop,
    /// `step`(引擎单步)。
    Tick,
    /// `run_to_event`(写事件暂停)。
    RunToWrite,
    /// `call`(调用入口)。
    CallEntry,
    /// `ret`。
    Ret,
    /// `pause`。
    Pause,
    /// `reset`(引擎权威重置路径)。
    Reset,
}

/// 固定动作脚本(全部变体共用;秘密不参与脚本构造)。
fn script() -> Vec<Step> {
    vec![
        // 1 可见缓冲区写(执行,+1)。
        Step::Write {
            addr: BUFFER_BASE + 0x100,
            data: b"AAAAAAAAAAAAAAAA",
        },
        // 2 相邻写(增量合并面,+1)。
        Step::Write {
            addr: BUFFER_BASE + 0x110,
            data: b"BBBBBBBB",
        },
        // 3 探针:PROBE_ADDR(布局 A = 隐藏映射;布局 B = 未映射;拒绝,+0)。
        Step::Write {
            addr: PROBE_ADDR,
            data: b"\xde\xad\xbe\xef",
        },
        // 4 探针对照:恒未映射地址(拒绝,+0;两布局同形态)。
        Step::Write {
            addr: 0x3000_0000,
            data: b"\xde\xad\xbe\xef",
        },
        // 5 越出可见边界(起点可见 + 跨界;拒绝,+0)。
        Step::Write {
            addr: BUFFER_BASE + 0xFF8,
            data: b"\x00\x11\x22\x33\x44\x55\x66\x77\x88\x99\xaa\xbb\xcc\xdd\xee\xff",
        },
        // 6 可见但只读区域(教学性失败 permission_denied,+1)。
        Step::Write {
            addr: GATE_BASE,
            data: b"\x01\x02\x03\x04",
        },
        // 7 push(栈写事件,+1)。
        Step::Push(0x41),
        // 8 pop(栈读事件,+1)。
        Step::Pop,
        // 9 step(寄存器 + 控制流变化,+1)。
        Step::Tick,
        // 10 run_to_event 写暂停(栈写事件 + status=paused,+1)。
        Step::RunToWrite,
        // 11 call(调用帧 + 调用事件,+1)。
        Step::CallEntry,
        // 12 ret(返回事件 + 帧销毁,+1)。
        Step::Ret,
        // 13 pause(状态无变化边缘:delta status 缺席,+1)。
        Step::Pause,
        // 14 reset(权威重置:状态 / 内存 / 事件日志回初始,+1)。
        Step::Reset,
        // 15 重置后再写(回退后续动作的增量面,+1)。
        Step::Write {
            addr: BUFFER_BASE + 0x100,
            data: b"CCCC",
        },
    ]
}

/// 回放脚本并收集规范化响应序列(全部变体共用同一 runner;确定性纯函数)。
fn run_script(
    secret: &[u8],
    seed: &[u8],
    hidden_mapped: bool,
    level: ErrorDetailLevel,
) -> Vec<String> {
    let policy = policy_with_level(level);
    let statics: ProjectionStatics = statics();
    let mut engine = build_engine(secret, seed, hidden_mapped);
    let mut revision: u64 = 0;
    let mut pause_reason: Option<crate::types::PauseKind> = None;
    let mut responses: Vec<String> = Vec::new();
    let mut before = full_projection(
        revision,
        &view_for(&policy, &statics, &engine, pause_reason),
        &engine.state,
    )
    .expect("初始投影");

    for step in script() {
        // 动作前事件日志长度(私有事件段切片锚点)。
        let log_len = engine.state.private_event_log.len();
        let mut executed = false;
        match &step {
            Step::Write { addr, data } => {
                let length = data.len() as u64;
                match policy.classify_write_range(&engine.state.memory, *addr, length) {
                    WriteTargetClass::Covered { .. } => {
                        let outcome = engine.action_write_bytes(ArchValue::new(*addr, A32), data);
                        executed = true;
                        let error = outcome.err().map(|error| {
                            from_exec_error(&error, &policy, &engine.state.memory)
                                .expect("教学性失败粗化")
                        });
                        let view = view_for(&policy, &statics, &engine, pause_reason);
                        let response = executed_action(
                            revision + 1,
                            &view,
                            &before,
                            &engine.state,
                            &engine.state.private_event_log[log_len..],
                            error,
                        )
                        .expect("已执行响应装配");
                        responses.push(response.to_canonical());
                    }
                    WriteTargetClass::CrossesBoundary { region_id, covered } => {
                        let response = rejected_from_reason(
                            revision,
                            &RejectionReason::WriteCrossesVisibleBoundary {
                                region_id,
                                covered,
                                requested: length,
                                address: *addr,
                            },
                            &policy,
                            &engine.state,
                        )
                        .expect("越界拒绝粗化");
                        responses.push(response.to_canonical());
                    }
                    WriteTargetClass::Invisible => {
                        let response = rejected_from_reason(
                            revision,
                            &RejectionReason::InvisibleWriteTarget { address: *addr },
                            &policy,
                            &engine.state,
                        )
                        .expect("不可见拒绝粗化");
                        responses.push(response.to_canonical());
                    }
                }
            }
            Step::Push(value) => {
                let outcome = engine.action_push(ArchValue::new(*value, A32));
                assert!(outcome.is_ok(), "fixture push 应成功");
                executed = true;
                let view = view_for(&policy, &statics, &engine, pause_reason);
                let response = executed_action(
                    revision + 1,
                    &view,
                    &before,
                    &engine.state,
                    &engine.state.private_event_log[log_len..],
                    None,
                )
                .expect("已执行响应装配");
                responses.push(response.to_canonical());
            }
            Step::Pop => {
                let outcome = engine.action_pop();
                assert!(outcome.is_ok(), "fixture pop 应成功");
                executed = true;
                let view = view_for(&policy, &statics, &engine, pause_reason);
                let response = executed_action(
                    revision + 1,
                    &view,
                    &before,
                    &engine.state,
                    &engine.state.private_event_log[log_len..],
                    None,
                )
                .expect("已执行响应装配");
                responses.push(response.to_canonical());
            }
            Step::Tick => {
                assert!(matches!(engine.step(), RunOutcome::Stepped));
                executed = true;
                let view = view_for(&policy, &statics, &engine, pause_reason);
                let response = executed_action(
                    revision + 1,
                    &view,
                    &before,
                    &engine.state,
                    &engine.state.private_event_log[log_len..],
                    None,
                )
                .expect("已执行响应装配");
                responses.push(response.to_canonical());
            }
            Step::RunToWrite => {
                assert!(matches!(
                    engine.run_to_event(PauseOn::Write),
                    RunOutcome::Paused { .. }
                ));
                executed = true;
                pause_reason = Some(crate::types::PauseKind::Write);
                let view = view_for(&policy, &statics, &engine, pause_reason);
                let response = executed_action(
                    revision + 1,
                    &view,
                    &before,
                    &engine.state,
                    &engine.state.private_event_log[log_len..],
                    None,
                )
                .expect("已执行响应装配");
                responses.push(response.to_canonical());
            }
            Step::CallEntry => {
                assert!(engine.action_call(ArchValue::new(0, A32)).is_ok());
                executed = true;
                let view = view_for(&policy, &statics, &engine, pause_reason);
                let response = executed_action(
                    revision + 1,
                    &view,
                    &before,
                    &engine.state,
                    &engine.state.private_event_log[log_len..],
                    None,
                )
                .expect("已执行响应装配");
                responses.push(response.to_canonical());
            }
            Step::Ret => {
                assert!(engine.action_ret().is_ok());
                executed = true;
                let view = view_for(&policy, &statics, &engine, pause_reason);
                let response = executed_action(
                    revision + 1,
                    &view,
                    &before,
                    &engine.state,
                    &engine.state.private_event_log[log_len..],
                    None,
                )
                .expect("已执行响应装配");
                responses.push(response.to_canonical());
            }
            Step::Pause => {
                engine.pause();
                executed = true;
                let view = view_for(&policy, &statics, &engine, pause_reason);
                let response = executed_action(
                    revision + 1,
                    &view,
                    &before,
                    &engine.state,
                    &engine.state.private_event_log[log_len..],
                    None,
                )
                .expect("已执行响应装配");
                responses.push(response.to_canonical());
            }
            Step::Reset => {
                engine.reset();
                executed = true;
                pause_reason = None;
                let view = view_for(&policy, &statics, &engine, pause_reason);
                // reset 清空私有事件日志:重置步不承载事件段(历史回退
                // 不重发历史事件,与 undo 同纪律)。
                let response =
                    executed_action(revision + 1, &view, &before, &engine.state, &[], None)
                        .expect("已执行响应装配");
                responses.push(response.to_canonical());
            }
        }
        if executed {
            revision += 1;
        } else {
            // 拒绝形态自检(ZR-P5:revision 不动;status = rejected 且错误必有)。
            let last = responses.last().expect("拒绝响应已产出");
            assert!(last.contains("\"status\":\"rejected\""));
            assert!(last.contains("\"projectionDelta\":null"));
            assert!(last.contains("\"publicEvents\":[]"));
            assert!(last.contains(&alloc::format!("\"revision\":{revision}")));
        }
        // 前置投影推进(拒绝时状态未变,幂等)。
        before = full_projection(
            revision,
            &view_for(&policy, &statics, &engine, pause_reason),
            &engine.state,
        )
        .expect("投影推进");
    }
    assert_eq!(responses.len(), script().len());
    responses
}

/// 秘密变体(长度 8/16/32/64 + 同长异值;合成字节,非真实题目内容)。
fn secret_variants() -> Vec<&'static [u8]> {
    vec![
        b"\x11\x11\x11\x11\x11\x11\x11\x11",
        b"\x11\x11\x11\x11\x11\x11\x11\x11\x11\x11\x11\x11\x11\x11\x11\x11",
        b"\x11\x11\x11\x11\x11\x11\x11\x11\x11\x11\x11\x11\x11\x11\x11\x11\
          \x11\x11\x11\x11\x11\x11\x11\x11\x11\x11\x11\x11\x11\x11\x11\x11",
        b"\x11\x11\x11\x11\x11\x11\x11\x11\x11\x11\x11\x11\x11\x11\x11\x11\
          \x11\x11\x11\x11\x11\x11\x11\x11\x11\x11\x11\x11\x11\x11\x11\x11\
          \x11\x11\x11\x11\x11\x11\x11\x11\x11\x11\x11\x11\x11\x11\x11\x11\
          \x11\x11\x11\x11\x11\x11\x11\x11\x11\x11\x11\x11\x11\x11\x11\x11",
        // 同长异值(与 16 字节变体同长不同值)。
        b"\xee\x21\x43\x65\x87\xa9\xcb\xed\x10\x32\x54\x76\x98\xba\xdc\xfe",
    ]
}

/// T-SC1(10.2):秘密变体(长度 + 同长异值)下全部响应逐字节相等;
/// 探针变体的 I-9 双布局等价;T-SC4(10.5):seed 变体差异字段注册表空集;
/// 同 seed 同脚本两次运行字节一致(6.3 确定性前提)。
#[test]
fn tsc1_tsc4_probe_variant_responses_are_byte_identical() {
    let seed_a: &[u8] = &[];
    let seed_b: &[u8] = &[0x5A, 0xC3, 0x99, 0x37, 0x11, 0x8E, 0x40, 0xB2];

    let base = run_script(
        secret_variants()[1],
        seed_a,
        true,
        ErrorDetailLevel::Educational,
    );
    // 同 seed 确定性(前提)。
    let replay = run_script(
        secret_variants()[1],
        seed_a,
        true,
        ErrorDetailLevel::Educational,
    );
    assert_eq!(base, replay, "同 seed 同脚本两次运行应逐字节一致");

    // T-SC1:长度变体 + 同长异值,全部与基线逐字节相等(差异注册表空集)。
    for variant in secret_variants() {
        let responses = run_script(variant, seed_a, true, ErrorDetailLevel::Educational);
        assert_eq!(
            responses, base,
            "秘密变体下的响应序列应与基线逐字节相等(T-SC1)"
        );
    }

    // T-SC4:seed 变体(声明注册表 = 空集 ⇒ 任何字段差异即违规)。
    let seeded = run_script(
        secret_variants()[1],
        seed_b,
        true,
        ErrorDetailLevel::Educational,
    );
    assert_eq!(seeded, base, "seed 变体的响应序列应与基线逐字节相等(T-SC4)");

    // I-9 探针双布局:PROBE_ADDR 隐藏映射(布局 A)vs 未映射(布局 B)
    // ——整条脚本响应逐字节一致(探针不可绘制隐藏区域边界)。
    let unmapped_layout = run_script(
        secret_variants()[1],
        seed_a,
        false,
        ErrorDetailLevel::Educational,
    );
    assert_eq!(
        unmapped_layout, base,
        "探针地址的隐藏映射与未映射布局应逐字节一致(I-9)"
    );

    // ZR-P5:revision 稠密——脚本 15 步中 12 步执行(+1)、3 步拒绝(+0),
    // 末响应 revision = 12,响应序列内 revision 单调、增量 ∈ {0,+1}。
    // 每响应取**最后一次**出现的 "revision":(信封值;delta 内的在前)。
    let increments: Vec<u64> = base
        .iter()
        .map(|text| {
            let tail = text.rsplit("\"revision\":").next().expect("非空拆分");
            let digits: String = tail.chars().take_while(char::is_ascii_digit).collect();
            digits.parse::<u64>().expect("revision 十进制数字")
        })
        .collect();
    assert_eq!(increments.len(), 15);
    let mut previous: i64 = 0;
    for (index, value) in increments.iter().enumerate() {
        let delta = *value as i64 - previous;
        assert!(
            delta == 0 || delta == 1,
            "revision 增量必须 ∈ {{0,+1}}(第 {index} 步增量 {delta})"
        );
        previous = *value as i64;
    }
    assert_eq!(previous, 12, "12 步执行 ⇒ 末 revision = 12");
}

/// 语料扫描(ZR-B1 兜底法):秘密字节的十六进制形态不出现在任何响应中;
/// 红灯反例:把秘密区加入白名单的"泄漏策略"必须被扫描器检出
/// (证明扫描器在真实违规样例上触发——自检纪律)。
#[test]
fn secret_corpus_never_appears_and_scanner_fires_on_leaky_policy() {
    let secret = secret_variants()[1];
    let responses = run_script(secret, &[], true, ErrorDetailLevel::Educational);
    // 良性策略:零命中(结构性白名单的兜底验证)。
    assert!(
        !testkit::leak_detected(&responses, secret),
        "良性策略下响应不得出现秘密语料"
    );

    // 红灯反例:泄漏策略(白名单含秘密区)→ 全量投影携带秘密区内容 →
    // 扫描器必须检出。
    let leaky_policy = crate::policy::ProjectionPolicy::assemble(
        crate::policy::ProjectionPolicySpec {
            visible_regions: vec![
                String::from("code"),
                String::from("buffer"),
                String::from("gate"),
                String::from("stack"),
                String::from("secret"),
            ],
            visible_objects: Vec::new(),
            visible_registers: vec![String::from("RAX"), String::from("RSP")],
            max_bytes_per_range: None,
            error_detail_level: ErrorDetailLevel::Educational,
        },
        &crate::policy::SecretSinkSet::new(vec![String::from("RKEY"), String::from("FLAG_K")]),
    )
    .expect("泄漏策略装配(策略面合法——泄漏面在投影)");
    let statics_with_secret = ProjectionStatics::assemble(
        vec![
            (String::from("code"), String::from("代码区")),
            (String::from("buffer"), String::from("教学缓冲区")),
            (String::from("gate"), String::from("只读数据")),
            (String::from("stack"), String::from("栈")),
            (String::from("secret"), String::from("机密区")),
        ],
        vec![],
    )
    .expect("泄漏静态面装配");
    let engine = build_engine(secret, &[], true);
    let leak_projection = full_projection(
        0,
        &view_for(&leaky_policy, &statics_with_secret, &engine, None),
        &engine.state,
    )
    .expect("泄漏投影生成");
    let leak_text = vec![leak_projection.to_canonical()];
    assert!(
        testkit::leak_detected(&leak_text, secret),
        "红灯反例:泄漏策略必须被语料扫描检出(扫描器自检)"
    );
}

/// ZR-P6(coarse 级载荷零解释字段机检):coarse 级下全部错误载荷只含
/// code + message(无 explanation 键);结构性地址形态保留
/// (null-only 恒 null);coarse 级同样满足 T-SC1 秘密变体字节等价。
#[test]
fn coarse_level_payloads_have_zero_explanation_fields() {
    let secret = secret_variants()[1];
    let coarse = run_script(secret, &[], true, ErrorDetailLevel::Coarse);
    let coarse_other = run_script(secret_variants()[3], &[], true, ErrorDetailLevel::Coarse);
    assert_eq!(
        coarse, coarse_other,
        "coarse 级同样满足 T-SC1 秘密变体字节等价(ZR-P6 判定基准)"
    );
    for text in &coarse {
        assert!(
            !text.contains("\"explanation\""),
            "coarse 级载荷不得携带解释字段(ZR-P6):{text}"
        );
        assert!(
            !text.contains("\"hints\""),
            "coarse 级载荷不得携带教学提示(ZR-P6):{text}"
        );
    }
    // 结构性地址形态不受级别影响:inaccessible_address 恒 null(E-2/I-9),
    // teaching 失败(第 6 步 permission_denied,required-real)仍带真实地址。
    let rejected_probe = &coarse[2];
    assert!(rejected_probe.contains("\"addressHex\":null"));
    assert!(rejected_probe.contains("\"code\":\"inaccessible_address\""));
    let teaching_failure = &coarse[5];
    assert!(
        teaching_failure.contains("\"code\":\"permission_denied\""),
        "教学失败错误码不受级别影响:{teaching_failure}"
    );
    assert!(
        teaching_failure.contains("\"addressHex\":\"0x21000000\""),
        "required-real 地址在 coarse 级保留(矩阵结构性必填):{teaching_failure}"
    );

    // educational 对照:同位置错误携带解释字段(正例控制——证明 coarse 的
    // 零解释是级别裁剪的结果,不是脚本恰好无错误)。
    let educational = run_script(secret, &[], true, ErrorDetailLevel::Educational);
    assert!(
        educational[2].contains("\"explanation\""),
        "educational 级探针拒绝应携带解释字段(正例控制)"
    );
    // I-9 对照:双布局在 coarse 级同样逐字节一致。
    let coarse_unmapped = run_script(secret, &[], false, ErrorDetailLevel::Coarse);
    assert_eq!(coarse, coarse_unmapped);
}

/// 教学失败面(第 6 步)与拒绝面(第 3/4/5 步)的形态锚:错误码、
/// 地址形态与 revision 行为的具名断言(不依赖差分等价的单点可读性)。
#[test]
fn response_shapes_anchor_error_codes_and_addresses() {
    let educational = run_script(
        secret_variants()[1],
        &[],
        true,
        ErrorDetailLevel::Educational,
    );
    // 第 3 步:不可见写拒绝(I-9 统一形态;目标值回显在解释字段)。
    let probe = &educational[2];
    assert!(probe.contains("\"status\":\"rejected\""));
    assert!(probe.contains("\"code\":\"inaccessible_address\""));
    assert!(probe.contains("\"addressHex\":null"));
    assert!(probe.contains("\"valueHex\":\"0x50000000\""), "{probe}");
    // 第 5 步:越界拒绝(offset_out_of_range;expected = 可见边界,actual = 请求长)。
    let crossing = &educational[4];
    assert!(crossing.contains("\"code\":\"offset_out_of_range\""));
    assert!(crossing.contains("\"expectedBytesLength\":8"));
    assert!(crossing.contains("\"actualBytesLength\":16"));
    // 第 6 步:教学失败(已执行;revision 前进;permission_denied required-real)。
    let teaching = &educational[5];
    assert!(teaching.contains("\"code\":\"permission_denied\""));
    assert!(teaching.contains("\"permissions\":\"r\""));
    assert!(teaching.contains("\"regionId\":\"gate\""));
    assert!(!teaching.contains("\"status\":\"rejected\""));
    // 第 13/14 步:pause(状态无变化 ⇒ delta status 缺席,响应内 status 键
    // 仅信封 1 处)与 reset(running);对照 run_to_write 步(delta + 信封
    // 各 1 处 = 2 处)。
    assert_eq!(
        educational[12].matches("\"status\"").count(),
        1,
        "pause 步状态无变化:delta 不携带 status(存在性确定性,I-4)"
    );
    assert_eq!(
        educational[9].matches("\"status\"").count(),
        2,
        "run_to_write 步 status 变化:delta 与信封各携带一次"
    );
    assert!(educational[13].contains("\"status\":\"running\""));
}
