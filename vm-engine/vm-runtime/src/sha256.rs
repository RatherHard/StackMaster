//! SHA-256(FIPS 180-4)——动作日志前后状态哈希、checkpoint 内容指纹与日志
//! 摘要的摘要原语(6.3"规范化序列化 + SHA-256"、版本策略 §三记录项 #6)。
//!
//! 引擎三 crate 零外部依赖(ENG-4),算法在此以纯 safe Rust 实现;正确性由
//! FIPS 180-4 标准测试向量与分块边界测试锁定(单测)。输出 32 字节摘要,
//! 十六进制形态统一小写(规范化序列化 §3.2 的字段命名约定 `canonicalSha256`)。

const K: [u32; 64] = [
    0x428a_2f98,
    0x7137_4491,
    0xb5c0_fbcf,
    0xe9b5_dba5,
    0x3956_c25b,
    0x59f1_11f1,
    0x923f_82a4,
    0xab1c_5ed5,
    0xd807_aa98,
    0x1283_5b01,
    0x2431_85be,
    0x550c_7dc3,
    0x72be_5d74,
    0x80de_b1fe,
    0x9bdc_06a7,
    0xc19b_f174,
    0xe49b_69c1,
    0xefbe_4786,
    0x0fc1_9dc6,
    0x240c_a1cc,
    0x2de9_2c6f,
    0x4a74_84aa,
    0x5cb0_a9dc,
    0x76f9_88da,
    0x983e_5152,
    0xa831_c66d,
    0xb003_27c8,
    0xbf59_7fc7,
    0xc6e0_0bf3,
    0xd5a7_9147,
    0x06ca_6351,
    0x1429_2967,
    0x27b7_0a85,
    0x2e1b_2138,
    0x4d2c_6dfc,
    0x5338_0d13,
    0x650a_7354,
    0x766a_0abb,
    0x81c2_c92e,
    0x9272_2c85,
    0xa2bf_e8a1,
    0xa81a_664b,
    0xc24b_8b70,
    0xc76c_51a3,
    0xd192_e819,
    0xd699_0624,
    0xf40e_3585,
    0x106a_a070,
    0x19a4_c116,
    0x1e37_6c08,
    0x2748_774c,
    0x34b0_bcb5,
    0x391c_0cb3,
    0x4ed8_aa4a,
    0x5b9c_ca4f,
    0x682e_6ff3,
    0x748f_82ee,
    0x78a5_636f,
    0x84c8_7814,
    0x8cc7_0208,
    0x90be_fffa,
    0xa450_6ceb,
    0xbef9_a3f7,
    0xc671_78f2,
];

/// 增量 SHA-256 摘要器:`update` 任意次后 `finish` 收尾(消费式)。
#[derive(Debug, Clone)]
pub struct Sha256 {
    state: [u32; 8],
    buffer: [u8; 64],
    buffered: usize,
    length_bits: u64,
}

impl Default for Sha256 {
    fn default() -> Self {
        Self::new()
    }
}

impl Sha256 {
    pub fn new() -> Self {
        Self {
            state: [
                0x6a09_e667,
                0xbb67_ae85,
                0x3c6e_f372,
                0xa54f_f53a,
                0x510e_527f,
                0x9b05_688c,
                0x1f83_d9ab,
                0x5be0_cd19,
            ],
            buffer: [0u8; 64],
            buffered: 0,
            length_bits: 0,
        }
    }

    /// 吸收一段字节(可任意分块;分块方式不影响摘要)。
    pub fn update(&mut self, data: &[u8]) {
        self.length_bits = self.length_bits.wrapping_add((data.len() as u64) * 8);
        self.absorb(data);
    }

    /// 收尾:补位 + 64 位大端长度域,输出 32 字节摘要(补位不计入长度)。
    pub fn finish(mut self) -> [u8; 32] {
        let bits = self.length_bits;
        let mut tail = [0u8; 72];
        tail[0] = 0x80;
        // 需要使总长 ≡ 56 (mod 64):缓冲已不足 56 补到 56,否则补到 120。
        let pad_len = if self.buffered < 56 {
            56 - self.buffered
        } else {
            120 - self.buffered
        };
        self.absorb(&tail[..pad_len]);
        self.absorb(&bits.to_be_bytes());
        debug_assert_eq!(self.buffered, 0);
        let mut out = [0u8; 32];
        for (index, word) in self.state.iter().enumerate() {
            out[index * 4..index * 4 + 4].copy_from_slice(&word.to_be_bytes());
        }
        out
    }

    /// 与 [`Sha256::update`] 同序吸收,但**不累计长度**(补位与长度域专用)。
    fn absorb(&mut self, mut data: &[u8]) {
        if self.buffered > 0 {
            let take = (64 - self.buffered).min(data.len());
            self.buffer[self.buffered..self.buffered + take].copy_from_slice(&data[..take]);
            self.buffered += take;
            data = &data[take..];
            if self.buffered == 64 {
                let block = self.buffer;
                self.compress(&block);
                self.buffered = 0;
            }
        }
        while data.len() >= 64 {
            let (block, rest) = data.split_at(64);
            let mut owned = [0u8; 64];
            owned.copy_from_slice(block);
            self.compress(&owned);
            data = rest;
        }
        if !data.is_empty() {
            self.buffer[..data.len()].copy_from_slice(data);
            self.buffered = data.len();
        }
    }

