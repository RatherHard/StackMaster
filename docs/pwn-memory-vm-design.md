# 面向 Pwn 初学者的可视化内存 VM 设计建议

## 1. 产品定位

建议将产品定义为：

> 一个可嵌入、可回放、可解释的 Pwn 概念实验室，而不是浏览器中的完整 Linux 或 x86 模拟器。

初学者最需要建立的因果链是：

```text
输入字节
→ 覆盖内存
→ 修改栈帧或数据
→ 影响寄存器
→ 改变控制流
→ 满足目标条件
```

因此，第一版应优先保证内存布局、寄存器、指针、调用栈和控制流之间的关系可见、可暂停、可回退和可解释。

---

## 2. 总体架构

```text
CTF 平台
   │
   │ iframe / Web Component / postMessage
   ▼
插件 Shell
   ├── 题目加载器
   ├── 可视化 UI
   ├── 嵌入协议
   └── 本地进度
          │
          ▼
Web Worker
   └── VM Runtime
          │
          ▼
纯 TypeScript VM Core
   ├── Virtual Memory
   ├── Registers
   ├── Stack / Heap
   ├── Call Frames
   ├── Operation Interpreter
   ├── Goal Evaluator
   └── Replay / Snapshot
```

建议从一开始按职责拆分：

```text
packages/
├── vm-core/              # 不依赖 DOM 的纯 VM
├── challenge-schema/      # JSON Schema、类型和校验器
├── challenge-compiler/    # DSL → 受限 IR
├── vm-ui/                # 内存、寄存器、时间线等 UI
├── embed-runtime/        # iframe 和 postMessage 协议
├── web-component/        # <pwn-memory-vm>
├── react-wrapper/        # 可选的 React 包装器
└── verifier/             # 服务端重放判题
```

核心原则：**VM Core 不应该知道自己运行在 Lit、React、iframe 还是 Node.js 中。**

---

## 3. 推荐技术选型

| 领域 | 推荐方案 | 说明 |
|---|---|---|
| 核心语言 | TypeScript | 浏览器、Node.js、插件 SDK 共享类型 |
| UI 组件 | Lit + Web Components | 框架无关，适合嵌入不同 CTF 平台 |
| 构建工具 | Vite | 适合库模式、Worker 和静态资源构建 |
| VM 执行线程 | Web Worker | 避免 VM 执行阻塞 UI |
| 题目格式 | JSON + JSON Schema | 可校验、可版本化、易于跨语言实现 |
| 运行时校验 | Ajv；内部可辅以 Zod | Ajv 面向公开 Schema，Zod 适合 TypeScript 内部 API |
| 本地状态 | IndexedDB | 支持离线进度和较大回放数据 |
| 单元测试 | Vitest | 适合纯 TypeScript Runtime |
| 属性测试 | fast-check | 验证内存边界、状态转换和回放一致性 |
| E2E 测试 | Playwright | 测试 iframe、交互和关键学习流程 |
| 无障碍测试 | axe-core | 检查键盘和 WCAG 基础问题 |
| 服务端判题 | Node.js + Fastify，或 FastAPI | 服务端重新执行提交并裁决 |
| 后续高性能后端 | Rust/WASM，可选 | 仅在性能或跨语言需求明确后引入 |

### 为什么不建议 React 作为主插件接口

如果只服务一个 React 平台，React 没有问题；但目标是兼容：

- CTFd；
- 静态 HTML；
- Vue、Angular；
- Django 模板；
- 自建训练平台；
- 内网教学站点。

因此更适合提供原生自定义元素：

```html
<script type="module" src="/assets/pwn-memory-vm.js"></script>

<pwn-memory-vm
  challenge-url="/challenges/stack-01.json"
  theme="dark">
</pwn-memory-vm>
```

React 和 Vue 可以作为额外的薄包装器，而不应成为核心运行时的依赖。

---

## 4. 插件嵌入方式

### 4.1 默认使用跨域 iframe

