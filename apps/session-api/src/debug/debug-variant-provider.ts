/**
 * DebugVariantProvider —— 调试变体镜像供给端口(阶段四 WP-41;ADR-DC1
 * 条款 2 / §六 R2、WP-40 契约 §七.3 对接注意事项)。
 *
 * 编排器在 debug_attach 时经本端口取得会话锁定的题目身份三元组对应的
 * **调试变体镜像**(WP-40 `DebugVariantBundle` 契约形态;布局与真实镜像
 * 同构、秘密值由调试种子派生、真实私有判题包零装载)。编排器取得变体后:
 *  - 与会话锁定身份做三元组比对(challengeId / challengeContentVersion,
 *    vmProfileVersion 由公开描述包同源承载);
 *  - 过冻结 Schema 复验(拒绝即 attach 失败,变体不出编排器进程之外);
 *  - 经 `load_variant` 命令送调试 worker(worker 侧二次校验,fail-closed)。
 *
 * 交付形态(本 WP):
 *  - [`placeholderDebugVariantProvider`]:程序化测试实现——从公开描述包
 *    (整体 PUBLIC)按 challenge-schema 测试助手风格构造**占位语料变体**
 *    (隐藏区域内容为固定占位字节,非真实秘密);用于集成测试与本地联调;
 *  - [`productionDebugVariantProvider`]:生产实现桩——WP-42 落地
 *    challenge-compiler 变体产出后由后续波次接线,当前调用即抛错
 *    (attach 呈现 internal_error 错误帧,接口与挂接点已就位)。
 *
 * 变体镜像与调试种子是会话级瞬态值:**不落任何存储、不进日志**(秘密零
 * 驻留;`derivation` 只登记算法标识与派生次数,无种子值字段)。
 */
import { DEBUG_VARIANT_SEED_ALGORITHM_ID, DEBUG_VARIANT_BUNDLE_SCHEMA_VERSION, DebugVariantBundleSchema } from "@stackmaster/protocol/server-only";
import { ENGINE_PROCESS_PROTOCOL_VERSION } from "@stackmaster/protocol";

/** 既有公私区域页对齐粒度(公开包区域长度同源;VMA 页对齐)。 */
const REGION_BYTE_LENGTH = 4096;

/** 变体供给请求(身份三元组取自会话锁定面;编排器派生)。 */
export interface DebugVariantRequest {
  readonly sessionId: string;
  readonly tenantId: string;
  readonly challengeId: string;
  readonly challengeContentVersion: string;
}

/**
 * 变体供给端口。返回值为 WP-40 `DebugVariantBundle` 契约的 JSON 形态
 * (结构由消费方经冻结 Schema 复验;本端口不引入新类型面)。
 */
export interface DebugVariantProvider {
  forSession(request: DebugVariantRequest): Promise<Record<string, unknown>>;
}

/**
 * 生产实现桩(WP-42 接线前形态):调用即抛错——生产 attach 上的呈现由
 * 编排器映射为冻结 internal_error 错误帧,零内部细节透出。
 */
export function productionDebugVariantProvider(): DebugVariantProvider {
  return {
    async forSession(): Promise<Record<string, unknown>> {
      throw new Error("WP-42 接线:生产调试变体镜像产出(challenge-compiler)未接入");
    },
  };
}

/** 占位语料隐藏区域内容(固定字节,非真实秘密;零装载演示面)。 */
const PLACEHOLDER_HIDDEN_CONTENT_PREFIX = "d3adb33fc0ffee010203040506070809";

/** 占位变体装配所需公开描述包的最小读取面(仅公开字段)。 */
interface PublicDescriptorView {
  readonly challengeId: string;
  readonly challengeContentVersion: string;
  readonly vmProfileVersion: string;
  readonly memoryLayout: {
    readonly regions: readonly {
      readonly regionId: string;
      readonly kind: string;
      readonly startAddressHex: string;
      readonly byteLength: number;
      readonly permissions: string;
    }[];
  };
  readonly vmProfile: {
    readonly flagRegisterNames?: readonly string[];
  };
  readonly initialProjection: {
    readonly visibleRegions: readonly {
      readonly regionId: string;
      readonly bytesHex: string;
    }[];
    readonly visibleRegisters: readonly {
      readonly name: string;
      readonly valueHex: string;
    }[];
  };
}