    fn compress(&mut self, block: &[u8; 64]) {
        let mut w = [0u32; 64];
        for (index, word) in w.iter_mut().take(16).enumerate() {
            *word = u32::from_be_bytes([
                block[index * 4],
                block[index * 4 + 1],
                block[index * 4 + 2],
                block[index * 4 + 3],
            ]);
        }
        for index in 16..64 {
            let s0 = w[index - 15].rotate_right(7)
                ^ w[index - 15].rotate_right(18)
                ^ (w[index - 15] >> 3);
            let s1 = w[index - 2].rotate_right(17)
                ^ w[index - 2].rotate_right(19)
                ^ (w[index - 2] >> 10);
            w[index] = w[index - 16]
                .wrapping_add(s0)
                .wrapping_add(w[index - 7])
                .wrapping_add(s1);
        }
        let [mut a, mut b, mut c, mut d, mut e, mut f, mut g, mut h] = self.state;
        for index in 0..64 {
            let s1 = e.rotate_right(6) ^ e.rotate_right(11) ^ e.rotate_right(25);
            let ch = (e & f) ^ (!e & g);
            let temp1 = h
                .wrapping_add(s1)
                .wrapping_add(ch)
                .wrapping_add(K[index])
                .wrapping_add(w[index]);
            let s0 = a.rotate_right(2) ^ a.rotate_right(13) ^ a.rotate_right(22);
            let maj = (a & b) ^ (a & c) ^ (b & c);
            let temp2 = s0.wrapping_add(maj);
            h = g;
            g = f;
            f = e;
            e = d.wrapping_add(temp1);
            d = c;
            c = b;
            b = a;
            a = temp1.wrapping_add(temp2);
        }
        let rounds = [
            a.wrapping_add(self.state[0]),
            b.wrapping_add(self.state[1]),
            c.wrapping_add(self.state[2]),
            d.wrapping_add(self.state[3]),
            e.wrapping_add(self.state[4]),
            f.wrapping_add(self.state[5]),
            g.wrapping_add(self.state[6]),
            h.wrapping_add(self.state[7]),
        ];
        self.state.copy_from_slice(&rounds);
    }
}

/// 一次性摘要。
pub fn sha256(data: &[u8]) -> [u8; 32] {
    let mut hasher = Sha256::new();
    hasher.update(data);
    hasher.finish()
}

/// 小写十六进制(64 字符 / 32 字节;§3.2 摘要形态)。
pub fn hex(bytes: &[u8]) -> alloc::string::String {
    const DIGITS: &[u8; 16] = b"0123456789abcdef";
    let mut out = alloc::string::String::with_capacity(bytes.len() * 2);
    for &byte in bytes {
        out.push(DIGITS[(byte >> 4) as usize] as char);
        out.push(DIGITS[(byte & 0x0F) as usize] as char);
    }
    out
}

#[cfg(test)]
mod tests {
    extern crate std;

    use super::*;
    use alloc::vec::Vec;

    /// FIPS 180-4 标准测试向量(单块 / 多块 / 空输入)。
    #[test]
    fn fips_180_4_vectors() {
        assert_eq!(
            hex(&sha256(b"")),
            "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"
        );
        assert_eq!(
            hex(&sha256(b"abc")),
            "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"
        );
        assert_eq!(
            hex(&sha256(
                b"abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq"
            )),
            "248d6a61d20638b8e5c026930c3e6039a33ce45964ff2167f6ecedd419db06c1"
        );
    }

    /// 增量分块任意切分结果一致(分块边界:恰 64 / 恰 56 / 恰 55 / 1 字节)。
    #[test]
    fn incremental_update_matches_oneshot_for_any_chunking() {
        // 1000 字节确定性伪随机数据(xorshift;ENG-4 禁随机源 crate)。
        let mut seed = 0x9E37_79B9_7F4A_7C15u64;
        let data: Vec<u8> = (0..1000)
            .map(|_| {
                seed ^= seed >> 12;
                seed ^= seed << 25;
                seed ^= seed >> 27;
                (seed.wrapping_mul(0x2545_F491_4F6C_DD1D) >> 24) as u8
            })
            .collect();
        let expected = hex(&sha256(&data));
        for chunk in [1usize, 55, 56, 63, 64, 65, 500, 1000] {
            let mut hasher = Sha256::new();
            for part in data.chunks(chunk) {
                hasher.update(part);
            }
            assert_eq!(hex(&hasher.finish()), expected, "分块 {chunk} 摘要漂移");
        }
    }

    /// 长度域正确性:56 字节输入(补位恰需双块)与 64 字节(三块)。
    #[test]
    fn block_boundary_lengths() {
        let v56 = [b'a'; 56];
        let v64 = [b'a'; 64];
        // 已知值来自标准实现核对(与 Python hashlib.sha256 一致)。
        assert_eq!(
            hex(&sha256(&v56)),
            "b35439a4ac6f0948b6d6f9e3c6af0f5f590ce20f1bde7090ef7970686ec6738a"
        );
        assert_eq!(
            hex(&sha256(&v64)),
            "ffe054fe7ae0cb6dc65c3af9b61d5209f439851db43d0ba5997337df154668eb"
        );
    }
}