如果目标是“方便插入任何 CTF 靶场”，建议 iframe 作为默认分发形态：

```html
<iframe
  src="https://vm.example.org/embed/stack-01"
  title="Pwn 内存练习：栈帧与返回地址"
  sandbox="allow-scripts"
  loading="lazy">
</iframe>
```

优点：

- 宿主不需要安装前端依赖；
- 避免宿主 CSS 污染插件；
- 插件可以独立发布、升级和回滚；
- 兼容不同语言和前端框架；
- 插件出现异常时较少影响宿主页面。

建议将插件部署到专用来源，例如：

```text
CTF 平台：ctf.example.com
VM 插件：vm.example.org
判题 API：verify.example.org
管理后台：admin.example.org
```

公开 iframe 不应与管理后台共享高权限 Cookie 或管理端 API。

### 4.2 Web Component 作为可信宿主模式

对于同组织、同源或明确可信的平台，可以提供：

```html
<pwn-memory-vm challenge-id="stack-01"></pwn-memory-vm>
```

但要注意：**Shadow DOM 和 Web Component 不是安全边界。** 如果题目包或插件代码不可信，仍应使用独立来源 iframe。

### 4.3 postMessage 协议

不要让宿主直接修改 iframe 内部 DOM 或 VM 状态，应定义独立、版本化的消息协议：

```ts
interface EmbedMessage {
  protocolVersion: 1;
  type:
    | "handshake"
    | "ready"
    | "start"
    | "pause"
    | "reset"
    | "progress"
    | "complete"
    | "error";
  sessionId: string;
  sequence: number;
  requestId?: string;
  payload?: unknown;
}
```

接收消息时必须：

- 校验 `event.origin`；
- 校验 `event.source` 是否为预期 iframe；
- 使用明确的 `targetOrigin`，不要使用 `"*"`；
- 校验消息结构、版本和字段范围；
- 拒绝未知消息类型；
- 处理重复、乱序和过期消息；
- 限制消息大小和频率；
- 不把宿主发来的“已通过”或“得分”当作权威结果。

---

## 5. VM 设计原则

### 5.1 不要一开始模拟完整 Linux

第一版不建议实现：

- 完整 x86-64 指令集；
- ELF 加载器；
- glibc malloc；
- Linux syscall；
- 真实 shellcode；
- 任意 C 代码执行；
- 真实容器中的二进制运行；
- 完整 ASLR、PIE、Canary 和所有 libc 细节。

这些内容会把项目快速推向 CPU/OS 模拟器，显著增加开发、测试和安全成本。

### 5.2 第一版应模拟的内容

#### 内存区域

```text
代码区
全局区
堆区
栈区
关键区
```

#### 寄存器

```text
RSP
RBP
RIP
RAX
RBX
RCX
RDI
RSI
RDX
一些FLAG
```

#### 操作

```text
push
pop
mov
add
xor
or
and
sub
各种jmp
call
ret
伪接口调用：read、write 这些
```

MVP 不需要让操作等同于完整机器指令。可以把用户操作和机器动作分开：

```text
教学操作：执行给定的操作、执行、查看内存、提交 payload
机器动作：内存写入、寄存器变化、call、ret、异常
```

### 5.3 VM 状态机

推荐将状态转换设计为：

```text
nextState = reduce(previousState, operation)
```

核心结构可以是：

```ts
interface VmState {
  registers: Registers;
  memory: VirtualMemory;
  callFrames: CallFrame[];
  instructionPointer: InstructionPointer;
  eventLog: VmEvent[];
  constraints: RuntimeConstraints;
  status: "running" | "paused" | "won" | "failed";
}
```

所有状态变化必须经过统一入口：

```text
用户操作
→ 边界校验
→ VM 状态转换
→ 结构化事件
→ 公开状态投影
→ 目标条件检查
```

不要让 UI 直接修改 VM 内存对象。

### 5.4 使用 BigInt 表示 64 位值

