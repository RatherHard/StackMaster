# 前端高效实现可视化内存 VM

## 1. 目标与基本原则

可视化内存 VM 的性能瓶颈通常不在“执行一条指令”本身，而在以下链路：

```text
VM 执行
→ 创建事件对象
→ Worker 与主线程通信
→ Structured Clone / 数据复制
→ UI 重新渲染
→ 浏览器布局、绘制和垃圾回收
```

因此，前端优化的优先级应是：

```text
Worker 隔离
> 减少消息数量
> 增量传输 diff
> 避免全量渲染
> 紧凑 IR
> 分页内存
> 快照优化
> 最后再考虑 WASM
```

核心原则：

1. VM 权威状态只由 Worker 持有。
2. 主线程只保存公开状态投影和 UI 状态。
3. UI 不接收完整 VM 状态，只接收增量变化。
4. VM 执行、事件生成和 UI 渲染分层处理。
5. 只有 benchmark 证明必要时，才引入低层优化或 WASM。

---

## 2. 推荐线程模型

```text
主线程
├── 题目说明
├── Payload 编辑器
├── 内存可视化
├── 寄存器面板
├── 时间线
└── 用户交互

Web Worker
├── VM 权威状态
├── 指令执行
├── 内存读写
├── 目标判定
├── 回放
└── 快照
```

主线程不应保存一份可以直接修改的 VM 状态，Worker 也不应把完整状态反复发送给主线程。推荐采用以下模式：

```text
Worker 持有完整状态
       ↓
生成公开状态投影和 VmDelta
       ↓
主线程只更新变化的 UI 部分
```

这样可以避免：

- UI 意外修改 VM；
- 主线程和 Worker 状态不一致；
- 每次操作都复制整个内存；
- 大量结构化克隆；
- 状态对象被多个组件重复持有。

如果 Worker 发生异常或卡死，宿主应能够终止并重启 Worker，然后从最近的 checkpoint 恢复，而不是让 VM 运行在主线程中作为默认回退方案。

---

## 3. 不要每条指令都发送消息

不推荐：

```ts
for (const instruction of program) {
  execute(instruction);

  self.postMessage({
    type: "instruction-executed",
    state: getEntireState()
  });
}
```

这会造成：

- 消息数量爆炸；
- 大量 Structured Clone；
- 主线程频繁更新；
- UI 产生大量 layout 和 paint；
- 垃圾回收压力增加；
- 暂停和输入响应变慢。

推荐按教学动作或关键事件批量发送：

```ts
interface VmBatchResult {
  sequenceStart: number;
  sequenceEnd: number;
  registerDiff: RegisterDiff[];
  memoryWrites: MemoryWrite[];
  controlFlow: ControlFlowEvent[];
  status: VmStatus;
}
```

一个批次可以执行：

```text
执行 1—4ms 的 VM 工作
→ 汇总寄存器变化
→ 合并连续内存写入
→ 生成一个 VmDelta
→ postMessage 一次
```

对于初学者模式，可以进一步按教学事件发送：

```text
执行 write → 返回一次结果
执行 call  → 返回一次结果
执行 ret   → 返回一次结果
```

不需要暴露每一条底层机器动作。

---

## 4. 分层执行模式

建议实现三种执行模式，而不是始终采用最细粒度的调试。

### 4.1 动作级执行

面向初学者：

```text
执行一次 Payload 写入
执行到 ret
执行到下一个函数调用
执行到异常
```

性能最好，也最符合初学者的学习目标。

### 4.2 事件级执行

在关键事件处暂停：

```text
read
write
call
ret
syscall
memory fault
canary failure
```

适合普通教学和调试。

### 4.3 指令级执行

只有用户主动打开“指令级调试”时才启用：

```text
mov
push
pop
add
sub
jmp
call
ret
```

指令级模式需要承担更多事件、快照和渲染开销，不应作为默认模式。

