//! 虚拟内存:VMA 权限模型与固定大小分页(WP-3;计划书 6.1 / 6.3、整改方案 §3.3 G3/D2)。
//!
//! # 语义分工(权限单元 ≠ 存储单元)
//!
//! - **VMA 是权限权威单元**(6.1):每个 VMA 的权限(`r`/`w`/`x`)、类型与大小由出题人
//!   设定;读 / 写 / 取指按**字节范围**对照其覆盖 VMA 的权限检查;
//! - **分页只是存储粒度**(6.3):页大小为 4KB 倍数区间 {4096 … 65536}(D2,非常量),
//!   页承载字节内容,供 WP-6 做 COW 快照;当页大于 4KB 时一页可承载多个 VMA 的
//!   字节段——字节区间不重叠(区域重叠在装载时拒绝),互不别名。
//!
//! # 统一拒绝路径(I-9)
//!
//! 一切越界 / 越权访问(含跨区域边界的部分越权、未映射地址、地址回绕)收敛到
//! 单一 [`MemoryFault`] 类型;对不可见地址的访问不产生事件,公开面由投影层
//! 按 I-9 统一粗化(WP-7)。IR 模式自定义指令与接口效果的内存访问同样走本
//! 路径(整改方案 §四 I-9 保全)。
//!
//! # W^X(D4.5)
//!
//! 字节模式下表层机器码是唯一权威执行空间,代码区权限不得含 `w`
//! (契约面 `XS-CODE-WRX`;本模块在装载时复核,[`MemoryConfigError::CodeWritableInByteMode`]);
//! IR 模式无表层机器码、无写码面,不受此约束。运行期写保护由权限检查统一承担。

use alloc::boxed::Box;
use alloc::collections::BTreeMap;
use alloc::string::String;
use alloc::vec;
use alloc::vec::Vec;

use crate::arch::{ArchBits, ArchValue};

/// VMA 页对齐倍数(G3/D2:区域 byteLength 恒为其倍数;XS-MEM-PAGE-ALIGN)。
pub const VMA_ALIGN_BYTES: u64 = 4096;
/// 页大小下限(D2:4KB)。
pub const MIN_PAGE_SIZE_BYTES: u64 = 4096;
/// 页大小上限(D2:64KB;取值域 {4096, 8192, …, 65536})。
pub const MAX_PAGE_SIZE_BYTES: u64 = 65536;
/// 区域数量上限(契约 `MAX_MEMORY_REGIONS`;资源护栏)。
pub const MAX_REGIONS: usize = 64;
/// 单区域字节上限(契约 `MAX_REGION_BYTE_LENGTH` = 16 MiB)。
pub const MAX_REGION_BYTES: u64 = 16 * 1024 * 1024;
/// 全部区域字节总量上限(契约 `MAX_MEMORY_TOTAL_BYTES` = 64 MiB;XS-MEM-TOTAL)。
pub const MAX_TOTAL_BYTES: u64 = 64 * 1024 * 1024;

/// 区域类型:封闭六类(6.1;G3 整改增补 `custom`——作者自定义命名类型,必填标签)。
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub enum RegionKind {
    /// 代码区。
    Code,
    /// 全局区。
    Global,
    /// 堆区。
    Heap,
    /// 栈区。
    Stack,
    /// 题目关键区(可命名)。
    Key,
    /// 作者自定义类型(必填标签;公开面标签自由度不变)。
    Custom,
}

/// 权限位(`r`/`w`/`x`;规范序子集,`^r?w?x?$`)。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub struct Permissions(u8);

impl Permissions {
    /// 读。
    pub const READ: Permissions = Permissions(0b001);
    /// 写。
    pub const WRITE: Permissions = Permissions(0b010);
    /// 执行。
    pub const EXEC: Permissions = Permissions(0b100);

    const fn has(self, bit: u8) -> bool {
        self.0 & bit != 0
    }

    /// 是否可读。
    pub fn can_read(self) -> bool {
        self.has(0b001)
    }

    /// 是否可写。
    pub fn can_write(self) -> bool {
        self.has(0b010)
    }

    /// 是否可执行。
    pub fn can_exec(self) -> bool {
        self.has(0b100)
    }

    /// 权限是否覆盖所需类别。
    pub fn allows(self, required: PermKind) -> bool {
        match required {
            PermKind::Read => self.can_read(),
            PermKind::Write => self.can_write(),
            PermKind::Exec => self.can_exec(),
        }
    }

    /// 解析规范序子集字符串(契约形态 `^r?w?x?$`;乱序 / 重复 / 未知字符拒绝)。
    pub fn parse(s: &str) -> Result<Self, MemoryConfigError> {
        let mut bits = 0u8;
        let mut expect = b'r';
        for ch in s.bytes() {
            // 规范序:r → w → x;出现早于当前游标的字母即乱序或重复。
            let (bit, letter) = match ch {
                b'r' => (0b001, b'r'),
                b'w' => (0b010, b'w'),
                b'x' => (0b100, b'x'),
                _ => return Err(MemoryConfigError::PermissionsMalformed),
            };
            if letter < expect {
                return Err(MemoryConfigError::PermissionsMalformed);
            }
            bits |= bit;
            expect = letter + 1;
        }
        Ok(Permissions(bits))
    }

    /// 规范序字符串形态(与 [`Permissions::parse`] 互逆)。
    pub fn as_str(self) -> &'static str {
        match self.0 {
            0b000 => "",
            0b001 => "r",
            0b010 => "w",
            0b011 => "rw",
            0b100 => "x",
            0b101 => "rx",
            0b110 => "wx",
            _ => "rwx",
        }
    }
}

/// 权限检查类别(读 / 写 / 取指)。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PermKind {
    /// 读。
    Read,
    /// 写。
    Write,
    /// 取指(执行)。
    Exec,
}

/// 执行模式(决定 W^X 是否适用于代码区;D4.5)。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ExecutionMode {
    /// IR 模式:编译产物直读,无表层机器码,代码区不受 W^X 约束。
    Ir,
    /// 字节模式:表层机器码是唯一权威执行空间,代码区权限不得含 `w`。
    ByteCode,
}