地址和 64 位整数不建议全部使用 JavaScript `number`，否则可能超过安全整数范围。建议：

- 地址和值在 VM Core 中使用 `bigint`；
- 展示层负责转换为十六进制字符串；
- DSL 中使用明确的字符串格式，例如 `"0x7fffffffe000"`；
- 明确定义溢出、符号扩展和移位行为。

---

## 6. 回放、撤销和快照

推荐采用：

```text
事件日志 + 周期性快照
```

而不是只保存最终状态，也不是只保存一条无限增长的事件流。

核心 API 可以设计成：

```ts
interface VmEngine {
  getState(): VmState;
  execute(operation: Operation): Result<VmState, VmError>;
  undo(): Result<VmState, VmError>;
  reset(): VmState;
  replay(operations: Operation[]): ReplayResult;
  snapshot(): VmSnapshot;
}
```

每次操作可以记录：

- 操作类型；
- 操作参数；
- 前后状态哈希；
- 发生了哪些内存变化；
- 哪些寄存器变化；
- 哪个对象受到影响；
- 当前事件序号；
- 题目、VM Profile 和引擎版本。

建议采用不可变逻辑状态，并把内存按固定大小分页。修改时只复制受影响的页，从而兼顾可回放性和性能。

回放必须是确定性的。不要依赖：

- 当前时间；
- 浏览器随机数；
- 网络响应顺序；
- 宿主线程调度；
- 不同浏览器的未定义行为。

如果题目需要随机化，应由服务端提供确定性 seed，并把 seed 策略和引擎版本记录到回放信息中。

---

## 7. 题目 DSL 设计

建议采用声明式 JSON 题目格式，发布前经过：

```text
作者 DSL
  → Schema 校验
  → 静态检查
  → 编译为受限 IR
  → VM Runtime 执行
```

JSON Schema 负责描述和验证：

- 字段类型；
- 必填字段；
- 数值范围；
- 数组长度；
- 字符串长度；
- 嵌套结构。

执行语义由固定的 Runtime、Operation Registry 和 Goal Evaluator 提供。

### 7.1 建议包含的字段

```text
元数据
+ VM Profile
+ 初始内存状态
+ 初始寄存器
+ 教学对象
+ 允许操作
+ 资源限制
+ 提示阶梯
+ checkpoint
+ 成功条件
+ 失败条件
+ 版本信息
```

示例：

```json
{
  "schemaVersion": "1.0",
  "id": "stack-ret-01",
  "title": "找回正确的返回地址",
  "vmProfile": "x86_64-teaching-v1",
  "memory": {
    "stack": {
      "base": "0x7fffffffe000",
      "size": 256
    }
  },
  "objects": [
    {
      "id": "buffer",
      "region": "stack",
      "offset": 0,
      "size": 32,
      "role": "local-buffer"
    },
    {
      "id": "saved-rbp",
      "region": "stack",
      "offset": 32,
      "size": 8,
      "role": "saved-frame-pointer"
    },
    {
      "id": "return-address",
      "region": "stack",
      "offset": 40,
      "size": 8,
      "role": "return-address"
    }
  ],
  "allowedOperations": [
    "write_bytes",
    "ret"
  ],
  "constraints": {
    "maxSteps": 20,
    "maxWrites": 3,
    "maxInputSize": 80
  },
  "winCondition": {
    "type": "instruction-reached",
    "symbol": "win"
  }
}
```

### 7.2 不要把 DSL 设计成脚本语言

禁止以下形式：

```json
{
  "onStep": "eval(userInput)"
}
```

也不应允许：

- JavaScript、Python、Lua 回调；
- `eval` 或 `Function`；
- 动态导入；
- 用户自定义函数；
- 任意 WebAssembly；
- 文件系统、网络和进程访问；
- 无限循环和无限递归；
- 根据用户输入构造宿主对象引用。

如果未来确实需要复杂逻辑，应使用：

