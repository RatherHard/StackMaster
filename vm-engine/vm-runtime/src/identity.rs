//! 引擎自报版本与私有包声明锁定(版本策略 §三记录项 #3、§四;计划书 7.4
//! "不得自动使用最新引擎")。
//!
//! `vmEngineVersion` 与 `engineBuildId` 的**自报常量**归 vm-worker 进程层
//! (`vm_worker::protocol::version`,二进制 crate 版本 + 编译期注入的构建 ID);
//! 本模块承载**锁定比对**的权威判定:装载时与快照导入时,包声明 / 快照绑定
//! 与运行时引擎身份不一致 → `challenge_invalid` 方向拒绝——宁可拒绝装载,
//! 不可近似执行(版本策略 §一关系 3)。
//!
//! 判定规则(引擎进程协议 §2.3):
//! - `vmEngineVersion` 必填且必须一致;
//! - `engineBuildId` 声明为可选:声明了就必须一致,未声明只锁引擎版本。

use alloc::string::String;

/// 运行时引擎身份(由进程层自报注入;worker 侧来源 = `VM_ENGINE_VERSION` /
/// `ENGINE_BUILD_ID` 常量)。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct EngineIdentity {
    /// 引擎版本(自报;与私有包 `vmEngineVersion` 同源比对)。
    pub vm_engine_version: String,
    /// 引擎构建 ID(自报;编译期注入,缺省 `dev`)。
    pub engine_build_id: String,
}

/// 版本锁定失败(方向 = `challenge_invalid`;版本策略 §四结果类型方向)。
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum VersionLockError {
    /// `vmEngineVersion` 声明与运行时引擎不一致。
    EngineVersionMismatch {
        /// 包声明 / 快照绑定值。
        declared: String,
        /// 运行时自报值。
        running: String,
    },
    /// 声明了 `engineBuildId` 且与运行时引擎不一致。
    BuildIdMismatch {
        /// 包声明 / 快照绑定值。
        declared: String,
        /// 运行时自报值。
        running: String,
    },
}

/// 锁定比对:`vmEngineVersion` 必须一致;`engineBuildId` 声明了就必须一致。
pub fn verify_bundle_lock(
    declared_engine_version: &str,
    declared_build_id: Option<&str>,
    identity: &EngineIdentity,
) -> Result<(), VersionLockError> {
    if declared_engine_version != identity.vm_engine_version {
        return Err(VersionLockError::EngineVersionMismatch {
            declared: String::from(declared_engine_version),
            running: identity.vm_engine_version.clone(),
        });
    }
    if let Some(declared) = declared_build_id
        && declared != identity.engine_build_id
    {
        return Err(VersionLockError::BuildIdMismatch {
            declared: String::from(declared),
            running: identity.engine_build_id.clone(),
        });
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    extern crate std;

    use super::*;

    fn identity() -> EngineIdentity {
        EngineIdentity {
            vm_engine_version: String::from("0.1.0"),
            engine_build_id: String::from("dev"),
        }
    }

    /// 锁定矩阵:版本一致 ∧ 构建缺省 → 通过;版本 / 构建任一不一致 → 拒绝。
    #[test]
    fn lock_matrix_matches_version_policy_section_4() {
        let id = identity();
        // 版本一致、未声明构建 ID:通过。
        assert_eq!(verify_bundle_lock("0.1.0", None, &id), Ok(()));
        // 版本一致、构建 ID 一致:通过。
        assert_eq!(verify_bundle_lock("0.1.0", Some("dev"), &id), Ok(()));
        // 版本不一致:宁可拒绝(即使构建一致)。
        assert_eq!(
            verify_bundle_lock("0.2.0", Some("dev"), &id),
            Err(VersionLockError::EngineVersionMismatch {
                declared: String::from("0.2.0"),
                running: String::from("0.1.0"),
            })
        );
        // 声明了构建 ID 且不一致:拒绝。
        assert_eq!(
            verify_bundle_lock("0.1.0", Some("build-20260908"), &id),
            Err(VersionLockError::BuildIdMismatch {
                declared: String::from("build-20260908"),
                running: String::from("dev"),
            })
        );
    }
}