---

## 5. 内存模型：逻辑区域加分页

不要用一个巨大数组表示完整的 64 位地址空间：

```ts
// 不推荐
const memory = new Uint8Array(0x100000000);
```

教学 VM 实际使用的地址通常很少，推荐采用：

```text
Virtual Address
       ↓
Memory Region
       ↓
Page
       ↓
Uint8Array
```

基础结构：

```ts
interface MemoryRegion {
  id: number;
  name: string;
  base: bigint;
  size: number;
  permissions: PagePermissions;
  pages: Map<number, MemoryPage>;
}

interface MemoryPage {
  bytes: Uint8Array;
  version: number;
  permissions: number;
}
```

逻辑区域可以包括：

```text
code
rodata
globals
heap
stack
input
```

### 5.1 固定小题目的快速实现

如果每道题的内存区域固定且很小，可以直接为每个区域分配一个 `Uint8Array`：

```ts
interface FastRegion {
  baseLo: number;
  baseHi: number;
  size: number;
  bytes: Uint8Array;
}
```

地址访问过程为：

```text
绝对地址
→ 找到 region
→ 计算 region offset
→ 访问 Uint8Array
```

这通常比对每个字节使用全局 Map 更快。

### 5.2 根据规模选择结构

| 内存规模和特征 | 推荐结构 |
|---|---|
| 小型固定题目 | 每个区域一个 `Uint8Array` |
| 需要快照和回退 | 分页 `Uint8Array` + Copy-on-Write |
| 稀疏高地址空间 | `Map<pageId, Page>` |
| 大量内存展示 | 分页 + 虚拟列表或 Canvas |

不要为了模拟完整地址空间而实际分配完整物理内存。VM 的虚拟地址和存储结构应分离。

---

## 6. 64 位值的内部表示

题目 DSL 和公开 API 可以使用十六进制字符串：

```json
{
  "address": "0x7fffffffe000"
}
```

内部表示需要根据 benchmark 选择。

### 6.1 BigInt：优先正确性

```ts
const address = 0x7fffffffe000n;
```

优点：

- 语义直观；
- 不会超过 JavaScript 安全整数范围；
- 代码容易验证；
- 适合加载、校验和非热路径。

缺点：

- 在高频地址运算和位运算中可能慢于普通整数；
- 与 `number` 混用需要显式转换；
- 可能增加对象和临时值开销。

### 6.2 `number`：仅适用于受控地址范围

如果 VM 的内部地址已经映射到小范围连续偏移，可以让热路径使用 `number`：

```ts
const stackOffset = address - stackBase;
```

注意不能使用普通 `number` 表示可能超过 `2^53 - 1` 的完整绝对地址。

### 6.3 lo/hi 两个 32 位整数：高性能选项

如果 benchmark 证明 BigInt 是瓶颈，可以使用：

```ts
interface U64 {
  lo: number;
  hi: number;
}
```

寄存器可使用 TypedArray：

```ts
const registerLo = new Uint32Array(REGISTER_COUNT);
const registerHi = new Uint32Array(REGISTER_COUNT);
```

不建议第一天就手写完整的 64 位优化层。推荐顺序是：

```text
先用 BigInt 建立正确实现
→ 建立 benchmark
→ 确认热路径
→ 只替换热路径的数据表示
```

对于每题只有几百到几万步的教学 VM，BigInt 往往已经足够。

---

## 7. 将 DSL 编译为紧凑 IR

不要在每条指令执行时解释多层 JSON 对象：

```ts
{
  opcode: "mov",
  dst: "rax",
  src: {
    type: "immediate",
    value: "0x1234"
  }
}
```

题目加载阶段应执行：

```text
JSON DSL
→ Schema 校验
→ 静态分析
→ 编译为 IR
→ Worker 执行 IR
```

### 7.1 数字化 opcode 和寄存器