```text
DSL
→ AST
→ 静态检查
→ 受限 IR
→ 白名单解释器
```

更推荐将复杂判题逻辑逐步沉淀为经过审计的内置谓词，而不是开放任意脚本。

### 7.3 题目 DSL 的能力边界

表达式最多支持：

- 常量；
- 只读寄存器引用；
- 命名内存区域查询；
- 有界整数运算；
- 位运算；
- 比较；
- 布尔组合；
- 固定长度切片；
- 有界字节模式匹配；
- 枚举值比较。

题目引用的对象应通过 capability 白名单提供，例如：

```text
register:rdi
memory:main_stack
event:syscall
counter:input_reads
virtual_file:flag
```

DSL 不能直接访问宿主对象，也不能动态拼接 capability 名称。

### 7.4 多阶段题目使用有限状态机

多阶段题目建议采用有限状态机：

```text
初始状态
  → 阶段 A
  → 阶段 B
  → 阶段 C
  → 成功状态
```

每个状态包含：

- 允许操作；
- 前置条件；
- 迁移条件；
- 有限副作用；
- 失败条件；
- 资源预算。

不要在 DSL 中提供无限跳转和任意递归。循环必须有静态上限或动态指令预算。

---

## 8. 版本管理

至少区分以下版本：

1. **DSL Schema Version**：题目格式和表达式语义；
2. **VM Engine Version**：指令、异常、内存和调度行为；
3. **VM Profile Version**：寄存器、ABI、地址空间和保护机制；
4. **Challenge Content Version**：单个题目的题面、初始状态和判题目标。

正式判题记录应同时保存：

- Challenge Bundle hash；
- DSL 版本；
- VM Profile hash；
- Engine build ID；
- 判题规则版本；
- 随机种子策略；
- 规范化提交内容哈希。

不要在生产环境自动使用“最新引擎”。正式题目应锁定执行环境。

题目包发布前建议：

- 固定字段顺序；
- 统一数字和字节串表示；
- 明确默认值；
- 禁止重复键；
- 计算内容哈希；
- 对发布清单签名；
- 运行参考解和边界输入回归测试。

---

## 9. 判题设计

### 9.1 浏览器端负责交互，服务端负责最终裁决

浏览器端可以即时显示成功或失败，但正式 CTF 成绩不能信任前端状态。

客户端提交的应是操作序列或规范化 IR：

```json
{
  "challengeId": "stack-ret-01",
  "challengeVersion": "1.0.0",
  "operations": [
    {
      "type": "write_bytes",
      "address": "0x7fffffffded8",
      "value": "b611400000000000"
    },
    {
      "type": "ret"
    }
  ]
}
```

服务端重新：

1. 校验用户、租户和题目权限；
2. 校验题目版本；
3. 解析和检查操作；
4. 使用相同初始状态和 seed；
5. 在独立 Worker 中执行；
6. 检查步数、内存、输入、输出和超时；
7. 判断成功条件；
8. 记录结果、状态哈希和版本信息。

服务端只相信用户提交了哪些动作，不相信用户声称的最终内存、寄存器、RIP 或成功标志。

### 9.2 API 与判题 Worker 分离

推荐结构：

```text
API 服务
  ├── 认证
  ├── 授权
  ├── 限流
  ├── 请求大小校验
  └── 投递任务
          ↓
判题队列
          ↓
独立判题 Worker
```

Worker 应具备：

- 独立进程或容器；
- 最大 CPU 时间；
- 最大内存；
- 最大执行步数；
- 最大输出和轨迹长度；
- 无网络；
- 无非必要文件系统访问；
- 无子进程创建；
- 无环境变量密钥；
- 可强制终止；
- 最大重试次数。

### 9.3 判题结果分类

建议使用稳定的结果类型：

```text
success
wrong_answer
invalid_action
program_crash
memory_fault
resource_limit
timeout
engine_error
challenge_invalid
replay_mismatch
cancelled
```