/// VMA 规约(构造期全量校验;装载管线 fail-closed 的内存侧入口)。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RegionSpec {
    /// 区域标识(公开布局常量;投影 `visibleRegions` 白名单的引用键)。
    pub region_id: String,
    /// 区域类型。
    pub kind: RegionKind,
    /// `custom` 类型的作者命名(其余类型必须为 `None`,与双包 Schema 一致)。
    pub custom_label: Option<String>,
    /// 起始地址(域内;引擎不额外要求对齐——契约只约束 byteLength)。
    pub start: u64,
    /// 字节长度(> 0、4KB 倍数、≤ 16 MiB;区域内对象不受对齐约束)。
    pub byte_length: u64,
    /// 权限(规范序子集)。
    pub permissions: Permissions,
    /// 末字节地址(构造期验证 `start + byte_length - 1` 不回绕、不出位宽域)。
    pub last_address: u64,
}

impl RegionSpec {
    /// 构造并校验(任一约束不满足即拒绝,方向 = challenge_invalid)。
    pub fn new(
        region_id: &str,
        kind: RegionKind,
        custom_label: Option<&str>,
        start: u64,
        byte_length: u64,
        permissions: Permissions,
        arch: ArchBits,
    ) -> Result<Self, MemoryConfigError> {
        if region_id.is_empty() {
            return Err(MemoryConfigError::EmptyRegionId);
        }
        match (kind, custom_label) {
            (RegionKind::Custom, None | Some("")) => {
                return Err(MemoryConfigError::CustomLabelRequired);
            }
            (RegionKind::Custom, Some(label)) => {
                if label.is_empty() {
                    return Err(MemoryConfigError::CustomLabelRequired);
                }
            }
            (_, Some(_)) => return Err(MemoryConfigError::CustomLabelForbidden),
            (_, None) => {}
        }
        if byte_length == 0 {
            return Err(MemoryConfigError::RegionEmpty {
                region_id: String::from(region_id),
            });
        }
        if !byte_length.is_multiple_of(VMA_ALIGN_BYTES) {
            return Err(MemoryConfigError::RegionBytesNotAligned {
                region_id: String::from(region_id),
                byte_length,
            });
        }
        if byte_length > MAX_REGION_BYTES {
            return Err(MemoryConfigError::RegionTooLarge {
                region_id: String::from(region_id),
                byte_length,
            });
        }
        let last_address = start
            .checked_add(byte_length - 1)
            .filter(|last| *last <= arch.mask())
            .ok_or(MemoryConfigError::RegionAddressSpaceExceeded {
                region_id: String::from(region_id),
            })?;
        Ok(Self {
            region_id: String::from(region_id),
            kind,
            custom_label: custom_label.map(String::from),
            start,
            byte_length,
            permissions,
            last_address,
        })
    }

    /// 地址是否落在本区域内。
    pub fn contains(&self, addr: u64) -> bool {
        self.start <= addr && addr <= self.last_address
    }
}

/// 区域初始内容(私有包 `initialState.memoryRegions[].contentHex` 的解码形态;
/// 私有样例只存在于 worker 进程内,ADR-7)。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RegionContents {
    /// 目标区域标识(必须与已声明区域一一对应)。
    pub region_id: String,
    /// 初始字节(≤ 区域 byteLength;余量零填充)。
    pub bytes: Vec<u8>,
}

/// 内存配置错误(装载期;公开面粗化归 WP-7)。
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum MemoryConfigError {
    /// 页大小不在 {4096, 8192, …, 65536}(D2)。
    PageSizeInvalid {
        /// 非法页大小。
        value: u64,
    },
    /// 区域数量超护栏(64)。
    RegionCountExceeded {
        /// 实际数量。
        count: usize,
    },
    /// 区域 id 为空。
    EmptyRegionId,
    /// `custom` 区域缺标签。
    CustomLabelRequired,
    /// 非 `custom` 区域带标签(Schema 无此字段)。
    CustomLabelForbidden,
    /// 区域长度为 0。
    RegionEmpty {
        /// 区域 id。
        region_id: String,
    },
    /// 区域长度非 4KB 倍数(XS-MEM-PAGE-ALIGN)。
    RegionBytesNotAligned {
        /// 区域 id。
        region_id: String,
        /// 非法长度。
        byte_length: u64,
    },
    /// 区域长度超 16 MiB。
    RegionTooLarge {
        /// 区域 id。
        region_id: String,
        /// 非法长度。
        byte_length: u64,
    },
    /// 区域地址范围超出 archBits 地址域或回绕。
    RegionAddressSpaceExceeded {
        /// 区域 id。
        region_id: String,
    },
    /// 区域重叠(VMA 权限权威性要求字节区间互斥)。
    RegionsOverlap {
        /// 前一区域 id。
        first_id: String,
        /// 后一区域 id。
        second_id: String,
    },
    /// 区域 id 重复。
    DuplicateRegionId {
        /// 区域 id。
        region_id: String,
    },
    /// 区域总量超 64 MiB(XS-MEM-TOTAL)。
    TotalMemoryExceeded {
        /// 实际总量。
        total: u64,
    },
    /// 字节模式代码区权限含 `w`(W^X 硬规则;XS-CODE-WRX / D4.5)。
    CodeWritableInByteMode {
        /// 区域 id。
        region_id: String,
    },
    /// 权限字符串非法(乱序 / 重复 / 未知字符)。
    PermissionsMalformed,
    /// 初始内容引用了未声明区域。
    ContentsUnknownRegion {
        /// 区域 id。
        region_id: String,
    },
    /// 已声明区域缺初始内容(严格一一对应;无内容请给空字节)。
    ContentsMissing {
        /// 区域 id。
        region_id: String,
    },
    /// 初始内容重复出现。
    ContentsDuplicate {
        /// 区域 id。
        region_id: String,
    },
    /// 初始内容超过区域容量。
    ContentsTooLarge {
        /// 区域 id。
        region_id: String,
        /// 内容字节数。
        content_len: usize,
        /// 区域容量。
        region_bytes: u64,
    },
}

