/**
 * 寄存器 × 区域交叉标注(WP-F4 / FE-RG-04)——纯函数 + Lit 渲染辅助。
 *
 * 口径(公开视图档,窗口内部分):寄存器值(视为地址)命中某可见区域的
 * **已下发窗口**(D3 前缀 `windowByteLength`)时产出"值命中行"集合,供字节
 * 视图(F5 集成)做行左缘标注与点击展开;值落在区域范围但超出已下发前缀、
 * 或未映射 → 标注缺席且不报错。全量标注(任意行)归 WP-F8 调试档。
 *
 * 白名单纪律(M14):FLAG 等白名单外寄存器由服务端结构性排除,前端只消费
 * `registers()` 全量输出、不留占位;本模块不做任何白名单推断。
 *
 * 本模块与 views/chain/resolve.ts 平行(两视图互不依赖,共享面在 render/),
 * "值 ∈ 窗口"的成员判定在此处就地实现(与 render/hex 解析原语复用)。
 */
import { html, nothing, type TemplateResult } from "lit";
import type { RegisterRow, VmaEntry, VmaList } from "../../datasource/types.js";
import { t } from "../../i18n/i18n.js";
import { addressToHex, normalizeValueHex, parseAddressHex } from "../../render/hex.js";

/** 寄存器值命中行(字节视图行左缘标注与点击展开的数据依据)。 */
export interface RegisterHit {
  /** 寄存器名(白名单寄存器展示名)。 */
  readonly registerName: string;
  /** 寄存器值(恒 `0x` + 大写,契约归一化形态)。 */
  readonly valueHex: string;
  /** 命中地址(恒 `0x` + 小写;即字节视图中被标注行的行内地址)。 */
  readonly targetAddressHex: string;
  /** 命中区域 id。 */
  readonly regionId: string;
  /** 区域内字节偏移(0 起)。 */
  readonly offset: number;
}

/**
 * 计算寄存器 × 区域交叉标注命中行集合:
 *  - 逐寄存器判定值是否落在某可见区域的已下发窗口
 *    (`[startAddressHex, startAddressHex + windowByteLength)`);命中多个
 *    区域时取投影顺序的首个区域(区域不重叠为投影不变量);
 *  - 输出顺序与输入寄存器顺序一致(多寄存器同区域全部产出);
 *  - 无命中(未映射 / 窗口外)→ 该寄存器不产出条目(缺席,不报错)。
 */
export function crossAnnotateRegisters(
  registers: readonly RegisterRow[],
  regions: VmaList,
): RegisterHit[] {
  const hits: RegisterHit[] = [];
  for (const register of registers) {
    const value = parseAddressHex(register.valueHex);
    const region = findOwningWindowRegion(value, regions);
    if (region === null) {
      continue;
    }
    hits.push({
      registerName: register.name,
      valueHex: normalizeValueHex(register.valueHex),
      targetAddressHex: addressToHex(value),
      regionId: region.regionId,
      offset: Number(value - parseAddressHex(region.startAddressHex)),
    });
  }
  return hits;
}

/** 值 → 所属可见区域的已下发窗口(前缀 `windowByteLength`)内区域;无则 null。 */
function findOwningWindowRegion(value: bigint, regions: VmaList): VmaEntry | null {
  for (const region of regions) {
    const base = parseAddressHex(region.startAddressHex);
    if (value >= base && value < base + BigInt(region.windowByteLength)) {
      return region;
    }
  }
  return null;
}

/**
 * Lit 渲染辅助:字节视图行左缘标注单元格(FE-RG-04)。
 *  - 有命中 → 寄存器名按钮(`data-registers` 逗号分隔;title / aria-label
 *    携带"名=值"详情);**点击展开寄存器值的行为由宿主(F5)接线**——本辅助
 *    只产出语义化展示面,不直接改 sm-byte-view;
 *  - 无命中 → `nothing`(不渲染,标注缺席)。
 */
export function renderRegisterAnnotationCell(
  hits: readonly RegisterHit[],
): TemplateResult | typeof nothing {
  if (hits.length === 0) {
    return nothing;
  }
  const names = hits.map((hit) => hit.registerName).join(",");
  const detail = hits.map((hit) => `${hit.registerName}=${hit.valueHex}`).join(" ");
  return html`<button
    type="button"
    class="reg-annotation"
    data-registers="${names}"
    title="${detail}"
    aria-label=${t("annot.aria", { detail })}
  >${names}</button>`;
}