对选手展示用户友好的有限信息；内部堆栈、文件路径、隐藏测试和宿主异常只进入受控日志。

### 9.4 不要过度暴露隐藏测试

不应发送给浏览器：

- 标准答案；
- 隐藏测试输入；
- 完整判题逻辑；
- 详细隐藏字段；
- 逐测试用例差异；
- 服务端内部状态。

反馈应该足以帮助学习，但不能成为无限精确的隐藏测试 oracle。

---

## 10. 安全模型

### 10.1 三个边界

建议明确拆分：

1. **浏览器可视化层**：只负责交互、动画和预览；
2. **受限 DSL/VM 执行层**：只执行有限指令和状态迁移；
3. **服务端权威判题层**：独立重放并保存正式结果。

客户端可以被完全篡改，但不能因此影响服务端最终成绩。

### 10.2 iframe 安全

- 使用独立来源；
- 使用最小化 `sandbox` 权限；
- 谨慎开启 `allow-same-origin`；
- 不把长期凭证放入 URL；
- 不让 iframe 访问管理端 Cookie；
- 使用 `frame-ancestors` 限制允许的宿主来源；
- 不把 iframe 视为最终判题边界。

### 10.3 CSP 和响应头

生产环境应根据实际资源配置 CSP，重点包括：

- 禁止 `unsafe-eval`；
- 限制 `script-src`；
- 限制 `worker-src`；
- 限制 `connect-src`；
- 禁止不必要的对象和插件内容；
- 限制 `form-action`；
- 配置 `frame-ancestors`；
- 使用 HTTPS、HSTS、严格 Referrer Policy 和 Permissions Policy。

### 10.4 多租户隔离

如果未来服务多个 CTF 平台，每个资源都应带租户作用域：

- 用户；
- 题目；
- 题目版本；
- 隐藏测试；
- 提交；
- 判题任务；
- 结果；
- 日志；
- 缓存；
- 对象存储。

不能只按资源 ID 查询。缓存键、对象路径和数据库查询都必须包含租户和权限作用域。

同时需要设置：

- 每租户并发判题数量；
- 每租户每分钟提交次数；
- 每租户 CPU、内存和存储预算；
- 管理端与公开嵌入端的来源和会话隔离。

### 10.5 不要依赖前端反作弊

以下措施不能作为真正的安全控制：

- 禁止右键；
- 禁用开发者工具；
- 混淆前端代码；
- 检测控制台；
- 依赖前端倒计时；
- 只在前端计算分数。

有效控制应放在服务端：

- 服务端随机种子；
- 隐藏测试；
- 服务端重放；
- 一次性或短期提交凭证；
- 操作序列和状态版本检查；
- 限流；
- 审计日志；
- 资源配额。

---

## 11. 可视化和教学交互

推荐界面结构：

```text
┌──────────────────────────────────────┐
│ 题目目标 / 概念 / 步数 / 提示          │
├──────────────────┬───────────────────┤
│  内存与栈帧       │  寄存器 / 调用栈    │
│  地址 / 字节      │  RSP/RBP/RIP       │
│  变量 / 指针      │  当前函数          │
├──────────────────┴───────────────────┤
│ Payload：填充 / 字符串 / 整数 / 地址    │
├──────────────────────────────────────┤
│ 运行 / 单步 / 后退 / 重置 / 时间线       │
├──────────────────────────────────────┤
│ 状态 diff / 错误解释 / 分级提示          │
└──────────────────────────────────────┘
```

### 11.1 两种内存视图

#### 结构视图

```text
高地址
┌────────────────┐
│ return address │
├────────────────┤
│ saved RBP      │
├────────────────┤
│ buffer[32]     │
└────────────────┘
低地址
```

#### 字节视图

```text
地址              Hex                  ASCII   语义
0x7fffffffe040    41 41 41 41 ...      AAAA    buffer
0x7fffffffe060    00 00 ...                     saved RBP
0x7fffffffe068    b6 11 40 00 ...       ..@     return address
```

