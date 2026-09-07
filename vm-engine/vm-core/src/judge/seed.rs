//! seed 策略运行时与确定性派生(WP-5;计划书 6.3 / 7.1、引擎进程协议 D-F9、
//! 数据分类清单 `seedState` 行、XS-SEED-POLICY 引擎镜像)。
//! 语义规约:`docs/develop/判题语义规约.md` §六。
//!
//! # seed 零驻留
//!
//! 种子值与派生状态只存在于 worker 进程内(`SeedState` 无序列化路径);
//! 回放元数据只承载**策略与派生路径声明**(`DerivationPathSummary`,不含 seed 值),
//! 写入回放元数据归 WP-6。

use crate::state::{SeedState, SeedStrategy};

/// 会话种子字节下界(Schema `^([0-9a-fA-F]{2}){8,32}$` 的镜像:8 字节)。
pub const MIN_SEED_BYTES: usize = 8;
/// 会话种子字节上界(32 字节)。
pub const MAX_SEED_BYTES: usize = 32;
/// 派生算法标识(确定性由 `vmEngineVersion` 锁定;变更 = 破坏性引擎语义变更)。
pub const SEED_ALGORITHM_ID: &str = "splitmix64-stream-v1";
/// `SeedState.version` 的引擎侧登记值。
pub const SEED_STATE_VERSION: u32 = 1;

/// 会话随机源注入面(6.3:随机源由 trait 注入;实现归引擎 / 宿主)。
///
/// 确定性要求:同一 seed 与同一调用序 ⇒ 同一输出序列(属性测试锁定);
/// 测试与上层可注入替身实现。
pub trait SessionRng {
    /// 派生下一个 64 位值。
    fn next_u64(&mut self) -> u64;
}

/// 确定性派生器(`splitmix64-stream-v1`):种子字节 FNV-1a 64 折叠为内部状态,
/// 第 k 次抽取 = splitmix64(state + k)——仅由种子与调用序决定。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SeedDeriver {
    state: u64,
    sequence: u64,
}

impl SeedDeriver {
    /// 自种子字节构造(任意长度;典型 8–32 字节)。
    pub fn new(seed_bytes: &[u8]) -> Self {
        // FNV-1a 64 折叠:确定性、与字节位置相关。
        let mut folded: u64 = 0xcbf2_9ce4_8422_2325;
        for &byte in seed_bytes {
            folded ^= u64::from(byte);
            folded = folded.wrapping_mul(0x0000_0100_0000_01b3);
        }
        Self {
            state: folded,
            sequence: 0,
        }
    }

    /// 派生次数(派生路径元数据的计数部分)。
    pub fn draws(&self) -> u64 {
        self.sequence
    }

    /// 派生路径摘要(写入回放元数据;不含 seed 值)。
    pub fn summary(&self) -> DerivationPathSummary {
        DerivationPathSummary {
            algorithm_id: SEED_ALGORITHM_ID,
            draws: self.sequence,
        }
    }
}

impl SessionRng for SeedDeriver {
    fn next_u64(&mut self) -> u64 {
        // splitmix64 终结子;wrapping 算术(模 2^64,无溢出 panic——确定性优先)。
        let mut z = self
            .state
            .wrapping_add(self.sequence)
            .wrapping_mul(0x9E37_79B9_7F4A_7C15);
        z = (z ^ (z >> 30)).wrapping_mul(0xBF58_476D_1CE4_E5B9);
        z = (z ^ (z >> 27)).wrapping_mul(0x94D0_49BB_1331_11EB);
        self.sequence = self.sequence.wrapping_add(1);
        z ^ (z >> 31)
    }
}

/// 派生路径声明(回放元数据;WP-6 写入侧)。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct DerivationPathSummary {
    /// 派生算法标识(如 `splitmix64-stream-v1`)。
    pub algorithm_id: &'static str,
    /// 派生次数。
    pub draws: u64,
}

/// seed 策略解析失败(方向 = `challenge_invalid`;XS-SEED-POLICY 引擎镜像)。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SeedPolicyError {
    /// `fixed` ⇒ 包内 seed 必填。
    FixedRequiresPackageSeed,
    /// `fixed` ⇒ 会话 seed 禁止(seed 在包内)。
    FixedForbidsSessionSeed,
    /// `server_random_per_session` ⇒ 会话 seed 必填(D-F9:编排器生成传入)。
    ServerRandomRequiresSessionSeed,
    /// `server_random_per_session` ⇒ 包内 seed 禁止(R5 互斥)。
    ServerRandomForbidsPackageSeed,
    /// 种子长度界外(8–32 字节)。
    SeedLengthInvalid {
        /// 实际字节数。
        len: usize,
    },
}

