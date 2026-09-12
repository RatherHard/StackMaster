# k6 基线首采摘要(阶段三 WP-8,质量门禁 9)

- 被测地址:http://host.docker.internal:13000(形态与时间戳见同目录 JSON;D-API-73)
- 采集时间:2026-09-12T13:03:08.892Z
- 阈值:**不设通过阈值**(10.3 / 13.6——数据作为 T2 触发判据基线,避免过早优化)
- 环境:本机 Docker + compose 拓扑(容器形态;见 apps/session-api/README.md 的拓扑说明)

| 场景 | 关键指标 | 数值 |
|---|---|---|
| action-rtt-wss | wss_action_rtt_ms | avg 3.25 / med 3 / p(90) 4 / p(95) 5 / max 11 |
| action-rtt-wss | wss_actions_confirmed | count 896 |
| action-rtt-wss | sessions_created | count 112 |
| action-rtt-wss | http_req_duration | avg 19.619 / med 9.277 / p(90) 42.219 / p(95) 44.253 / max 226.782 |
| rest-lifecycle | lifecycle_cycle_ms | avg 61.509 / med 61 / p(90) 66 / p(95) 67.55 / max 87 |
| rest-lifecycle | lifecycle_cycles_completed | count 230 |
| rest-lifecycle | http_req_duration | avg 10.159 / med 3.869 / p(90) 38.582 / p(95) 40.833 / max 46.779 |
| concurrent-sessions | server_live_sessions | avg 19.75 / med 21 / p(90) 21 / p(95) 21 / max 21 |
| concurrent-sessions | held_sessions | count 12 |
| concurrent-sessions | http_req_duration | avg 15.268 / med 7.034 / p(90) 37.927 / p(95) 39.376 / max 43.671 |

## 采集前 /metrics 快照(指标面最小集;D-API-70)

```text
# HELP session_api_action_rtt_seconds 动作往返时长(manager.applyAction 入口到响应/异常;秒)
# TYPE session_api_action_rtt_seconds histogram

# HELP session_api_live_sessions 并发会话数(在途会话管理器持有量)
# TYPE session_api_live_sessions gauge
session_api_live_sessions 15

# HELP session_api_action_queue_depth 编排器动作队列深度(manager 在途动作调用数;单会话串行上限为逐会话 1)
# TYPE session_api_action_queue_depth gauge
session_api_action_queue_depth 0

# HELP session_api_worker_processes Worker 池占用(本编排器进程持有的 vm-worker 子进程数;T0 = 每在途会话 1)
# TYPE session_api_worker_processes gauge
session_api_worker_processes 15

# HELP session_api_projection_delta_bytes 投影增量字节数(已接受动作的 ProjectionDelta 序列化字节)
# TYPE session_api_projection_delta_bytes histogram

# HELP session_api_debug_worker_processes 调试 worker 占用(本编排器进程持有的调试实例子进程数;按需 +1,WP-41)
# TYPE session_api_debug_worker_processes gauge
session_api_debug_worker_processes 0

# HELP session_api_debug_frames_total 调试通道帧计数(按帧类型与结果;类型取 5 值请求帧 + other 兜底,WP-41)
# TYPE session_api_debug_frames_total counter

# HELP session_api_debug_budget_rejections_total 调试帧被每会话动作预算拒绝计数(与解题共用同一预算的挤占观察,ADR-DC1 条款 6)
# TYPE session_api_debug_budget_rejections_total counter
session_api_debug_budget_rejections_total 0

# HELP session_api_audit_archive_batches_total 审计归档批计数(outcome ∈ {completed, failed};idle 稳态不计数;运维事件账,D-API-92)
# TYPE session_api_audit_archive_batches_total counter
```

## 采集后 /metrics 快照