```ts
const enum Opcode {
  Mov = 1,
  Add = 2,
  Push = 3,
  Pop = 4,
  Call = 5,
  Ret = 6,
  Read = 7,
  Write = 8,
}

const enum Register {
  Rax = 0,
  Rbx = 1,
  Rcx = 2,
  Rdx = 3,
  Rdi = 4,
  Rsi = 5,
  Rsp = 6,
  Rbp = 7,
  Rip = 8,
}
```

指令可以使用稳定的数字字段：

```ts
interface Instruction {
  opcode: number;
  dst: number;
  src: number;
  immediateLo: number;
  immediateHi: number;
}
```

或者使用 TypedArray：

```ts
const opcodes = new Uint8Array(instructionCount);
const operands = new Uint32Array(instructionCount * 3);
const immediatesLo = new Uint32Array(instructionCount);
const immediatesHi = new Uint32Array(instructionCount);
```

这样可以减少：

- 字符串比较；
- 临时对象创建；
- 属性查找；
- 垃圾回收；
- JSON 解释成本。

原始 DSL 应保留用于题目作者和 UI 展示，热路径只运行编译后的 IR。

---

## 8. 指令分发策略

第一版优先使用可读的数字 `switch`：

```ts
switch (opcode) {
  case Opcode.Mov:
    executeMov();
    break;
  case Opcode.Add:
    executeAdd();
    break;
  case Opcode.Push:
    executePush();
    break;
  case Opcode.Ret:
    executeRet();
    break;
}
```

现代 JavaScript 引擎通常能够优化稳定的数字 `switch`。它的优势是：

- 代码容易审查；
- 逻辑容易测试；
- 异常路径清晰；
- 不需要动态生成函数；
- 不引入 `eval` 或动态代码执行。

只有 benchmark 证明指令分发是主要瓶颈时，才比较函数表：

```ts
const handlers: InstructionHandler[] = [];
handlers[Opcode.Mov] = executeMov;
handlers[Opcode.Add] = executeAdd;
```

不能预设函数表一定比 `switch` 更快，因为额外的函数调用也会产生开销。

---

## 9. 增量 diff，而不是全量状态

不推荐：

```ts
postMessage({
  type: "state",
  memory: entireMemory,
  registers: entireRegisters,
});
```

推荐只发送发生变化的内容：

```ts
interface VmDelta {
  sequenceStart: number;
  sequenceEnd: number;
  memoryRanges: MemoryDeltaRange[];
  registerChanges: RegisterChange[];
  semanticChanges: SemanticChange[];
  controlFlow?: ControlFlowDelta;
  status?: VmStatus;
}

interface MemoryDeltaRange {
  regionId: number;
  offset: number;
  bytes: Uint8Array;
}
```

维护 dirty page：

```ts
const dirtyPages = new Set<number>();
```

写内存时只标记受影响页面：

```ts
dirtyPages.add(pageId);
```

批次结束时：

```text
只发送 dirty pages 和局部 diff
```

连续写入应合并成一个范围：

```text
地址 0x1000：写入 40 字节
地址 0x1028：写入 8 字节
```

而不是为每个字节创建一个对象。

---

## 10. 使用 Transferable 传输大块数据

小型消息直接使用 `postMessage` 即可。对于大段内存、快照和回放，可以转移 `ArrayBuffer`：

```ts
const buffer = new ArrayBuffer(size);
worker.postMessage({ type: "memory", buffer }, [buffer]);
```

这可以避免复制，但转移后发送方不再拥有该 buffer。因此大数据路径可以使用双缓冲：

```text
Worker 写入 buffer A
主线程接收 buffer A
Worker 切换到 buffer B
主线程处理 buffer A
处理完成后复用 buffer A
```

不要默认使用 `SharedArrayBuffer`。它需要跨源隔离响应头，而 CTF 平台的部署环境不一定能够配置 COOP/COEP。只有当 benchmark 证明 Transferable 不够时，才考虑共享内存方案。