/// 解析 seed 策略为运行时 `SeedState`(XS-SEED-POLICY 引擎镜像,fail-closed):
///
/// - `fixed`:包内 seed 必填 ∧ 会话 seed 禁止;
/// - `server_random_per_session`:会话 seed 必填 ∧ 包内 seed 禁止;
/// - 两者字节长均须 8–32。
pub fn resolve_seed_state(
    strategy: SeedStrategy,
    package_seed: Option<&[u8]>,
    session_seed: Option<&[u8]>,
) -> Result<SeedState, SeedPolicyError> {
    let check_len = |bytes: &[u8]| -> Result<(), SeedPolicyError> {
        if (MIN_SEED_BYTES..=MAX_SEED_BYTES).contains(&bytes.len()) {
            Ok(())
        } else {
            Err(SeedPolicyError::SeedLengthInvalid { len: bytes.len() })
        }
    };
    let state_bytes = match strategy {
        SeedStrategy::Fixed => {
            if session_seed.is_some() {
                return Err(SeedPolicyError::FixedForbidsSessionSeed);
            }
            let seed = package_seed.ok_or(SeedPolicyError::FixedRequiresPackageSeed)?;
            check_len(seed)?;
            seed.to_vec()
        }
        SeedStrategy::ServerRandomPerSession => {
            if package_seed.is_some() {
                return Err(SeedPolicyError::ServerRandomForbidsPackageSeed);
            }
            let seed = session_seed.ok_or(SeedPolicyError::ServerRandomRequiresSessionSeed)?;
            check_len(seed)?;
            seed.to_vec()
        }
    };
    Ok(SeedState {
        strategy,
        version: SEED_STATE_VERSION,
        state_bytes,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use alloc::vec::Vec;

    /// 策略互斥矩阵:两策略 × (包 seed, 会话 seed) 四组合恰一合法 + 长度界。
    #[test]
    fn policy_mutual_exclusion_matrix() {
        let seed8: &[u8] = &[0x11; 8];
        // fixed:包内 seed 合法、会话 seed 禁止、双缺拒绝。
        assert!(resolve_seed_state(SeedStrategy::Fixed, Some(seed8), None).is_ok());
        assert_eq!(
            resolve_seed_state(SeedStrategy::Fixed, Some(seed8), Some(seed8)),
            Err(SeedPolicyError::FixedForbidsSessionSeed)
        );
        assert_eq!(
            resolve_seed_state(SeedStrategy::Fixed, None, None),
            Err(SeedPolicyError::FixedRequiresPackageSeed)
        );
        // server_random:会话 seed 合法、包内 seed 禁止、双缺拒绝。
        assert!(
            resolve_seed_state(SeedStrategy::ServerRandomPerSession, None, Some(seed8)).is_ok()
        );
        assert_eq!(
            resolve_seed_state(
                SeedStrategy::ServerRandomPerSession,
                Some(seed8),
                Some(seed8)
            ),
            Err(SeedPolicyError::ServerRandomForbidsPackageSeed)
        );
        assert_eq!(
            resolve_seed_state(SeedStrategy::ServerRandomPerSession, None, None),
            Err(SeedPolicyError::ServerRandomRequiresSessionSeed)
        );
        // 长度界:7 / 33 字节拒绝,8 / 32 通过。
        for bad_len in [7usize, 33] {
            let bad = alloc::vec![0u8; bad_len];
            assert_eq!(
                resolve_seed_state(SeedStrategy::Fixed, Some(&bad), None),
                Err(SeedPolicyError::SeedLengthInvalid { len: bad_len })
            );
        }
        for ok_len in [MIN_SEED_BYTES, MAX_SEED_BYTES] {
            let ok = alloc::vec![0xAB; ok_len];
            let state = resolve_seed_state(SeedStrategy::Fixed, Some(&ok), None).unwrap();
            assert_eq!(state.state_bytes, ok);
            assert_eq!(state.version, SEED_STATE_VERSION);
        }
    }

    /// 13.1"随机 seed 确定性":同 seed 同序列、异 seed 异序列、派生计数正确。
    #[test]
    fn same_seed_same_stream_and_different_seeds_diverge() {
        let seed: &[u8] = &[0xDE, 0xAD, 0xBE, 0xEF, 0x01, 0x02, 0x03, 0x04];
        let mut a = SeedDeriver::new(seed);
        let mut b = SeedDeriver::new(seed);
        let mut stream_a = Vec::new();
        let mut stream_b = Vec::new();
        for _ in 0..1000 {
            stream_a.push(a.next_u64());
            stream_b.push(b.next_u64());
        }
        assert_eq!(stream_a, stream_b, "同 seed 必须产生同一序列");
        assert_eq!(a.draws(), 1000);

        let mut c = SeedDeriver::new(&[0x00; 8]);
        let stream_c: Vec<u64> = (0..1000).map(|_| c.next_u64()).collect();
        assert_ne!(stream_a, stream_c, "异 seed 序列应不同");
        assert_eq!(c.draws(), 1000);
    }

    /// 派生路径摘要:算法标识 + 派生次数,不含 seed 值。
    #[test]
    fn derivation_summary_excludes_seed_value() {
        let mut deriver = SeedDeriver::new(&[0x5A; 16]);
        deriver.next_u64();
        deriver.next_u64();
        let summary = deriver.summary();
        assert_eq!(summary.algorithm_id, "splitmix64-stream-v1");
        assert_eq!(summary.draws, 2);
    }

    /// trait 注入面可用作动态分发(宿主 / 测试可替换实现)。
    #[test]
    fn session_rng_is_object_safe() {
        let rng: &mut dyn SessionRng = &mut SeedDeriver::new(&[0x77; 8]);
        let first = rng.next_u64();
        let second = rng.next_u64();
        assert_ne!(first, second);
    }
}