function zeroHexBytes(byteCount: number): string {
  return "00".repeat(Math.max(0, byteCount));
}

/**
 * 程序化测试实现:从公开描述包构造占位语料变体(公开性由零装载在构造上
 * 保证——输入只有公开面数据 + 固定占位字节)。
 *
 * - 可见区域:公开 memoryLayout 逐区域镜像(内容 = 初始投影前缀 + 零填充);
 * - 隐藏区域:合成一个固定占位的 `debug-vault`(零装载使隐藏区域在调试
 *   实例公开,ADR-DC1 条款 2 的教学承载面);
 * - 寄存器:初始投影可见寄存器镜像(RIP 即初始指令指针);
 * - ASLR 关(基址与真实镜像一致;开启形态归 WP-42 基址派生应用面)。
 */
export function placeholderDebugVariantProvider(deps: {
  /** 公开描述包读取(与生产装配同一对象存储端口;整体 PUBLIC)。 */
  getPublic(challengeId: string, version: string): Promise<Uint8Array | null>;
}): DebugVariantProvider {
  return {
    async forSession(request): Promise<Record<string, unknown>> {
      const raw = await deps.getPublic(request.challengeId, request.challengeContentVersion);
      if (raw === null) {
        throw new Error(`placeholder variant: public descriptor missing (${request.challengeId})`);
      }
      const descriptor = JSON.parse(Buffer.from(raw).toString("utf8")) as PublicDescriptorView;

      const prefixByRegion = new Map(
        descriptor.initialProjection.visibleRegions.map((region) => [region.regionId, region.bytesHex]),
      );
      const memoryRegions = descriptor.memoryLayout.regions.map((region) => {
        const prefix = prefixByRegion.get(region.regionId) ?? "";
        return {
          regionId: region.regionId,
          kind: region.kind,
          startAddressHex: region.startAddressHex,
          byteLength: region.byteLength,
          permissions: region.permissions,
          contentHex: prefix + zeroHexBytes(region.byteLength - prefix.length / 2),
          isHidden: false,
        };
      });
      // 合成隐藏区域(占位语料;结构与其余区域同构)。
      const vaultStart = `0x${(
        BigInt(
          descriptor.memoryLayout.regions[descriptor.memoryLayout.regions.length - 1]
            ?.startAddressHex ?? "0x0",
        ) + BigInt(REGION_BYTE_LENGTH)
      ).toString(16)}`;
      memoryRegions.push({
        regionId: "debug-vault",
        kind: "key",
        startAddressHex: vaultStart,
        byteLength: REGION_BYTE_LENGTH,
        permissions: "rw",
        contentHex:
          PLACEHOLDER_HIDDEN_CONTENT_PREFIX + zeroHexBytes(REGION_BYTE_LENGTH - PLACEHOLDER_HIDDEN_CONTENT_PREFIX.length / 2),
        isHidden: true,
      });

      const registers = descriptor.initialProjection.visibleRegisters.map((register) => ({
        name: register.name,
        valueHex: register.valueHex,
      }));

      const variant = {
        schemaVersion: DEBUG_VARIANT_BUNDLE_SCHEMA_VERSION,
        engineProcessProtocolVersion: ENGINE_PROCESS_PROTOCOL_VERSION,
        challengeId: descriptor.challengeId,
        challengeContentVersion: descriptor.challengeContentVersion,
        vmProfileVersion: descriptor.vmProfileVersion,
        aslrEnabled: false,
        derivation: { algorithmId: DEBUG_VARIANT_SEED_ALGORITHM_ID, draws: 0 },
        memoryRegions,
        registers,
      };
      // 出口即过冻结 Schema(契约形态在装配点自证;拒绝 = 实现缺陷)。
      return DebugVariantBundleSchema.parse(variant);
    },
  };
}