---

## 11. UI 渲染优化

### 11.1 使用 requestAnimationFrame 合并更新

即使 Worker 在一帧内产生多个批次，主线程也不应该每收到一次消息就完整渲染。

```ts
let pendingDelta: VmDelta | null = null;
let frameScheduled = false;

function receiveDelta(delta: VmDelta) {
  pendingDelta = mergeDelta(pendingDelta, delta);

  if (!frameScheduled) {
    frameScheduled = true;

    requestAnimationFrame(() => {
      frameScheduled = false;

      if (pendingDelta) {
        renderDelta(pendingDelta);
        pendingDelta = null;
      }
    });
  }
}
```

这样可以将多个 Worker 更新合并成一次 UI 更新。

### 11.2 不要让每个字节都成为复杂组件

建议按可视化规模选择技术：

| 展示规模 | 推荐方案 |
|---|---|
| 0—512 字节 | DOM/HTML 表格 |
| 512—4,096 字节 | 虚拟列表 + DOM |
| 4,096—几十万字节 | Canvas 或 WebGL |
| 指针和控制流关系 | SVG |
| 屏幕阅读器信息 | 独立语义化 DOM 摘要 |

MVP 推荐：

```text
字节视图：虚拟化 DOM
指针箭头：SVG
大量原始内存：Canvas
```

不要使用 Canvas 绘制所有内容。Canvas 适合数据量大、交互少的区域，但不利于：

- 键盘导航；
- 屏幕阅读器；
- 精确点击定位；
- 视觉回归测试；
- 语义化错误反馈。

### 11.3 只更新变化的 cell

不推荐每次写入都重绘整张内存表：

```ts
render(memory);
```

推荐：

```ts
renderMemoryDiff({
  changedRanges: [
    { start: 40, end: 48 }
  ]
});
```

对于 Lit 或 React，应避免让一个全局 VM 状态变化导致所有 cell 组件重新计算。可以按 region、page 或可视窗口拆分更新范围。

---

## 12. 语义索引：不要每次扫描全部内存

VM 需要知道：

```text
这次写入影响了 buffer 还是 return address？
哪个指针引用了这块内存？
哪个寄存器发生变化？
```

不要在每次渲染时重新扫描全部内存和全部对象。加载题目时预先建立索引：

```ts
interface SemanticIndex {
  addressToObject: IntervalIndex;
  objectToReferences: Map<string, Reference[]>;
  registerToObjects: Map<number, string[]>;
}
```

写入时只查询受影响区间：

```text
写入范围 [40, 48)
→ 查询区间索引
→ 找到 return-address
→ 生成 semantic diff
```

MVP 内存很小时，排序后的范围数组就够用；堆和复杂指针关系增加后，再考虑区间树。

---

## 13. 快照和撤销：Copy-on-Write

不要每一步都复制完整状态：

```ts
// 不推荐
const snapshot = structuredClone(vmState);
```

推荐使用分页 Copy-on-Write：

```ts
interface VmSnapshot {
  registers: RegisterSnapshot;
  pages: PageTable;
  eventIndex: number;
  instructionPointer: number;
}
```

执行写入时：

```text
当前页仍被旧快照引用
→ 复制该页
→ 只修改新页
```

只有被修改的页面需要复制。

建议快照策略：

```text
每 512—4096 条机器动作建立内部 checkpoint
每个教学动作结束建立用户可见 checkpoint
```

对于初学者，动作级回退通常比逐条指令回退更有价值：

```text
执行 write
执行 ret
回退到 write 前
```

---

## 14. Worker 执行循环

Worker 应同时具备：

1. 指令预算；
2. 时间片；
3. 可暂停和可终止；
4. 每批执行后主动让出控制权。

示意：

