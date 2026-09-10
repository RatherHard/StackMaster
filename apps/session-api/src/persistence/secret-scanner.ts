/**
 * 秘密语料扫描器(WP-3 测试锚点;ZR-B4 / B5 / B6 的存储面落点)。
 *
 * 定位(权威 API 语义规约 D-API-26):
 *  - 快照 blob:落库必须密文——机检断言"明文语料(seed / flag 样式)扫描
 *    零命中",红灯反例(故意存明文)证明扫描器可检出;
 *  - 动作日志:玩家提交可见面 BOUNDARY,本身不加密、但必须零秘密——
 *    机检断言为测试锚点。注意**不作为运行时硬闸**:玩家 write_bytes 合法
 *    回显(含把 flag 写进可见缓冲区的成功路径)会使任何语料模式在运行期
 *    产生真阳性,I-9 / ZR-P8 的"玩家回显"是 sanctioned 通道;运行期防线
 *    是"拒绝不入账 + 投影白名单",本扫描器服务的是静止存储面的机检。
 *  - 私有包与 seed 永不落任何明文列:其合法落点只有加密快照与对象存储
 *    私有桶(哈希列存摘要,不存内容)。
 */

/** 语料命中(条目 ID 携带上游清单编号,映射文档 §三)。 */
export interface SecretCorpusHit {
  readonly id: "ZR-B1-flag-corpus" | "ZR-B6-seed-corpus";
  readonly index: number;
}

/** 语料模式(合成测试语料样式;真实题目内容永不入 git)。 */
export const SECRET_CORPUS_PATTERNS: readonly { id: SecretCorpusHit["id"]; pattern: RegExp }[] = [
  // 隐藏 flag 样式(FLAG{…});gi 保证大小写变体可检出。
  { id: "ZR-B1-flag-corpus", pattern: /FLAG\{[^}\n]{1,256}\}/gi },
  // 会话种子样式:D-F9 形态 ^([0-9a-fA-F]{2}){8,32}$(16~64 字节 hex)。
  // 机检对象是"快照明文是否泄漏种子",非动作日志的玩家字节回显面。
  { id: "ZR-B6-seed-corpus", pattern: /\b[0-9a-f]{32,128}\b/gi },
];

/**
 * 扫描字符串或字节 blob(utf-8 解码后匹配)中的秘密语料。
 * 零命中 = 合法;命中列表供红灯反例与机检报告使用。
 */
export function scanSecretCorpus(input: string | Uint8Array): SecretCorpusHit[] {
  const text = typeof input === "string" ? input : Buffer.from(input).toString("utf8");
  const hits: SecretCorpusHit[] = [];
  for (const { id, pattern } of SECRET_CORPUS_PATTERNS) {
    const re = new RegExp(pattern.source, pattern.flags);
    let match: RegExpExecArray | null;
    while ((match = re.exec(text)) !== null) {
      hits.push({ id, index: match.index });
      if (match.index === re.lastIndex) {
        re.lastIndex += 1; // 零宽匹配保护
      }
    }
  }
  return hits.sort((a, b) => a.index - b.index);
}