/// 内存访问故障(统一拒绝路径的唯一形态;I-9)。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct MemoryFault {
    /// 故障字节地址(段首缺失 / 越权处;非请求起点)。
    pub addr: u64,
    /// 请求总长(字节)。
    pub length: usize,
    /// 故障类别。
    pub kind: MemoryFaultKind,
}

/// 故障类别(统一枚举;公开错误码映射归 WP-7 / 协议 16 错误码)。
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum MemoryFaultKind {
    /// 地址未映射(含越出区域尾部的访问)。
    Unmapped,
    /// 权限不足(所需类别与该 VMA 实际权限一并记录;教学解释的数据来源)。
    PermissionDenied {
        /// 所需权限类别。
        required: PermKind,
        /// 该 VMA 实际权限。
        actual: Permissions,
        /// 所在区域 id。
        region_id: String,
    },
    /// 地址区间回绕(addr + len 超出 64 位容器)。
    AddressOverflow,
}

/// 分页虚拟内存:VMA 权威 + 固定大小分页存储(6.1 / 6.3)。
///
/// 页数据在装载期按区域内容一次物化(教学规模内存 ≤ 64 MiB;COW 快照在
/// WP-6 于本结构之上实现,不改变本模块的权限语义)。
#[derive(Debug, Clone)]
pub struct VirtualMemory {
    arch: ArchBits,
    page_size: u64,
    mode: ExecutionMode,
    /// 区域表(键 = 起始地址,升序确定性遍历)。
    regions: BTreeMap<u64, RegionSpec>,
    /// 区域 id → 起始地址(按 id 查找)。
    ids: BTreeMap<String, u64>,
    /// 页表(键 = 页号;装载期物化)。
    pages: BTreeMap<u64, Box<[u8]>>,
}

impl VirtualMemory {
    /// 装载:全量校验 + 页数据物化。任一约束不满足即整体拒绝(层次化 fail-closed)。
    pub fn new(
        arch: ArchBits,
        page_size: u64,
        mode: ExecutionMode,
        regions: Vec<RegionSpec>,
        contents: Vec<RegionContents>,
    ) -> Result<Self, MemoryConfigError> {
        if !(MIN_PAGE_SIZE_BYTES..=MAX_PAGE_SIZE_BYTES).contains(&page_size)
            || !page_size.is_multiple_of(VMA_ALIGN_BYTES)
        {
            return Err(MemoryConfigError::PageSizeInvalid { value: page_size });
        }
        if regions.len() > MAX_REGIONS {
            return Err(MemoryConfigError::RegionCountExceeded {
                count: regions.len(),
            });
        }
        let total: u64 = regions.iter().map(|r| r.byte_length).sum();
        if total > MAX_TOTAL_BYTES {
            return Err(MemoryConfigError::TotalMemoryExceeded { total });
        }

        let mut ids: BTreeMap<String, u64> = BTreeMap::new();
        for region in &regions {
            if ids.contains_key(&region.region_id) {
                return Err(MemoryConfigError::DuplicateRegionId {
                    region_id: region.region_id.clone(),
                });
            }
            ids.insert(region.region_id.clone(), region.start);
        }
        // 重叠检查:start 升序下相邻区间必须严格不交。
        let mut sorted: Vec<&RegionSpec> = regions.iter().collect();
        sorted.sort_by_key(|r| r.start);
        for pair in sorted.windows(2) {
            let (prev, next) = (pair[0], pair[1]);
            if prev.last_address >= next.start {
                return Err(MemoryConfigError::RegionsOverlap {
                    first_id: prev.region_id.clone(),
                    second_id: next.region_id.clone(),
                });
            }
        }
        // W^X(D4.5):仅字节模式约束代码区;IR 模式无写码面,不约束。
        if mode == ExecutionMode::ByteCode {
            for region in &regions {
                if region.kind == RegionKind::Code && region.permissions.can_write() {
                    return Err(MemoryConfigError::CodeWritableInByteMode {
                        region_id: region.region_id.clone(),
                    });
                }
            }
        }
        // 初始内容与区域严格一一对应。
        let mut content_by_id: BTreeMap<&str, &[u8]> = BTreeMap::new();
        for content in &contents {
            if content_by_id.contains_key(content.region_id.as_str()) {
                return Err(MemoryConfigError::ContentsDuplicate {
                    region_id: content.region_id.clone(),
                });
            }
            if !ids.contains_key(&content.region_id) {
                return Err(MemoryConfigError::ContentsUnknownRegion {
                    region_id: content.region_id.clone(),
                });
            }
            content_by_id.insert(&content.region_id, &content.bytes);
        }
        for region in &regions {
            if !content_by_id.contains_key(region.region_id.as_str()) {
                return Err(MemoryConfigError::ContentsMissing {
                    region_id: region.region_id.clone(),
                });
            }
        }

        // 页数据物化:区域按 start 升序填充;页按需创建,仅写本区域字节区间。
        let mut pages: BTreeMap<u64, Box<[u8]>> = BTreeMap::new();
        for region in sorted {
            let content = content_by_id
                .get(region.region_id.as_str())
                .copied()
                .unwrap_or(&[]);
            if content.len() as u64 > region.byte_length {
                return Err(MemoryConfigError::ContentsTooLarge {
                    region_id: region.region_id.clone(),
                    content_len: content.len(),
                    region_bytes: region.byte_length,
                });
            }
            let first_page = region.start / page_size;
            let last_page = region.last_address / page_size;
            for page_no in first_page..=last_page {
                let page = pages
                    .entry(page_no)
                    .or_insert_with(|| vec![0u8; page_size as usize].into_boxed_slice());
                let page_base = page_no * page_size;
                // 页末字节饱和处理:最高页的页末可能超出 64 位容器,
                // 饱和到 u64::MAX 后 min 仍取区域末字节,语义不变。
                let page_last = page_base.saturating_add(page_size - 1);
                let seg_lo = region.start.max(page_base);
                let seg_hi = region.last_address.min(page_last);
                let page_lo_off = (seg_lo - page_base) as usize;
                // 内容短于区域时,超出内容的部分保持页初始化的零填充;
                // 只拷贝本段与已定义内容的交集(区域不重叠 → 每字节至多写一次)。
                let content_len = content.len() as u64;
                if content_len > 0 && seg_lo - region.start < content_len {
                    let copy_hi = (seg_hi - region.start).min(content_len - 1);
                    let source = &content[(seg_lo - region.start) as usize..=copy_hi as usize];
                    page[page_lo_off..page_lo_off + source.len()].copy_from_slice(source);
                }
            }
        }

        Ok(Self {
            arch,
            page_size,
            mode,
            regions: regions.into_iter().map(|r| (r.start, r)).collect(),
            ids,
            pages,
        })
    }