```ts
const CHECK_INTERVAL = 256;
const MAX_BATCH_MS = 4;

function runChunk() {
  const start = performance.now();
  let executed = 0;

  while (
    runtime.isRunning &&
    executed < runtime.remainingBudget
  ) {
    for (
      let i = 0;
      i < CHECK_INTERVAL &&
      runtime.isRunning &&
      executed < runtime.remainingBudget;
      i++
    ) {
      runtime.step();
      executed++;
    }

    if (performance.now() - start >= MAX_BATCH_MS) {
      break;
    }
  }

  const delta = runtime.flushDelta();
  self.postMessage(delta);

  if (runtime.isRunning) {
    setTimeout(runChunk, 0);
  }
}
```

注意：

- `performance.now()` 只用于 Worker 调度，不应进入 VM 的可观察语义；
- VM 的随机数、虚拟时间和执行成本必须是确定性的；
- 批次太长会导致暂停按钮响应变慢；
- 批次太短会增加消息和调度开销。

可以先从以下参数开始 benchmark：

```text
普通模式：每批 1—4ms
指令检查间隔：128—1,024 条
教学事件模式：遇到关键事件立即停止
高速回放模式：减少 UI 消息，批量处理
```

---

## 15. 编译后的 IR 与展示数据分离

教学 VM 需要同时满足两类需求：

```text
高效执行
可视化解释
```

不要强迫一份数据结构同时承担两种职责。推荐分离：

```text
Compiled IR
  └── 用于高效执行

Raw Code Bytes
  └── 用于内存和机器码展示

Source/Pseudo Instructions
  └── 用于初学者解释
```

例如：

```text
IR 中的 Ret 指令
代码区中的机器码字节
UI 中的“从栈顶读取新的 RIP”解释
```

这样可以避免每一步都做完整的：

```text
读取代码字节
→ 指令解码
→ 解析操作数
→ 执行
```

同时仍然可以展示当前代码地址、机器码、伪指令和代码区覆盖效果。

---

## 16. 性能模式和教学模式分离

推荐至少提供三种 Runtime 配置：

### 教学模式

特点：

- 每个关键动作都生成解释；
- 保留较详细 diff；
- 允许回退；
- UI 更新频率较高；
- 优先保证可理解性。

### 高速回放模式

特点：

- 批量执行大量操作；
- 减少中间事件；
- 只保留关键 checkpoint；
- UI 以时间线或进度形式更新。

### 诊断模式

特点：

- 保存更细粒度事件；
- 支持指令级暂停；
- 允许导出 trace；
- 只用于开发和题目调试。

不要为了让默认教学模式跑得极快而牺牲解释质量，也不要让诊断模式的开销拖慢普通用户。

---

## 17. WebAssembly 的使用时机

不要因为项目叫 VM 就默认使用 WASM。

### 17.1 暂时使用 TypeScript 的情况

如果每道题：

- 执行几百到几十万步；
- 内存不超过几 MB；
- 主要价值是交互和解释；
- 只需要少量并发；
- VM 指令集比较简单；

TypeScript + Worker 通常已经足够。

### 17.2 可以考虑 WASM 的情况

以下条件出现时再评估：

- 指令级执行达到数百万到数千万步；
- Worker benchmark 证明 VM 执行是主要瓶颈；
- 服务端和浏览器必须共享同一高性能核心；
- 需要更复杂的真实指令模拟；
- 大量回放需要高速重执行；
- 已有 Rust/C++ VM 核心可以复用。

即使使用 WASM，也应采用：

```text
WASM Worker
→ 批量执行一段指令
→ 一次返回 diff
```

不要采用：

```text
每执行一条 WASM 指令
→ 回调 JavaScript
→ 更新 UI
```

频繁跨越 WASM/JavaScript 边界会抵消 WASM 的性能收益。

---

## 18. Benchmark 设计

不要凭感觉决定是否优化。至少建立以下基准。

### 18.1 VM 指令基准

执行：

```text
10 万条
100 万条
1000 万条
```

