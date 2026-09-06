//! stdio NDJSON 帧层(引擎进程协议 §三冻结)。
//!
//! 一帧 = 一个 UTF-8 编码的 JSON 对象 + 恰一个 LF(0x0A)行界;JSON 文本内
//! LF 恒为 `\n` 转义,行边界即帧边界,无歧义(决策 D-F1)。半包语义:EOF 时
//! 缓冲非空 = 截断帧;行界前载荷超限立即失败,不再消费后续字节。一切帧层
//! 违规 fail-closed:输出尽力而为的 `protocol_error` 帧后终止进程(§六)。

use crate::contract::strict_value::StrictValue;
use serde::Serialize;
use std::io::{self, BufRead, ErrorKind, Write};

/// 帧层违规(§六违规表;`code()` 与协议文档错误码同串)。
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum FrameError {
    /// 读侧 IO 错误(管道断裂等)。
    Io(String),
    /// 行界前载荷超过 `MAX_FRAME_BYTES`(立即失败,不等待行界)。
    FrameTooLarge,
    /// EOF 时缓冲非空(半包)。
    TruncatedFrame,
    /// 帧载荷不是合法 UTF-8。
    InvalidUtf8,
    /// JSON 语法错误(含空行)。
    MalformedJson,
    /// 对象重复键(精确拼写比较,`"a"` 与 `"\u0061"` 同键)。
    DuplicateKey,
    /// 字符串含孤立代理项。
    LoneSurrogate,
    /// 顶层不是 JSON 对象。
    NotAnObject,
}

impl FrameError {
    pub fn code(&self) -> &'static str {
        match self {
            FrameError::Io(_) => "io_error",
            FrameError::FrameTooLarge => "frame_too_large",
            FrameError::TruncatedFrame => "truncated_frame",
            FrameError::InvalidUtf8 => "invalid_utf8",
            FrameError::MalformedJson => "malformed_json",
            FrameError::DuplicateKey => "duplicate_key",
            FrameError::LoneSurrogate => "lone_surrogate",
            FrameError::NotAnObject => "not_an_object",
        }
    }
}

impl From<io::Error> for FrameError {
    fn from(error: io::Error) -> Self {
        FrameError::Io(error.to_string())
    }
}

impl From<FrameError> for crate::protocol::worker::FrameErrorKind {
    fn from(error: FrameError) -> Self {
        match error {
            FrameError::Io(_) => crate::protocol::worker::FrameErrorKind::Io,
            FrameError::FrameTooLarge => crate::protocol::worker::FrameErrorKind::FrameTooLarge,
            FrameError::TruncatedFrame => crate::protocol::worker::FrameErrorKind::TruncatedFrame,
            FrameError::InvalidUtf8 => crate::protocol::worker::FrameErrorKind::InvalidUtf8,
            FrameError::MalformedJson => crate::protocol::worker::FrameErrorKind::MalformedJson,
            FrameError::DuplicateKey => crate::protocol::worker::FrameErrorKind::DuplicateKey,
            FrameError::LoneSurrogate => crate::protocol::worker::FrameErrorKind::LoneSurrogate,
            FrameError::NotAnObject => crate::protocol::worker::FrameErrorKind::NotAnObject,
        }
    }
}

/// NDJSON 帧读取器:逐字节缓冲,行界前强制单帧上限。
pub struct FrameReader<R: BufRead> {
    inner: R,
    buffer: Vec<u8>,
}

impl<R: BufRead> FrameReader<R> {
    pub fn new(inner: R) -> Self {
        Self {
            inner,
            buffer: Vec::new(),
        }
    }

    /// 读取下一帧;`Ok(None)` = 对端干净关闭(EOF 且缓冲为空)。
    pub fn read_frame(&mut self) -> Result<Option<StrictValue>, FrameError> {
        self.buffer.clear();
        loop {
            let available = match self.inner.fill_buf() {
                Ok(slice) => slice,
                Err(error) if error.kind() == ErrorKind::Interrupted => continue,
                Err(error) => return Err(FrameError::Io(error.to_string())),
            };
            if available.is_empty() {
                return if self.buffer.is_empty() {
                    Ok(None)
                } else {
                    Err(FrameError::TruncatedFrame)
                };
            }
            if let Some(line_end) = available.iter().position(|byte| *byte == b'\n') {
                let payload_end = self.buffer.len() + line_end;
                if payload_end > crate::protocol::version::MAX_FRAME_BYTES {
                    return Err(FrameError::FrameTooLarge);
                }
                self.buffer.extend_from_slice(&available[..line_end]);
                self.inner.consume(line_end + 1);
                return self.parse_frame().map(Some);
            }
            let chunk_end = self.buffer.len() + available.len();
            if chunk_end > crate::protocol::version::MAX_FRAME_BYTES {
                return Err(FrameError::FrameTooLarge);
            }
            self.buffer.extend_from_slice(available);
            let chunk_length = available.len();
            self.inner.consume(chunk_length);
        }
    }

    fn parse_frame(&self) -> Result<StrictValue, FrameError> {
        use crate::contract::canonical::CanonicalError;
        let text = std::str::from_utf8(&self.buffer).map_err(|_| FrameError::InvalidUtf8)?;
        let value = StrictValue::parse(text).map_err(|error| match error {
            CanonicalError::DuplicateKey => FrameError::DuplicateKey,
            CanonicalError::LoneSurrogate => FrameError::LoneSurrogate,
            _ => FrameError::MalformedJson,
        })?;
        if value.as_object().is_none() {
            return Err(FrameError::NotAnObject);
        }
        Ok(value)
    }
}

/// NDJSON 帧写入器:紧凑序列化 + LF;写前强制单帧上限(超限 = 引擎故障,
/// fail-closed,不静默截断)。
pub struct FrameWriter<W: Write> {
    inner: W,
}

impl<W: Write> FrameWriter<W> {
    pub fn new(inner: W) -> Self {
        Self { inner }
    }

    /// 序列化一帧为行文本(紧凑 JSON + LF);serde_json 紧凑输出保证字符串内
    /// 控制字符全部转义,帧内不会出现裸 LF——此不变式在此防御性断言。
    pub fn serialize_frame(value: &impl Serialize) -> Result<Vec<u8>, FrameError> {
        let mut line =
            serde_json::to_vec(value).map_err(|error| FrameError::Io(error.to_string()))?;
        if line.contains(&b'\n') {
            return Err(FrameError::Io(
                "帧序列化出现裸 LF(序列化器不变式被破坏)".to_owned(),
            ));
        }
        if line.len() > crate::protocol::version::MAX_FRAME_BYTES {
            return Err(FrameError::FrameTooLarge);
        }
        line.push(b'\n');
        Ok(line)
    }

    pub fn write_frame(&mut self, value: &impl Serialize) -> Result<(), FrameError> {
        let line = Self::serialize_frame(value)?;
        self.inner
            .write_all(&line)
            .map_err(|error| FrameError::Io(error.to_string()))?;
        self.inner
            .flush()
            .map_err(|error| FrameError::Io(error.to_string()))?;
        Ok(())
    }
}
