/**
 * 跨域载荷机检扫描器(阶段三 WP-7;ZR-B4 / B5 / B9 / B10 通道录制面 + ZR-B1 /
 * B6 语料法接线)。
 *
 * 定位(权威 API 语义规约 D-API-60;规则定义逐字对应
 * `docs/develop/秘密零驻留CI检查项映射.md` §三 / §四,本文只登记落点不改写规则):
 *
 *  - **ZR-B9 共现规则**:单 JSON 对象 ≥ 3 个 `VmState` 字段名键(VmState 冻结
 *    字段表:registers / memory / callFrames / instructionPointer /
 *    privateEventLog / constraints / seedState / status);外加 §三 ZR-B9 行的
 *    词边界模式(类型名 / 字段名 / crate 名)对键名与字符串值的通道级复核;
 *  - **ZR-B10 完整事件日志形态**:Internal / FileGranted / FileRead 私有事件
 *    类别与 `privateEventLog` 键结构性无映射路径的通道级复核(公开事件冻结
 *    六类小写 kind,大写私有类别出现在通道即生成面 / 承载面缺陷);
 *  - **ZR-B5 快照魔数 / 版本头**:密文信封魔数 "SMEN" 与明文信封标记
 *    `stackmaster-session-snapshot` 均不得出现在通道——快照是 worker 所有
 *    SERVER_ONLY blob,编排器只存取、不解析、不下发(D-W8-11);
 *  - **ZR-B4 私有题目包内容**:键名集合语料(private-bundle、
 *    secretSinkRegisters、declaredSeedPublicPaths、seedHex、hiddenTests、
 *    judgingConfig、compiledIr 等,与 tooling/scan-public-artifacts.mjs 同源);
 *  - **ZR-B1 / ZR-B6 语料**:flag 样式与 seed 十六进制样式,复用 WP-3
 *    `scanSecretCorpus` 的语料模式(D-API-26 预留的复用点)。
 *
 * 边界纪律(与 D-API-26 同一定位):
 *  - 本扫描器是**录制机检的测试锚点**,不是运行时硬闸——玩家 write_bytes
 *    合法回显是 I-9 / ZR-P8 的 sanctioned 通道,运行期防线是"拒绝不入账 +
 *    投影白名单";
 *  - 服务端签发标识符(sessionId / requestId / checkpointId / submissionId /
 *    jti)是冻结字符集 `^[A-Za-z0-9_-]{1,128}$` 的随机串,32-hex 形态与
 *    ZR-B6 seed 语料同形,语料扫描对其键豁免(误报豁免,非泄漏通道);
 *  - 公开投影的合法十六进制载荷字段(bytesHex / payloadHex / valueHex /
 *    bytesHash 类)按 I-10 值来源约束只承载玩家输入或可见区域字节,seed 语料
 *    对其值豁免(否则零填充区域必然真阳性;该面的结构性主防线是 I-10 /
 *    ZR-P8,语料法是兜底)。
 */

import { scanSecretCorpus } from "../persistence/secret-scanner.js";

/** 机检命中(条目 ID 携带上游清单编号;path 为 JSON 指针风格的载荷路径)。 */
export interface CrossDomainHit {
  readonly id:
    | "ZR-B1-flag-corpus"
    | "ZR-B4-bundle-key"
    | "ZR-B5-snapshot-envelope"
    | "ZR-B6-seed-corpus"
    | "ZR-B9-cooccurrence"
    | "ZR-B9-identifier"
    | "ZR-B10-private-event-form";
  readonly path: string;
  /** 命中证据(违规键名 / 词法标记 / 语料样式前缀;非秘密合成语料)。 */
  readonly token: string;
}

/**
 * ZR-B9 共现规则的 VmState 字段名键集合(vm-core/src/state.rs 冻结字段表的
 * 序列化形态;共现阈值 ≥ 3,映射文档 §三 ZR-B9 行原文)。
 */
export const VM_STATE_FIELD_KEYS: readonly string[] = [
  "registers",
  "memory",
  "callFrames",
  "instructionPointer",
  "privateEventLog",
  "constraints",
  "seedState",
  "status",
];

/** ZR-B9 共现阈值(单 JSON 对象命中所需的最小 VmState 字段名键数)。 */
export const ZR_B9_CO_OCCURRENCE_THRESHOLD = 3;

/** ZR-B9 词边界模式:类型名(§三 ZR-B9 行冻结集合)。 */
const VM_TYPE_NAME_PATTERNS: readonly RegExp[] = [
  /\bVmState\b/,
  /\bRuntimeConstraints\b/,
  /\bSeedState\b/,
  /\bVirtualMemory\b/,
  /\bVmEvent\b/,
];