比较：

- BigInt；
- `number`；
- lo/hi `Uint32`；
- 对象形式指令；
- TypedArray IR；
- `switch`；
- handler table。

### 18.2 事件基准

比较：

```text
每条指令发送
每 100 条发送
每个关键事件发送
每个教学动作发送
```

记录：

- 消息数量；
- 总传输字节；
- Worker 时间；
- 主线程时间；
- 暂停响应时间。

### 18.3 渲染基准

比较：

```text
完整重绘
局部 DOM 更新
虚拟列表
Canvas
```

测试规模：

```text
512 bytes
4 KB
64 KB
1 MB
```

### 18.4 回放基准

比较：

```text
完整快照
事件流重放
事件流 + checkpoint
Copy-on-Write checkpoint
```

记录：

- 执行时间；
- 内存占用；
- GC 次数；
- checkpoint 大小；
- 任意位置跳转时间；
- 恢复后继续执行时间。

---

## 19. 建议的性能验收指标

可以先设定以下工程目标：

```text
主线程长任务：尽量小于 50ms
普通 UI 帧更新：尽量小于 8ms
暂停按钮响应：小于 100ms
普通 Worker batch：1—4ms
普通模式：每个教学动作只产生少量消息
高速执行：每帧最多一次 UI 更新
小题目回放跳转：小于 100ms
内存视图：只更新 changed ranges
```

这些指标应通过实际设备测试，而不是只在开发机上测试。至少覆盖：

- 低端笔记本；
- 普通桌面机；
- Chrome/Edge；
- Firefox；
- Safari；
- 受限 CPU 或节能模式。

---

## 20. 推荐实现顺序

### 阶段 1：正确性优先

- TypeScript 纯 VM Core；
- 固定内存区域；
- BigInt 地址和值；
- 对象形式 IR；
- Worker 执行；
- 基础事件和测试。

### 阶段 2：减少通信

- `VmDelta`；
- dirty page；
- 连续写入合并；
- 批量消息；
- `requestAnimationFrame` 合并 UI 更新。

### 阶段 3：提高执行效率

- 编译为数字 opcode IR；
- 区域内相对偏移；
- 分页内存；
- Copy-on-Write 快照；
- 预计算语义索引。

### 阶段 4：优化可视化

- 虚拟化内存列表；
- SVG 指针图层；
- Canvas 大规模原始内存视图；
- 只更新变化 cell；
- 教学模式、回放模式和诊断模式分离。

### 阶段 5：benchmark 后再决定

- BigInt 是否替换为 lo/hi；
- 是否引入 Transferable buffer 池；
- 是否需要 SharedArrayBuffer；
- 是否需要 WASM；
- 是否需要更复杂的内存索引。

---

## 21. 最终推荐配置

对于第一版可视化内存 VM，推荐：

```text
语言：TypeScript
执行：Web Worker
内存：固定区域 + Uint8Array
地址：外部十六进制字符串，内部先用 BigInt
指令：编译后的数字 opcode IR
状态：Worker 单独持有
通信：批量 VmDelta
渲染：requestAnimationFrame + 局部更新
字节视图：虚拟化 DOM
指针关系：SVG
大规模原始内存：Canvas
快照：分页 Copy-on-Write
回放：操作日志 + 周期性 checkpoint
```

### 优先级总结

```text
1. Worker 隔离
2. 消息批量化
3. 增量 diff
4. UI 局部渲染
5. 紧凑 IR
6. 分页内存
7. Copy-on-Write 快照
8. Transferable 大数据传输
9. lo/hi 64 位优化
10. WASM
```

一句话总结：

> **不要让 VM 每一步都驱动 UI；让 VM 批量执行，让通信只传变化，让 UI 按帧合并更新。**

这比一开始将整个 VM 改写成 WASM，更可能带来实际可感知的性能提升，也更适合可视化 Pwn 教学产品。