两种视图必须联动：

- 点击 `return address`，高亮对应字节；
- 点击 payload 某个字节，显示它最终覆盖的对象；
- 通过颜色和文本同时区分用户输入、程序写入和初始数据；
- 指针 hover 时显示引用关系。

### 11.2 执行粒度

推荐提供：

| 模式 | 用途 |
|---|---|
| 运行到结果 | 初学者快速验证 |
| 执行到关键事件 | 在输入、call、ret 和异常处暂停 |
| 单条机器动作 | 理解寄存器和控制流 |
| 单字节 diff | 排查 payload 覆盖范围 |

关键暂停点：

- 输入写入完成；
- 函数调用前后；
- 栈帧建立和销毁；
- `ret` 执行前；
- 控制流跳转后；
- Canary、NX 等保护触发时。

必须支持：

- 上一步；
- 重放；
- 重置；
- 创建检查点；
- 时间线拖动；
- 当前状态与上一次状态对比。

### 11.3 Payload 构造器

不要只提供一个黑色终端输入框。可以提供以下字节块：

- 填充：`A × 40`；
- 原始字符串；
- 整数值；
- 地址；
- 空字节；
- 已编码字节。

每个块显示：

- 逻辑值；
- 实际字节；
- 长度；
- 端序；
- 在最终 payload 中的偏移。

可以提供辅助解释，但不要默认替用户计算所有关键偏移或自动修正端序，否则会削弱学习过程。

### 11.4 错误反馈

不要只显示：

```text
Segmentation fault
```

建议显示：

```text
ret 从 0x7fffffffe068 读取了
0x4141414141414141 作为新的 RIP。

该地址不在可执行区域内，因此 VM 停止。

建议检查：
- padding 长度；
- 地址是否使用 little-endian；
- ret 执行前 RSP 的位置。
```

错误类型至少包括：

- 输入格式错误；
- payload 长度错误；
- 偏移不足；
- 偏移过长；
- 端序错误；
- 写入不可写区域；
- RIP 指向不可执行区域；
- Canary 被破坏；
- 参数寄存器错误；
- 已进入目标函数但最终条件未满足。

提示建议分四级：

```text
Hint 1：观察 RBP 和 RSP。
Hint 2：找出 buffer 与 return address 的距离。
Hint 3：计算需要填充的字节数。
Hint 4：检查目标地址的 little-endian 表示。
```

---

## 12. 题目难度路线

建议按知识和状态变化组织课程：

```text
Level 0  地址、字节、十六进制
Level 1  栈帧和局部变量
Level 2  小端序
Level 3  覆盖相邻变量
Level 4  找到返回地址偏移
Level 5  ret2win
Level 6  调用约定和 RDI
Level 7  简化 ROP
Level 8  NX、Canary、PIE、ASLR
Level 9  信息泄露
Level 10 格式化字符串
Level 11 堆和 UAF
```

建议遵循：

> 每道题只引入一个主要新概念，最多复习一个旧概念。

初始题目可以使用固定地址。等用户理解覆盖和控制流后，再引入 ASLR、PIE、Canary 和 NX。

---

## 13. MVP 范围

第一版只做一个完整闭环：

### 栈帧、缓冲区和返回地址

包括：

- 栈内存可视化；
- RSP/RBP/RIP；
- 局部 buffer；
- saved RBP；
- return address；
- little-endian；
- `write_bytes`；
- `push/pop`；
- `call/ret`；
- 单步执行；
- 回退；
- checkpoint；
- 分级提示；
- JSON 题目格式；
- iframe demo；
- Web Component；
- 服务端重放接口；
- 6—10 道渐进式题目。

第一版暂时不要加入：

- 任意 ELF 上传；
- 任意 shellcode 执行；
- 完整 Linux；
- 完整 glibc；
- 复杂堆分配器；
- 多架构；
- 在线题目编辑器；
- AI 自动生成 exploit；
- 多人实时协作。