/** ZR-B9 词边界模式:字段名(§三 ZR-B9 行冻结集合)。 */
const VM_FIELD_NAME_PATTERNS: readonly RegExp[] = [
  /\bprivateEventLog\b/,
  /\bseedState\b/,
  /\binstructionPointer\b/,
];

/** ZR-B9 词边界模式:crate 名(ZR-B3 引用;引擎 crate 与编译器 crate)。 */
const VM_CRATE_NAME_PATTERNS: readonly RegExp[] = [
  /\bvm-engine\b/,
  /\bvm-worker\b/,
  /\bvm-core\b/,
  /\bvm-runtime\b/,
  /\bchallenge-compiler\b/,
];

/** ZR-B10:私有事件类别(公开面冻结六类之外的结构性无映射路径集合)。 */
export const PRIVATE_EVENT_KINDS: readonly string[] = ["Internal", "FileGranted", "FileRead"];

/** ZR-B5:密文信封魔数(仅密文形态自识别;通道上出现即快照越界)。 */
export const SNAPSHOT_CIPHER_MAGIC = "SMEN";

/** ZR-B5:明文快照信封标记(`stackmaster-session-snapshot/1`)。 */
export const SNAPSHOT_ENVELOPE_MARKER = "stackmaster-session-snapshot";

/** ZR-B4:私有题目包键名语料(与 tooling/scan-public-artifacts.mjs 同源)。 */
const PRIVATE_BUNDLE_KEY_PATTERNS: readonly RegExp[] = [
  /\bprivate-bundle\b/,
  /\bprivateBundle\b/,
  /\bsecretSinkRegisters\b/,
  /\bdeclaredSeedPublicPaths\b/,
  /\bseedHex\b/,
  /\bhiddenTests\b/,
  /\bjudgingConfig\b/,
  /\bcompiledIr\b/,
  /\bentrypointAddressHex\b/,
  /\bcontainsSecret\b/,
  /\bisHidden\b/,
];

/**
 * 服务端签发标识符键(冻结字符集随机串;与 ZR-B6 seed 语料同形,语料扫描
 * 豁免——误报豁免,见文件头边界纪律)。键名精确匹配,不豁免其子树中其他键。
 */
const SERVER_ISSUED_ID_KEYS: readonly string[] = [
  "sessionId",
  "requestId",
  "checkpointId",
  "submissionId",
  "embedSessionId",
  "jti",
  "idempotencyKey",
];

/**
 * 公开投影的合法十六进制载荷键(I-10 值来源:玩家输入或可见区域字节;零填充
 * 区域使 ≥32 hex 的字符串必然存在,seed 语料对其值豁免,防真阳性)。
 */
const PUBLIC_HEX_PAYLOAD_KEYS: readonly string[] = ["bytesHex", "payloadHex", "valueHex"];

function wordBoundaryHit(patterns: readonly RegExp[], text: string): string | null {
  for (const pattern of patterns) {
    if (pattern.test(text)) {
      return pattern.source;
    }
  }
  return null;
}

/** 单个 JSON 对象层的机检(共现 + 键名语料 + 私有事件形态)。 */
function scanObjectKeys(object: Record<string, unknown>, path: string, hits: CrossDomainHit[]): void {
  const keys = Object.keys(object);

  // ZR-B9 共现规则:单 JSON 对象 ≥ 3 个 VmState 字段名键。
  const vmStateKeys = keys.filter((key) => VM_STATE_FIELD_KEYS.includes(key));
  if (vmStateKeys.length >= ZR_B9_CO_OCCURRENCE_THRESHOLD) {
    hits.push({
      id: "ZR-B9-cooccurrence",
      path,
      token: vmStateKeys.sort().join(","),
    });
  }

  for (const key of keys) {
    const keyPath = `${path}/${key}`;
    // ZR-B9 词边界模式:键名面。
    const keyHit =
      wordBoundaryHit(VM_TYPE_NAME_PATTERNS, key) ??
      wordBoundaryHit(VM_FIELD_NAME_PATTERNS, key) ??
      wordBoundaryHit(VM_CRATE_NAME_PATTERNS, key);
    if (keyHit !== null) {
      hits.push({ id: "ZR-B9-identifier", path: keyPath, token: keyHit });
    }
    // ZR-B4 键名语料。
    const bundleHit = wordBoundaryHit(PRIVATE_BUNDLE_KEY_PATTERNS, key);
    if (bundleHit !== null) {
      hits.push({ id: "ZR-B4-bundle-key", path: keyPath, token: bundleHit });
    }
    // ZR-B10:私有事件类别键(privateEventLog 是 VmState 私有事件日志的键)。
    if (key === "privateEventLog" || key === "eventLog") {
      hits.push({ id: "ZR-B10-private-event-form", path: keyPath, token: key });
    }
  }
}

