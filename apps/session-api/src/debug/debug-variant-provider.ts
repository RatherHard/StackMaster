/**
 * DebugVariantProvider —— 调试变体镜像供给端口(阶段四 WP-41 / WP-42;ADR-DC1
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
 * 交付形态:
 *  - [`productionDebugVariantProvider`]:**生产实现(WP-42 接线)**——对象存储
 *    取双包 → challenge-compiler `loadChallengePair` 装载管线(三层全绿才产
 *    变体;装载产物含私有包完整状态,只在编排器进程内存活)→
 *    `buildDebugVariantBundle`(布局同构、秘密槽值由调试种子经 SeedDeriver
 *    `splitmix64-stream-v1` 派生)→ 出口即过 WP-40 冻结 Schema;ASLR 开关取
 *    公开描述包 `aslrEnabled`(WP-43 声明面,缺省 false);
 *  - [`placeholderDebugVariantProvider`]:程序化测试实现——从公开描述包
 *    (整体 PUBLIC)构造**占位语料变体**(隐藏区域内容为固定占位字节,非
 *    真实秘密);用于无 challenge-compiler 装载依赖的轻量集成测试与本地联调。
 *
 * 调试种子来源纪律(秘密零驻留):每次供给(= 一次 attach 装载,attach 幂等
 * 复用既有实例故不重复供给)以 `node:crypto` 随机生成 **16 字节**调试种子,
 * 仅在调试编排器内存存活、不落任何存储、不进日志(受控日志只记 sessionId /
 * revision 等标识面;审计 kind 七值集合不扩)。`derivation` 只登记算法标识与
 * 派生次数,无种子值字段。
 */
import { randomBytes } from "node:crypto";
import type { Logger } from "pino";
import {
  buildDebugVariantBundle,
  loadChallengePair,
  type DebugVariantBuildOptions,
} from "@stackmaster/challenge-compiler";
import { ENGINE_PROCESS_PROTOCOL_VERSION } from "@stackmaster/protocol";
import {
  DEBUG_VARIANT_BUNDLE_SCHEMA_VERSION,
  DEBUG_VARIANT_SEED_ALGORITHM_ID,
  DebugVariantBundleSchema,
} from "@stackmaster/protocol/server-only";
import type { ChallengeBundleStore } from "../persistence/ports.js";

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

/** 生产实现依赖(双包对象存储读取 + 调试种子生成注入面)。 */
export interface ProductionDebugVariantProviderDeps {
  /** 题目双包对象存储(与 create-session 同一端口;私有包不离开编排器进程)。 */
  readonly bundles: Pick<ChallengeBundleStore, "getPrivate" | "getPublic">;
  /** 受控日志(只记身份面;双包内容与调试种子零入日志)。 */
  readonly logger?: Logger;
  /**
   * 调试种子生成(注入面;缺省 = `node:crypto` 随机 16 字节 hex)。生产路径
   * 不注入;集成测试注入固定种子做双实例重放一致性比对(种子值仍不落盘)。
   */
  readonly generateDebugSeedHex?: () => string;
}

/**
 * 生产实现(WP-42):双包 → 装载管线 → 变体产出 → 出口过冻结 Schema。
 * 装载/产出失败(版本缺失、双包缺失、管线拒绝、变体拒绝)全部抛错——呈现面
 * 由编排器映射为冻结 internal_error 错误帧,零内部细节透出。
 */
export function productionDebugVariantProvider(deps: ProductionDebugVariantProviderDeps): DebugVariantProvider {
  const log = deps.logger?.child({ component: "debug-variant-provider" });
  return {
    async forSession(request): Promise<Record<string, unknown>> {
      const privateRaw = await deps.bundles.getPrivate(request.challengeId, request.challengeContentVersion);
      const publicRaw = await deps.bundles.getPublic(request.challengeId, request.challengeContentVersion);
      if (privateRaw === null || publicRaw === null) {
        throw new Error(
          `debug variant: challenge bundle missing (${request.challengeId}@${request.challengeContentVersion})`,
        );
      }
      let publicDescriptor: unknown;
      let privateBundle: unknown;
      try {
        publicDescriptor = JSON.parse(Buffer.from(publicRaw).toString("utf8"));
        privateBundle = JSON.parse(Buffer.from(privateRaw).toString("utf8"));
      } catch (error) {
        throw new Error(`debug variant: challenge bundle is not valid JSON (${request.challengeId})`, { cause: error });
      }

      // 装载管线(Schema → 检查器 → 编译期校验):拒绝即拒绝,不产部分变体。
      const loaded = loadChallengePair({ publicDescriptor, privateBundle });
      if (!loaded.ok) {
        log?.warn(
          {
            challengeId: request.challengeId,
            challengeVersion: request.challengeContentVersion,
            violationRuleIds: loaded.violations.map((item) => item.ruleId),
          },
          "debug variant rejected by compiler load pipeline",
        );
        throw new Error(
          `debug variant: challenge load rejected for ${request.challengeId} (${loaded.violations.length} violations)`,
        );
      }

      // ASLR 开关(WP-43 公开描述包声明面镜像;缺省 false = 固定基址)。
      const aslrEnabled = readAslrEnabled(publicDescriptor);
      // 调试种子:每次供给现场生成(缺省随机 16 字节);不落存储不入日志。
      const debugSeedHex = deps.generateDebugSeedHex?.() ?? randomBytes(16).toString("hex");
      const options: DebugVariantBuildOptions = { debugSeedHex, aslrEnabled };
      // 出口即过冻结 Schema(契约形态在装配点自证;拒绝 = 实现缺陷)。
      return DebugVariantBundleSchema.parse(buildDebugVariantBundle(loaded.challenge, options));
    },
  };
}

/** 公开描述包 aslrEnabled 读取(最小豁免面;缺省 false,与 WP-43 缺省语义一致)。 */
function readAslrEnabled(publicDescriptor: unknown): boolean {
  const declared = (publicDescriptor as { aslrEnabled?: unknown } | undefined)?.aslrEnabled;
  return declared === true;
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