    /// 架构位宽。
    pub fn arch(&self) -> ArchBits {
        self.arch
    }

    /// 页大小(D2 区间)。
    pub fn page_size(&self) -> u64 {
        self.page_size
    }

    /// 执行模式。
    pub fn mode(&self) -> ExecutionMode {
        self.mode
    }

    /// 区域表(按起始地址升序;确定性遍历)。
    pub fn regions(&self) -> impl Iterator<Item = &RegionSpec> {
        self.regions.values()
    }

    /// 按区域 id 查找。
    pub fn region_by_id(&self, region_id: &str) -> Option<&RegionSpec> {
        self.ids
            .get(region_id)
            .and_then(|start| self.regions.get(start))
    }

    /// 地址所在区域(含端点;未映射返回 `None`)。
    pub fn region_at(&self, addr: u64) -> Option<&RegionSpec> {
        let (_, region) = self.regions.range(..=addr).next_back()?;
        region.contains(addr).then_some(region)
    }

    /// 权限检查(读 / 写 / 取指统一入口;不触及数据)。
    ///
    /// 零长度访问视为无操作(不检查、不故障);跨区域范围逐段检查,
    /// 任一字节未映射或越权即整体拒绝。
    pub fn check(
        &self,
        addr: ArchValue,
        len: usize,
        required: PermKind,
    ) -> Result<(), MemoryFault> {
        self.locate(addr.get(), len, required).map(|_| ())
    }

    /// 读内存到 `out`(要求 `r`)。
    pub fn read_slice(&self, addr: ArchValue, out: &mut [u8]) -> Result<(), MemoryFault> {
        let base = addr.get();
        self.locate(base, out.len(), PermKind::Read)?;
        for (offset, slot) in out.iter_mut().enumerate() {
            *slot = self.page_byte(base + offset as u64);
        }
        Ok(())
    }

    /// 读内存(要求 `r`)。
    pub fn read(&self, addr: ArchValue, len: usize) -> Result<Vec<u8>, MemoryFault> {
        let mut out = vec![0u8; len];
        self.read_slice(addr, &mut out)?;
        Ok(out)
    }

    /// 写内存(要求 `w`)。
    pub fn write_slice(&mut self, addr: ArchValue, data: &[u8]) -> Result<(), MemoryFault> {
        let base = addr.get();
        self.locate(base, data.len(), PermKind::Write)?;
        for (offset, byte) in data.iter().enumerate() {
            self.set_page_byte(base + offset as u64, *byte);
        }
        Ok(())
    }

    /// 取指(要求 `x`;字节模式表层机器码即本方法读出的权威执行空间,D4.4)。
    pub fn fetch_slice(&self, addr: ArchValue, out: &mut [u8]) -> Result<(), MemoryFault> {
        let base = addr.get();
        self.locate(base, out.len(), PermKind::Exec)?;
        for (offset, slot) in out.iter_mut().enumerate() {
            *slot = self.page_byte(base + offset as u64);
        }
        Ok(())
    }

    /// 取指读出(要求 `x`)。
    pub fn fetch(&self, addr: ArchValue, len: usize) -> Result<Vec<u8>, MemoryFault> {
        let mut out = vec![0u8; len];
        self.fetch_slice(addr, &mut out)?;
        Ok(out)
    }

    /// 小端读 `n` 字节(1–8)为架构值(端序内建;契约端序冻结 little)。
    pub fn read_le(
        &self,
        addr: ArchValue,
        n: usize,
        arch: ArchBits,
    ) -> Result<ArchValue, MemoryFault> {
        assert!((1..=8).contains(&n), "LE 读宽度必须为 1–8 字节");
        let mut buf = [0u8; 8];
        self.read_slice(addr, &mut buf[..n])?;
        Ok(ArchValue::new(u64::from_le_bytes(buf), arch))
    }

    /// 小端写 `n` 字节(1–8),值按位宽掩蔽后取低 n 字节。
    pub fn write_le(
        &mut self,
        addr: ArchValue,
        value: ArchValue,
        n: usize,
    ) -> Result<(), MemoryFault> {
        assert!((1..=8).contains(&n), "LE 写宽度必须为 1–8 字节");
        let bytes = value.get().to_le_bytes();
        self.write_slice(addr, &bytes[..n])
    }

    /// 逐段权限定位:任一字节未映射 / 越权 / 回绕即整体拒绝(统一故障形态)。
    fn locate(&self, addr: u64, len: usize, required: PermKind) -> Result<(), MemoryFault> {
        if len == 0 {
            return Ok(());
        }
        let last = addr.checked_add(len as u64 - 1).ok_or(MemoryFault {
            addr,
            length: len,
            kind: MemoryFaultKind::AddressOverflow,
        })?;
        let mut cur = addr;
        while cur <= last {
            let region = self.region_at(cur).ok_or(MemoryFault {
                addr: cur,
                length: len,
                kind: MemoryFaultKind::Unmapped,
            })?;
            if !region.permissions.allows(required) {
                return Err(MemoryFault {
                    addr: cur,
                    length: len,
                    kind: MemoryFaultKind::PermissionDenied {
                        required,
                        actual: region.permissions,
                        region_id: region.region_id.clone(),
                    },
                });
            }
            // 段末 = min(请求末, 区域末);下一字节继续。
            cur = match region.last_address.checked_add(1) {
                Some(next) if next <= last => next,
                _ => return Ok(()),
            };
        }
        Ok(())
    }

    /// 读单字节(仅权限检查后使用)。
    fn page_byte(&self, addr: u64) -> u8 {
        let page = self
            .pages
            .get(&(addr / self.page_size))
            .expect("locate 已验证地址映射;页必然物化");
        page[(addr % self.page_size) as usize]
    }

