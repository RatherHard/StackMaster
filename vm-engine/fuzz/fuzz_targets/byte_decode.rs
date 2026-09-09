#![no_main]
//! fuzz 目标:字节模式取指译码器(gadget 路径:任意字节 × 任意取指地址)。
//!
//! 输入布局:[0] 位宽选择(0 → 32,其余 → 64);[1] 取指地址(字节偏移);
//! [2] 编码表条目数(0–4);其后每条目 2 字节(token + 形态菜单);余下
//! 全部为代码字节。
//!
//! 判定纪律:任意输入不 panic;译码成功时 `next` 必须严格前进且不越过
//! 可用字节(有界推进不变量;违反 = 译码器缺陷,直接断言崩溃报给
//! libFuzzer)。

use libfuzzer_sys::fuzz_target;
use vm_core::arch::ArchBits;
use vm_core::decode::{decode_slice, EncodingIndex};
use vm_core::instr::{BaselineOp, EncodingOperandShape, EncodingTableEntry, Op};

fuzz_target!(|data: &[u8]| {
    let Some((&arch_byte, data)) = data.split_first() else {
        return;
    };
    let Some((&at_byte, data)) = data.split_first() else {
        return;
    };
    let Some((&count_byte, data)) = data.split_first() else {
        return;
    };
    let arch = if arch_byte == 0 {
        ArchBits::B32
    } else {
        ArchBits::B64
    };
    let count = (count_byte as usize % 5).min(data.len() / 2);
    let mut entries = Vec::new();
    for index in 0..count {
        let Some(pair) = data.get(index * 2..index * 2 + 2) else {
            break;
        };
        let shape = match pair[1] % 4 {
            0 => EncodingOperandShape::ImmediateArch,
            1 => EncodingOperandShape::Register(String::from("RAX")),
            2 => EncodingOperandShape::Memory {
                base: String::from("RSP"),
            },
            _ => EncodingOperandShape::Interface(0x21),
        };
        entries.push(EncodingTableEntry {
            token: pair[0],
            op: Op::Baseline(BaselineOp::Mov),
            operand_shapes: vec![shape],
        });
    }
    let code = &data[count * 2..];
    let index = EncodingIndex::new(&entries);
    if let Ok((_, next)) = decode_slice(&index, arch, code, at_byte as usize) {
        assert!(
            next > at_byte as usize && next <= code.len(),
            "译码有界推进不变量被破坏:next={next}, code_len={}",
            code.len()
        );
    }
});