---

## 14. 开发顺序

### 阶段 1：冻结协议和语义

先定义：

- `VmState`；
- `Operation`；
- `VmEvent`；
- snapshot/replay 格式；
- Challenge Schema；
- 错误格式；
- iframe handshake；
- 版本策略。

### 阶段 2：实现纯 VM Core

暂时不做复杂 UI，完成：

- 内存读写；
- 栈帧；
- 寄存器；
- `call/ret`；
- 成功和失败条件；
- 回放；
- 边界测试。

### 阶段 3：实现教学 UI

加入：

- 结构视图；
- 字节视图；
- 寄存器；
- Payload 构造器；
- diff；
- 时间线；
- hint；
- 错误解释。

### 阶段 4：实现 iframe 插件

加入：

- 独立构建产物；
- postMessage；
- 自适应高度；
- 主题和语言；
- 静态题目加载；
- Worker 重启和错误恢复。

### 阶段 5：接入服务端判题

加入：

- 认证；
- 租户隔离；
- 限流；
- 判题队列；
- 独立 Worker；
- 服务端重放；
- 审计日志。

### 阶段 6：扩展高级能力

根据真实教学反馈再加入：

- 堆；
- ROP；
- 防护机制；
- 信息泄露；
- 更完整指令集；
- WASM；
- 真实 ELF 实验模式。

---

## 15. 测试和质量保障

### VM Core

必须测试：

- 地址读写；
- 越界访问；
- 不可写和不可执行区域；
- little-endian；
- 栈帧创建和销毁；
- `push/pop`；
- `call/ret`；
- Canary 触发；
- reset 和 checkpoint；
- snapshot 恢复；
- 事件重放一致性；
- 随机种子确定性；
- 超时和指令预算；
- Worker 崩溃恢复。

### DSL

必须测试：

- Schema 校验；
- 版本迁移；
- 未定义引用；
- 地址重叠；
- 无法到达目标；
- 循环和深度限制；
- 过大的内存和字符串；
- 隐藏区域意外公开；
- 恶意嵌套结构；
- 重复键和类型混淆。

### 插件协议

必须测试：

- handshake 超时；
- 重复消息；
- 消息乱序；
- 非法序列号；
- 不受信任来源；
- iframe 重载；
- 宿主不支持能力；
- 宿主销毁插件；
- Worker 重启后恢复状态。

### UI 和部署

至少覆盖：

- 320、375、768、1024、1440、1920 宽度；
- Chrome、Firefox、Safari；
- 主题切换；
- 键盘操作；
- reduced-motion；
- 高对比度；
- 非根路径部署；
- 受限 CSP；
- 无后端环境；
- 网络中断后的本地运行。

---

## 16. 最终建议

推荐技术路线：

```text
TypeScript 纯 VM Core
+ Web Worker
+ Lit Web Components
+ Vite Library Mode
+ JSON Schema/Ajv
+ IndexedDB
+ Vitest
+ Playwright
+ iframe/postMessage
+ Node.js/FastAPI 服务端重放
```

并坚持四条底线：

1. **题目 DSL 不执行任意宿主代码。**
2. **浏览器端不负责最终计分。**
3. **默认使用独立来源 iframe。**
4. **VM Core、UI、插件协议和 CTF 平台适配层解耦。**

如果这四点做好，后续无论增加堆利用、ROP、保护机制，还是接入不同 CTF 平台，都不需要推翻第一版架构。

---

## 17. 参考资料

- [MDN：iframe、sandbox 与 postMessage](https://developer.mozilla.org/en-US/docs/Web/HTML/Reference/Elements/iframe)
- [Lit：Web Components 概览](https://lit.dev/docs/components/overview/)
- [Vite：Library Mode 与库构建](https://vite.dev/guide/build)
- [JSON Schema：结构描述与数据校验](https://json-schema.org/learn/getting-started-step-by-step)