/** 字符串值层的机检(词边界模式 + 语料法;identifier 键豁免语料)。 */
function scanStringValue(key: string | null, value: string, path: string, hits: CrossDomainHit[]): void {
  // ZR-B9 词边界模式 / ZR-B4 键名语料:字符串值面(词边界保证标识符片段、
  // 注释性子串不误报;语料模式自带 gi 形态)。
  const identifierHit =
    wordBoundaryHit(VM_TYPE_NAME_PATTERNS, value) ??
    wordBoundaryHit(VM_FIELD_NAME_PATTERNS, value) ??
    wordBoundaryHit(VM_CRATE_NAME_PATTERNS, value);
  if (identifierHit !== null) {
    hits.push({ id: "ZR-B9-identifier", path, token: identifierHit });
  }
  const bundleHit = wordBoundaryHit(PRIVATE_BUNDLE_KEY_PATTERNS, value);
  if (bundleHit !== null) {
    hits.push({ id: "ZR-B4-bundle-key", path, token: bundleHit });
  }

  // ZR-B5:快照魔数 / 信封标记(密文与明文形态都不得出现在通道;子串检测——
  // 魔数 / 标记不是冻结标识符字符集的合法片段)。
  const magicIndex = value.indexOf(SNAPSHOT_CIPHER_MAGIC);
  if (magicIndex >= 0) {
    hits.push({ id: "ZR-B5-snapshot-envelope", path, token: SNAPSHOT_CIPHER_MAGIC });
  }
  const markerIndex = value.indexOf(SNAPSHOT_ENVELOPE_MARKER);
  if (markerIndex >= 0) {
    hits.push({ id: "ZR-B5-snapshot-envelope", path, token: SNAPSHOT_ENVELOPE_MARKER });
  }

  // ZR-B10:kind 值 = 私有事件类别(公开 kind 冻结六类全小写,形态可区分)。
  if ((key === "kind" || key === "type") && PRIVATE_EVENT_KINDS.includes(value)) {
    hits.push({ id: "ZR-B10-private-event-form", path, token: value });
  }

  // ZR-B1 / ZR-B6 语料:服务端签发标识符键与公开十六进制载荷键豁免
  // (文件头边界纪律);其余字符串值逐个过语料。
  if (key !== null && SERVER_ISSUED_ID_KEYS.includes(key)) {
    return;
  }
  if (key !== null && PUBLIC_HEX_PAYLOAD_KEYS.includes(key)) {
    return;
  }
  for (const corpusHit of scanSecretCorpus(value)) {
    hits.push({ id: corpusHit.id, path, token: value.slice(corpusHit.index, corpusHit.index + 16) });
  }
}

/** 递归走查(JSON-able 结构;循环引用防护由调用方输入为纯数据保证)。 */
function walk(value: unknown, key: string | null, path: string, depth: number, hits: CrossDomainHit[]): void {
  if (depth > 64) {
    return; // 结构护栏上限(D-API-31 同量级;防御性,正常载荷远低于此)
  }
  if (typeof value === "string") {
    scanStringValue(key, value, path, hits);
    return;
  }
  if (Array.isArray(value)) {
    for (let index = 0; index < value.length; index += 1) {
      walk(value[index], key, `${path}/${index}`, depth + 1, hits);
    }
    return;
  }
  if (value !== null && typeof value === "object") {
    const object = value as Record<string, unknown>;
    scanObjectKeys(object, path, hits);
    for (const [childKey, childValue] of Object.entries(object)) {
      walk(childValue, childKey, `${path}/${childKey}`, depth + 1, hits);
    }
  }
}

/**
 * 扫描一个跨域载荷(JSON-able:WSS 出站帧 / HTTP 响应体 / 其数组)。
 * 返回全部命中(零命中 = 合法);每个载荷独立扫描,命中 path 以 `$` 根起算。
 */
export function scanCrossDomainPayload(payload: unknown): CrossDomainHit[] {
  const hits: CrossDomainHit[] = [];
  walk(payload, null, "$", 0, hits);
  return hits;
}

/** 扫描一批载荷(录制集整体;与逐个扫描等价,path 前缀为 `$<index>`)。 */
export function scanCrossDomainPayloads(payloads: readonly unknown[]): CrossDomainHit[] {
  const hits: CrossDomainHit[] = [];
  for (let index = 0; index < payloads.length; index += 1) {
    walk(payloads[index], null, `$${index}`, 0, hits);
  }
  return hits;
}

/** 机检报告行(CI / 测试输出携带上游条目 ID;映射文档 §九扫描器纪律)。 */
export function formatCrossDomainHits(hits: readonly CrossDomainHit[]): string[] {
  return hits.map((hit) => `[${hit.id}] ${hit.path}: ${hit.token}`);
}