    /// 写单字节(仅权限检查后使用)。
    fn set_page_byte(&mut self, addr: u64, byte: u8) {
        let page_size = self.page_size;
        let page = self
            .pages
            .get_mut(&(addr / page_size))
            .expect("locate 已验证地址映射;页必然物化");
        page[(addr % page_size) as usize] = byte;
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use alloc::vec;

    const A32: ArchBits = ArchBits::B32;
    const A64: ArchBits = ArchBits::B64;

    fn addr(a: u64) -> ArchValue {
        ArchValue::new(a, A32)
    }

    fn perm(s: &str) -> Permissions {
        Permissions::parse(s).expect("测试权限串必须合法")
    }

    fn region(id: &str, start: u64, len: u64, perms: &str) -> RegionSpec {
        RegionSpec::new(id, RegionKind::Global, None, start, len, perm(perms), A32)
            .expect("测试区域必须合法")
    }

    fn code_region(id: &str, start: u64, len: u64, perms: &str) -> RegionSpec {
        RegionSpec::new(id, RegionKind::Code, None, start, len, perm(perms), A32)
            .expect("测试区域必须合法")
    }

    fn contents(id: &str, bytes: &[u8]) -> RegionContents {
        RegionContents {
            region_id: String::from(id),
            bytes: Vec::from(bytes),
        }
    }

    fn mem(regions: Vec<RegionSpec>, contents: Vec<RegionContents>) -> VirtualMemory {
        VirtualMemory::new(A32, 4096, ExecutionMode::Ir, regions, contents)
            .expect("测试内存布局必须合法")
    }

    fn mem_res(
        regions: Vec<RegionSpec>,
        contents: Vec<RegionContents>,
    ) -> Result<VirtualMemory, MemoryConfigError> {
        VirtualMemory::new(A32, 4096, ExecutionMode::Ir, regions, contents)
    }

    // ─────────────────────────────────────────────────────────────────────
    // 权限形态与权限矩阵
    // ─────────────────────────────────────────────────────────────────────

    #[test]
    fn permissions_parse_canonical_subset_only() {
        for ok in ["", "r", "w", "x", "rw", "rx", "wx", "rwx"] {
            assert_eq!(perm(ok).as_str(), ok, "形态 {ok:?} 应可解析并回写");
        }
        for bad in ["wr", "xr", "xw", "rr", "q", "R", "rwxr", " r", "r "] {
            assert_eq!(
                Permissions::parse(bad),
                Err(MemoryConfigError::PermissionsMalformed),
                "形态 {bad:?} 必须拒绝(规范序 ^r?w?x?$)"
            );
        }
    }

    #[test]
    fn permission_matrix_read_write_fetch() {
        // 8 种权限 × 3 类访问的完整矩阵:允许当且仅当对应位存在。
        for p in ["", "r", "w", "x", "rw", "rx", "wx", "rwx"] {
            let permissions = perm(p);
            let m = mem(
                vec![region("seg", 0x1000, 4096, p)],
                vec![contents("seg", &[1, 2, 3])],
            );
            let a = addr(0x1000);
            assert_eq!(
                m.check(a, 1, PermKind::Read).is_ok(),
                permissions.can_read(),
                "读矩阵错误:p={p:?}"
            );
            assert_eq!(
                m.check(a, 1, PermKind::Write).is_ok(),
                permissions.can_write(),
                "写矩阵错误:p={p:?}"
            );
            assert_eq!(
                m.check(a, 1, PermKind::Exec).is_ok(),
                permissions.can_exec(),
                "取指矩阵错误:p={p:?}"
            );
        }
    }

    #[test]
    fn permission_denied_fault_carries_required_and_actual() {
        let m = mem(
            vec![region("seg", 0x1000, 4096, "rx")],
            vec![contents("seg", &[])],
        );
        let err = m.check(addr(0x1000), 4, PermKind::Write).unwrap_err();
        assert_eq!(
            err.kind,
            MemoryFaultKind::PermissionDenied {
                required: PermKind::Write,
                actual: perm("rx"),
                region_id: String::from("seg"),
            }
        );
    }

    // ─────────────────────────────────────────────────────────────────────
    // 越界红灯(6.1 硬件边界逐条)
    // ─────────────────────────────────────────────────────────────────────

    #[test]
    fn unmapped_access_is_rejected() {
        let m = mem(
            vec![region("seg", 0x1000, 4096, "rw")],
            vec![contents("seg", &[])],
        );
        // 区域之前 / 之后。
        assert_eq!(
            m.check(addr(0x0FFF), 1, PermKind::Read).unwrap_err().kind,
            MemoryFaultKind::Unmapped
        );
        assert_eq!(
            m.check(addr(0x2000), 1, PermKind::Read).unwrap_err().kind,
            MemoryFaultKind::Unmapped
        );
        // 末字节可读,越出末字节即未映射。
        assert!(m.check(addr(0x1FFF), 1, PermKind::Read).is_ok());
        let err = m.check(addr(0x1FFF), 2, PermKind::Read).unwrap_err();
        assert_eq!(err.kind, MemoryFaultKind::Unmapped);
        assert_eq!(err.addr, 0x2000, "故障地址应为缺失段首");
    }

    #[test]
    fn address_overflow_is_rejected() {
        let m = mem(
            vec![region("seg", 0x1000, 4096, "rw")],
            vec![contents("seg", &[])],
        );
        // 32 位域:addr+len 不回绕 64 位容器,但越出 2^32 → 未映射。
        assert_eq!(
            m.check(addr(0xFFFF_FFFF), 1, PermKind::Read)
                .unwrap_err()
                .kind,
            MemoryFaultKind::Unmapped
        );
        // 64 位域:构造接近容器顶的地址,len 使 addr+len 回绕 → AddressOverflow。
        let m64 = VirtualMemory::new(
            A64,
            4096,
            ExecutionMode::Ir,
            vec![
                RegionSpec::new(
                    "top",
                    RegionKind::Global,
                    None,
                    u64::MAX - 0xFFF,
                    0x1000,
                    perm("rw"),
                    A64,
                )
                .unwrap(),
            ],
            vec![contents("top", &[])],
        )
        .unwrap();
        let top = ArchValue::new(u64::MAX, A64);
        let err = m64.check(top, 2, PermKind::Read).unwrap_err();
        assert_eq!(err.kind, MemoryFaultKind::AddressOverflow);
        assert_eq!(err.addr, u64::MAX);
        // 末字节本身可读。
        assert!(m64.check(top, 1, PermKind::Read).is_ok());
    }

    #[test]
    fn range_crossing_region_boundary_is_fully_checked() {
        // seg_a = rw @0x1000..0x1FFF(含),seg_b = r @0x2000..0x2FFF(含)。
        let m = mem(
            vec![
                region("seg_a", 0x1000, 4096, "rw"),
                region("seg_b", 0x2000, 4096, "r"),
            ],
            vec![contents("seg_a", &[]), contents("seg_b", &[])],
        );
        // 跨界读:两段都可读 → 成功。
        assert!(m.check(addr(0x1FFF), 2, PermKind::Read).is_ok());
        // 跨界写:b 段不可写 → 整体拒绝,故障地址在 b 段首。
        let err = m.check(addr(0x1FFF), 2, PermKind::Write).unwrap_err();
        assert_eq!(err.addr, 0x2000);
        // 跨界写入同样整体拒绝且不产生部分写入。
        let mut m3 = mem(
            vec![
                region("seg_a", 0x1000, 4096, "rw"),
                region("seg_b", 0x2000, 4096, "r"),
            ],
            vec![contents("seg_a", &[]), contents("seg_b", &[])],
        );
        m3.write_slice(addr(0x1FFF), &[0xAA, 0xBB]).unwrap_err();
        // a 段未写入(整体拒绝语义)。
        assert_eq!(m3.read(addr(0x1FFF), 1).unwrap(), vec![0]);
    }

    #[test]
    fn zero_length_access_is_noop() {
        let m = mem(
            vec![region("seg", 0x1000, 4096, "")],
            vec![contents("seg", &[])],
        );
        // 零长度:即使权限为空也不检查(不触及数据,无信息泄露面)。
        assert!(m.check(addr(0x1000), 0, PermKind::Read).is_ok());
        assert!(m.read(addr(0x9000), 0).is_ok());
    }

    // ─────────────────────────────────────────────────────────────────────
    // 装载红灯(布局约束逐条)
    // ─────────────────────────────────────────────────────────────────────

    #[test]
    fn page_size_domain_is_enforced() {
        let regions = vec![region("seg", 0x1000, 4096, "rw")];
        let contents = vec![contents("seg", &[])];
        for bad in [0u64, 4000, 4095, 65537, 69632, 131072] {
            assert_eq!(
                VirtualMemory::new(
                    A32,
                    bad,
                    ExecutionMode::Ir,
                    regions.clone(),
                    contents.clone()
                )
                .unwrap_err(),
                MemoryConfigError::PageSizeInvalid { value: bad },
                "页大小 {bad} 必须拒绝"
            );
        }
        for good in [4096u64, 8192, 16384, 32768, 65536] {
            assert!(
                VirtualMemory::new(
                    A32,
                    good,
                    ExecutionMode::Ir,
                    regions.clone(),
                    contents.clone()
                )
                .is_ok()
            );
        }
    }

    #[test]
    fn region_spec_red_lights() {
        // 空 id。
        assert_eq!(
            RegionSpec::new("", RegionKind::Global, None, 0x1000, 4096, perm("rw"), A32),
            Err(MemoryConfigError::EmptyRegionId)
        );
        // custom 缺标签 / 空标签。
        assert_eq!(
            RegionSpec::new(
                "seg",
                RegionKind::Custom,
                None,
                0x1000,
                4096,
                perm("rw"),
                A32
            ),
            Err(MemoryConfigError::CustomLabelRequired)
        );
        assert_eq!(
            RegionSpec::new(
                "seg",
                RegionKind::Custom,
                Some(""),
                0x1000,
                4096,
                perm("rw"),
                A32
            ),
            Err(MemoryConfigError::CustomLabelRequired)
        );
        // 非 custom 带标签。
        assert_eq!(
            RegionSpec::new(
                "seg",
                RegionKind::Stack,
                Some("my stack"),
                0x1000,
                4096,
                perm("rw"),
                A32
            ),
            Err(MemoryConfigError::CustomLabelForbidden)
        );
        // 长度为 0。
        assert!(matches!(
            RegionSpec::new("seg", RegionKind::Global, None, 0x1000, 0, perm("rw"), A32),
            Err(MemoryConfigError::RegionEmpty { .. })
        ));
        // 非 4KB 倍数。
        assert_eq!(
            RegionSpec::new(
                "seg",
                RegionKind::Global,
                None,
                0x1000,
                4097,
                perm("rw"),
                A32
            ),
            Err(MemoryConfigError::RegionBytesNotAligned {
                region_id: String::from("seg"),
                byte_length: 4097,
            })
        );
        // 超 16 MiB。
        assert!(matches!(
            RegionSpec::new(
                "seg",
                RegionKind::Global,
                None,
                0x1000,
                16 * 1024 * 1024 + 4096,
                perm("rw"),
                A32
            ),
            Err(MemoryConfigError::RegionTooLarge { .. })
        ));
        // 超出 32 位地址域(0x1_0000_0000 起始)。
        assert!(matches!(
            RegionSpec::new(
                "seg",
                RegionKind::Global,
                None,
                0x1_0000_0000,
                4096,
                perm("rw"),
                A32
            ),
            Err(MemoryConfigError::RegionAddressSpaceExceeded { .. })
        ));
        // 末字节恰好 2^32 − 1 合法。
        assert!(
            RegionSpec::new(
                "seg",
                RegionKind::Global,
                None,
                0xFFFF_F000,
                0x1000,
                perm("rw"),
                A32
            )
            .is_ok()
        );
    }

    #[test]
    fn layout_red_lights_overlap_duplicate_count_total() {
        // 重叠。
        assert_eq!(
            VirtualMemory::new(
                A32,
                4096,
                ExecutionMode::Ir,
                vec![
                    region("a", 0x1000, 8192, "rw"),
                    region("b", 0x2000, 4096, "rw")
                ],
                vec![contents("a", &[]), contents("b", &[])],
            )
            .unwrap_err(),
            MemoryConfigError::RegionsOverlap {
                first_id: String::from("a"),
                second_id: String::from("b"),
            }
        );
        // 相邻不交合法。
        assert!(
            mem(
                vec![
                    region("a", 0x1000, 4096, "rw"),
                    region("b", 0x2000, 4096, "rw")
                ],
                vec![contents("a", &[]), contents("b", &[])],
            )
            .region_by_id("b")
            .is_some()
        );
        // id 重复。
        assert!(matches!(
            mem_res(
                vec![
                    region("a", 0x1000, 4096, "rw"),
                    region("a", 0x3000, 4096, "rw")
                ],
                vec![contents("a", &[]), contents("a", &[])],
            ),
            Err(MemoryConfigError::DuplicateRegionId { .. })
        ));
        // 数量超 64。
        let many: Vec<RegionSpec> = (0..65)
            .map(|i| region("seg", 0x1000 + i as u64 * 0x10000, 4096, "rw"))
            .collect();
        let many_contents: Vec<RegionContents> = (0..65).map(|_| contents("seg", &[])).collect();
        assert_eq!(
            mem_res(many, many_contents).unwrap_err(),
            MemoryConfigError::RegionCountExceeded { count: 65 }
        );
        // 总量超 64 MiB。
        let big: Vec<RegionSpec> = (0..5)
            .map(|i| {
                region(
                    "big",
                    0x10_0000 + i as u64 * 0x1000_0000,
                    16 * 1024 * 1024,
                    "rw",
                )
            })
            .collect();
        assert!(matches!(
            mem_res(big, (0..5).map(|_| contents("big", &[])).collect()),
            Err(MemoryConfigError::TotalMemoryExceeded { .. })
        ));
    }

    #[test]
    fn contents_red_lights() {
        // 缺内容。
        assert!(matches!(
            mem_res(vec![region("a", 0x1000, 4096, "rw")], vec![]),
            Err(MemoryConfigError::ContentsMissing { .. })
        ));
        // 引用未声明区域。
        assert!(matches!(
            mem_res(
                vec![region("a", 0x1000, 4096, "rw")],
                vec![contents("a", &[]), contents("ghost", &[])],
            ),
            Err(MemoryConfigError::ContentsUnknownRegion { .. })
        ));
        // 重复内容。
        assert!(matches!(
            mem_res(
                vec![region("a", 0x1000, 4096, "rw")],
                vec![contents("a", &[]), contents("a", &[])],
            ),
            Err(MemoryConfigError::ContentsDuplicate { .. })
        ));
        // 内容超区域容量。
        assert!(matches!(
            mem_res(
                vec![region("a", 0x1000, 4096, "rw")],
                vec![contents("a", [0u8; 4097].as_slice())],
            ),
            Err(MemoryConfigError::ContentsTooLarge { .. })
        ));
    }

    // ─────────────────────────────────────────────────────────────────────
    // W^X(D4.5)
    // ─────────────────────────────────────────────────────────────────────

    #[test]
    fn byte_mode_rejects_writable_code_region() {
        let regions = || vec![code_region("code", 0x1000, 4096, "rwx")];
        let contents_v = || vec![contents("code", &[0x90])];
        assert_eq!(
            VirtualMemory::new(A32, 4096, ExecutionMode::ByteCode, regions(), contents_v())
                .unwrap_err(),
            MemoryConfigError::CodeWritableInByteMode {
                region_id: String::from("code"),
            }
        );
        // 仅 w 也拒绝(含 w 即违规)。
        assert!(matches!(
            VirtualMemory::new(
                A32,
                4096,
                ExecutionMode::ByteCode,
                vec![code_region("code", 0x1000, 4096, "w")],
                contents_v(),
            ),
            Err(MemoryConfigError::CodeWritableInByteMode { .. })
        ));
        // rx 合法。
        assert!(
            VirtualMemory::new(
                A32,
                4096,
                ExecutionMode::ByteCode,
                vec![code_region("code", 0x1000, 4096, "rx")],
                contents_v(),
            )
            .is_ok()
        );
        // IR 模式不受约束。
        assert!(VirtualMemory::new(A32, 4096, ExecutionMode::Ir, regions(), contents_v()).is_ok());
    }

    #[test]
    fn code_region_write_is_runtime_fault_even_in_ir_mode() {
        // IR 模式装载合法(r-x 代码区),运行期写仍按权限统一拒绝。
        let mut m = mem(
            vec![
                code_region("code", 0x1000, 4096, "rx"),
                region("data", 0x2000, 4096, "rw"),
            ],
            vec![contents("code", &[0x90, 0xC3]), contents("data", &[])],
        );
        assert!(matches!(
            m.write_slice(addr(0x1000), &[0x00]),
            Err(MemoryFault {
                kind: MemoryFaultKind::PermissionDenied {
                    required: PermKind::Write,
                    ..
                },
                ..
            })
        ));
        assert!(m.write_slice(addr(0x2000), &[0x41]).is_ok());
        assert!(m.check(addr(0x1000), 1, PermKind::Exec).is_ok());
    }

    // ─────────────────────────────────────────────────────────────────────
    // 数据面:初始内容、分页、小端
    // ─────────────────────────────────────────────────────────────────────

    #[test]
    fn initial_content_zero_fills_tail() {
        let m = mem(
            vec![region("seg", 0x1000, 8192, "rw")],
            vec![contents("seg", &[0xDE, 0xAD, 0xBE, 0xEF])],
        );
        assert_eq!(
            m.read(addr(0x1000), 4).unwrap(),
            vec![0xDE, 0xAD, 0xBE, 0xEF]
        );
        assert_eq!(m.read(addr(0x1004), 4).unwrap(), vec![0, 0, 0, 0]);
        // 区域尾部仍在页内零填充。
        assert_eq!(m.read(addr(0x2000 - 1), 1).unwrap(), vec![0]);
    }

    #[test]
    fn write_then_read_roundtrip() {
        let mut m = mem(
            vec![region("seg", 0x1000, 4096, "rw")],
            vec![contents("seg", &[])],
        );
        m.write_slice(addr(0x1080), &[1, 2, 3, 4, 5]).unwrap();
        assert_eq!(m.read(addr(0x1080), 5).unwrap(), vec![1, 2, 3, 4, 5]);
        // 未写字节不受影响。
        assert_eq!(m.read(addr(0x1085), 1).unwrap(), vec![0]);
    }

    #[test]
    fn access_across_page_boundary_within_region() {
        let mut m = mem(
            vec![region("seg", 0x1000, 8192, "rw")],
            vec![contents("seg", &[])],
        );
        // 0x1FFE..0x2001 横跨两页。
        m.write_slice(addr(0x1FFE), &[0xA1, 0xA2, 0xA3]).unwrap();
        assert_eq!(m.read(addr(0x1FFE), 3).unwrap(), vec![0xA1, 0xA2, 0xA3]);
    }

    #[test]
    fn large_pages_host_multiple_vmas_without_aliasing() {
        // 64KB 页承载两个 4KB 区域(字节区间不重叠 → 无别名)。
        let mut m = VirtualMemory::new(
            A32,
            65536,
            ExecutionMode::Ir,
            vec![
                region("lo", 0x1_0000, 4096, "rw"),
                region("hi", 0x1_1000, 4096, "rw"),
            ],
            vec![contents("lo", &[0x11]), contents("hi", &[0x22])],
        )
        .unwrap();
        assert_eq!(m.page_size(), 65536);
        // 各自内容正确。
        assert_eq!(m.read(addr(0x1_0000), 1).unwrap(), vec![0x11]);
        assert_eq!(m.read(addr(0x1_1000), 1).unwrap(), vec![0x22]);
        // 写 lo 不影响 hi(区间不重叠)。
        m.write_slice(addr(0x1_0000), &[0xFF]).unwrap();
        assert_eq!(m.read(addr(0x1_0000), 1).unwrap(), vec![0xFF]);
        assert_eq!(m.read(addr(0x1_1000), 1).unwrap(), vec![0x22]);
        // 权限权威在 VMA:hi 改为只读后写拒绝,lo 仍可写。
        let mut m2 = VirtualMemory::new(
            A32,
            65536,
            ExecutionMode::Ir,
            vec![
                region("lo", 0x1_0000, 4096, "rw"),
                region("hi", 0x1_1000, 4096, "r"),
            ],
            vec![contents("lo", &[]), contents("hi", &[])],
        )
        .unwrap();
        assert!(m2.write_slice(addr(0x1_0000), &[1]).is_ok());
        assert!(m2.write_slice(addr(0x1_1000), &[1]).is_err());
    }

    #[test]
    fn little_endian_typed_access() {
        let mut m = mem(
            vec![region("seg", 0x1000, 4096, "rw")],
            vec![contents("seg", &[])],
        );
        // 32 位值小端写入后按字节序读出为 LE。
        m.write_le(addr(0x1010), ArchValue::new(0x1234_5678, A32), 4)
            .unwrap();
        assert_eq!(
            m.read(addr(0x1010), 4).unwrap(),
            vec![0x78, 0x56, 0x34, 0x12]
        );
        assert_eq!(
            m.read_le(addr(0x1010), 4, A32).unwrap(),
            ArchValue::new(0x1234_5678, A32)
        );
        // 8 字节 LE。
        m.write_le(addr(0x1020), ArchValue::new(0x0123_4567_89AB_CDEF, A64), 8)
            .unwrap();
        assert_eq!(
            m.read_le(addr(0x1020), 8, A64).unwrap().get(),
            0x0123_4567_89AB_CDEF
        );
        // 64 位值写入 32 位域:写入前已按位宽掩蔽(write_le 接收掩蔽后的容器,
        // 值域由调用侧 ArchValue::new 保证;此处验证掩蔽值低位正确落盘)。
        m.write_le(addr(0x1030), ArchValue::new(0x1_0000_0002, A32), 4)
            .unwrap();
        assert_eq!(m.read_le(addr(0x1030), 4, A32).unwrap().get(), 2);
    }

    #[test]
    fn region_lookup_helpers() {
        let m = mem(
            vec![
                code_region("code", 0x1000, 4096, "rx"),
                region("stack", 0x7F_0000, 4096, "rw"),
            ],
            vec![contents("code", &[]), contents("stack", &[])],
        );
        assert_eq!(m.region_by_id("code").unwrap().start, 0x1000);
        assert!(m.region_by_id("nope").is_none());
        assert_eq!(m.region_at(0x1234).unwrap().region_id, "code");
        assert_eq!(m.region_at(0x7F_0042).unwrap().region_id, "stack");
        assert!(m.region_at(0x5000).is_none());
        // 区域按起始地址升序确定性遍历。
        let ids: Vec<&str> = m.regions().map(|r| r.region_id.as_str()).collect();
        assert_eq!(ids, vec!["code", "stack"]);
        assert_eq!(m.arch(), A32);
        assert_eq!(m.mode(), ExecutionMode::Ir);
    }

    #[test]
    fn fetch_returns_code_bytes() {
        let m = mem(
            vec![code_region("code", 0x1000, 4096, "rx")],
            vec![contents("code", &[0x90, 0xC3])],
        );
        assert_eq!(m.fetch(addr(0x1000), 2).unwrap(), vec![0x90, 0xC3]);
        // 不可执行区域取指拒绝(统一路径)。
        let m2 = mem(
            vec![region("data", 0x1000, 4096, "rw")],
            vec![contents("data", &[0x90])],
        );
        assert!(matches!(
            m2.fetch(addr(0x1000), 1),
            Err(MemoryFault {
                kind: MemoryFaultKind::PermissionDenied {
                    required: PermKind::Exec,
                    ..
                },
                ..
            })
        ));
    }

    #[test]
    fn fault_address_is_requested_start_for_permission_case() {
        let m = mem(
            vec![region("seg", 0x1000, 4096, "r")],
            vec![contents("seg", &[])],
        );
        let err = m.check(addr(0x1000), 8, PermKind::Write).unwrap_err();
        assert_eq!(err.addr, 0x1000);
        assert_eq!(err.length, 8);
    }
}
