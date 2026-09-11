/**
 * 版本协商(嵌入协议 §三语义面,max-wins)。
 *
 * 宿主取 hello.supportedVersions 与宿主支持版本集交集的**最大值**;候选集
 * 顺序与重复不影响结论。交集为空 → 返回 null(调用方走 §4.3 失败路径:
 * 不回 ready、标记 embed 会话不可用)。
 *
 * 纯函数,供 WP-52 插件侧复用(Q4 定案:V 规则与协商语义单实现双侧消费,
 * 避免宿主 / 插件两处漂移)。
 */
export function negotiateEmbedProtocolVersion(
  hostSupported: readonly number[],
  helloSupported: readonly number[],
): number | null {
  let negotiated: number | null = null;
  for (const version of helloSupported) {
    if (!hostSupported.includes(version)) continue;
    if (negotiated === null || version > negotiated) {
      negotiated = version;
    }
  }
  return negotiated;
}
