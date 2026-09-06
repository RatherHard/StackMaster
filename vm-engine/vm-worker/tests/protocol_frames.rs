//! 帧层 fail-closed 反例矩阵(引擎进程协议 §三 / §八机检;每条协议层违规
//! 必有红灯:超限 / 畸形 / 半包 / 非 UTF-8 / 重复键 / 孤立代理项 / 非对象)。

use std::io::Cursor;

use vm_worker::contract::strict_value::StrictValue;
use vm_worker::protocol::frame::{FrameError, FrameReader, FrameWriter};
use vm_worker::protocol::version::MAX_FRAME_BYTES;

fn read_one(input: &[u8]) -> Result<Option<StrictValue>, FrameError> {
    let mut reader = FrameReader::new(Cursor::new(input.to_vec()));
    reader.read_frame()
}

/// 帧载荷 + 行界 LF。
fn framed(payload: &[u8]) -> Vec<u8> {
    payload
        .iter()
        .copied()
        .chain(std::iter::once(b'\n'))
        .collect()
}

fn expect_error(input: &[u8], expected: &FrameError) {
    let error = read_one(input).expect_err("违规输入必须被帧层拒绝(fail-closed)");
    assert_eq!(&error, expected, "错误类别不匹配:{error:?}");
}

#[test]
fn valid_frame_parses_to_object() {
    let frame = read_one(&framed(br#"{"type":"shutdown","seq":1}"#))
        .expect("合法帧必须被接受")
        .expect("单帧不应为 EOF");
    assert!(frame.get("type").is_some());
}

#[test]
fn clean_eof_yields_none() {
    assert_eq!(read_one(b"").unwrap(), None);
}

#[test]
fn oversized_frame_fails_without_waiting_for_newline() {
    // 超限 + 无行界:到达上限即失败,不等待、不消费后续字节。
    let mut payload = vec![b'1'; MAX_FRAME_BYTES + 1];
    expect_error(&payload, &FrameError::FrameTooLarge);
    // 超限 + 有行界:同样拒绝。
    payload.push(b'\n');
    expect_error(&payload, &FrameError::FrameTooLarge);
}

#[test]
fn frame_at_exact_limit_reaches_object_check() {
    // 恰在上限的载荷:帧层放行(超限严格按"载荷字节数 > 上限"判定);
    // 内容为字符串字面量,顶层非对象 → 在对象判定处拒绝。
    let mut payload = vec![b'"'];
    payload.resize(MAX_FRAME_BYTES - 1, b'a');
    payload.push(b'"');
    payload.push(b'\n');
    let error = read_one(&payload).unwrap_err();
    assert_eq!(error, FrameError::NotAnObject);
}

#[test]
fn truncated_frame_at_eof_fails_closed() {
    expect_error(b"{\"type\":\"shutdown\"", &FrameError::TruncatedFrame);
}

#[test]
fn invalid_utf8_fails_closed() {
    expect_error(b"{\"a\":\"\xff\xfe\"}\n", &FrameError::InvalidUtf8);
}

#[test]
fn malformed_json_fails_closed() {
    expect_error(&framed(b"not json"), &FrameError::MalformedJson);
    // 空行(空载荷)同样是畸形帧。
    expect_error(b"\n", &FrameError::MalformedJson);
    // 尾随垃圾。
    expect_error(&framed(b"{} trailing"), &FrameError::MalformedJson);
}

#[test]
fn duplicate_key_fails_closed() {
    expect_error(
        &framed(br#"{"type":"shutdown","type":"load","seq":1}"#),
        &FrameError::DuplicateKey,
    );
    // 语义同键的精确拼写形态("\u0074ype" 即 "type",XS-DUP-KEY 对齐)。
    expect_error(
        &framed(br#"{"\u0074ype":"shutdown","type":"load","seq":1}"#),
        &FrameError::DuplicateKey,
    );
}

#[test]
fn lone_surrogate_fails_closed() {
    expect_error(&framed(br#"{"a":"\ud800"}"#), &FrameError::LoneSurrogate);
}

#[test]
fn non_object_frame_fails_closed() {
    expect_error(&framed(b"[1,2]"), &FrameError::NotAnObject);
    expect_error(&framed(b"\"command\""), &FrameError::NotAnObject);
    expect_error(&framed(b"42"), &FrameError::NotAnObject);
}

#[test]
fn multiple_frames_read_sequentially() {
    let mut stream = framed(br#"{"type":"shutdown","seq":1}"#);
    stream.extend(framed(br#"{"a":true}"#));
    let mut reader = FrameReader::new(Cursor::new(stream));
    assert!(reader.read_frame().unwrap().is_some());
    assert!(reader.read_frame().unwrap().is_some());
    assert_eq!(reader.read_frame().unwrap(), None);
}

#[test]
fn cr_before_lf_is_json_whitespace_and_accepted() {
    // LF 是唯一帧界;LF 前的 CR 是合法 JSON 空白(CRLF 容忍,非规范形态)。
    assert!(read_one(b"{}\r\n").unwrap().is_some());
}

#[test]
fn writer_emits_exactly_one_line_per_frame() {
    let mut out: Vec<u8> = Vec::new();
    {
        let mut writer = FrameWriter::new(&mut out);
        writer
            .write_frame(&serde_json::json!({
                "type": "ready",
                "note": "line\nfeed\tand \"quote\" stay escaped"
            }))
            .expect("写帧必须成功");
    }
    let text = String::from_utf8(out.clone()).unwrap();
    // 恰一行,且以 LF 结束;字符串内的 LF 保持转义(帧界无歧义的依据)。
    assert_eq!(text.matches('\n').count(), 1);
    assert!(text.ends_with('\n'));
    assert!(!text.contains("line\nfeed"));
    // 写出的帧可被自己的读侧解析(往返闭合)。
    assert!(read_one(&out).unwrap().is_some());
}