```text
# HELP session_api_action_rtt_seconds 动作往返时长(manager.applyAction 入口到响应/异常;秒)
# TYPE session_api_action_rtt_seconds histogram
session_api_action_rtt_seconds_bucket{le="0.001",action="write_bytes",outcome="accepted"} 595
session_api_action_rtt_seconds_bucket{le="0.0025",action="write_bytes",outcome="accepted"} 1000
session_api_action_rtt_seconds_bucket{le="0.005",action="write_bytes",outcome="accepted"} 1002
session_api_action_rtt_seconds_bucket{le="0.01",action="write_bytes",outcome="accepted"} 1002
session_api_action_rtt_seconds_bucket{le="0.025",action="write_bytes",outcome="accepted"} 1002
session_api_action_rtt_seconds_bucket{le="0.05",action="write_bytes",outcome="accepted"} 1002
session_api_action_rtt_seconds_bucket{le="0.1",action="write_bytes",outcome="accepted"} 1002
session_api_action_rtt_seconds_bucket{le="0.25",action="write_bytes",outcome="accepted"} 1002
session_api_action_rtt_seconds_bucket{le="0.5",action="write_bytes",outcome="accepted"} 1002
session_api_action_rtt_seconds_bucket{le="1",action="write_bytes",outcome="accepted"} 1002
session_api_action_rtt_seconds_bucket{le="2.5",action="write_bytes",outcome="accepted"} 1002
session_api_action_rtt_seconds_bucket{le="5",action="write_bytes",outcome="accepted"} 1002
session_api_action_rtt_seconds_bucket{le="10",action="write_bytes",outcome="accepted"} 1002
session_api_action_rtt_seconds_bucket{le="+Inf",action="write_bytes",outcome="accepted"} 1002
session_api_action_rtt_seconds_sum{action="write_bytes",outcome="accepted"} 0.9924603999998399
session_api_action_rtt_seconds_count{action="write_bytes",outcome="accepted"} 1002

# HELP session_api_live_sessions 并发会话数(在途会话管理器持有量)
# TYPE session_api_live_sessions gauge
session_api_live_sessions 17

# HELP session_api_action_queue_depth 编排器动作队列深度(manager 在途动作调用数;单会话串行上限为逐会话 1)
# TYPE session_api_action_queue_depth gauge
session_api_action_queue_depth 0

# HELP session_api_worker_processes Worker 池占用(本编排器进程持有的 vm-worker 子进程数;T0 = 每在途会话 1)
# TYPE session_api_worker_processes gauge
session_api_worker_processes 17

# HELP session_api_projection_delta_bytes 投影增量字节数(已接受动作的 ProjectionDelta 序列化字节)
# TYPE session_api_projection_delta_bytes histogram
session_api_projection_delta_bytes_bucket{le="128",action="write_bytes"} 1002
session_api_projection_delta_bytes_bucket{le="256",action="write_bytes"} 1002
session_api_projection_delta_bytes_bucket{le="512",action="write_bytes"} 1002
session_api_projection_delta_bytes_bucket{le="1024",action="write_bytes"} 1002
session_api_projection_delta_bytes_bucket{le="2048",action="write_bytes"} 1002
session_api_projection_delta_bytes_bucket{le="4096",action="write_bytes"} 1002
session_api_projection_delta_bytes_bucket{le="8192",action="write_bytes"} 1002
session_api_projection_delta_bytes_bucket{le="16384",action="write_bytes"} 1002
session_api_projection_delta_bytes_bucket{le="32768",action="write_bytes"} 1002
session_api_projection_delta_bytes_bucket{le="65536",action="write_bytes"} 1002
session_api_projection_delta_bytes_bucket{le="131072",action="write_bytes"} 1002
session_api_projection_delta_bytes_bucket{le="262144",action="write_bytes"} 1002
session_api_projection_delta_bytes_bucket{le="524288",action="write_bytes"} 1002
session_api_projection_delta_bytes_bucket{le="1048576",action="write_bytes"} 1002
session_api_projection_delta_bytes_bucket{le="+Inf",action="write_bytes"} 1002
session_api_projection_delta_bytes_sum{action="write_bytes"} 122244
session_api_projection_delta_bytes_count{action="write_bytes"} 1002

# HELP session_api_debug_worker_processes 调试 worker 占用(本编排器进程持有的调试实例子进程数;按需 +1,WP-41)
# TYPE session_api_debug_worker_processes gauge
session_api_debug_worker_processes 0

# HELP session_api_debug_frames_total 调试通道帧计数(按帧类型与结果;类型取 5 值请求帧 + other 兜底,WP-41)
# TYPE session_api_debug_frames_total counter

# HELP session_api_debug_budget_rejections_total 调试帧被每会话动作预算拒绝计数(与解题共用同一预算的挤占观察,ADR-DC1 条款 6)
# TYPE session_api_debug_budget_rejections_total counter
session_api_debug_budget_rejections_total 0

# HELP session_api_audit_archive_batches_total 审计归档批计数(outcome ∈ {completed, failed};idle 稳态不计数;运维事件账,D-API-92)
# TYPE session_api_audit_archive_batches_total counter
```

## 纪律注记

- 本基线在本机 dev 拓扑采集,数字不构成性能承诺(10.3:目标值待真实网络 / 设备 benchmark 后确定);
- 会话 ID、租户、用户等标识符不出现在指标输出(标签纪律,D-API-71;/metrics 快照可作为附件复核);
- 原始 summary JSON 与 /metrics 快照逐场景归档于本目录。
## WP-65 复核注记(2026-09-12,拓扑形态更正)

- 本轮实跑形态 = **host 混合拓扑**(deps.yaml 依赖服务容器 + session-api 宿主进程 + 本机 vm-worker release;D-API-65 host 降级形态),非上文自动生成的"容器形态"标注;
- 采集目的 = 阶段六 WP-65 连接层租户上下文注入 + PG RLS 全表域启用的前后对比(D-API-102"RLS 性能成本"风险行回填):本目录与配对轮次(`2026-09-12T130117550Z` = 注入前 HEAD / `2026-09-12T134452996Z` = 注入 + RLS)同拓扑同库双采;
- 容器拓扑基线首采 = `2026-09-09T223628898Z`(D-API-73),与本轮 host 形态数字不可直接互比(进程形态不同),前后对比仅在本目录两轮间进行;
- `server_live_sessions` 采样高于场景 VU 峰值 = 同轮早前场景在途会话在采样窗内尚未回收的观测形态(运行结束零 active 残留),前 / 后两轮一致,非回归信号(D-API-102 观测注记)。
