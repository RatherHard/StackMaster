# k6 基线首采摘要(阶段三 WP-8,质量门禁 9)

- 被测地址:http://host.docker.internal:13000(形态与时间戳见同目录 JSON;D-API-73)
- 采集时间:2026-09-09T22:38:19.507Z
- 阈值:**不设通过阈值**(10.3 / 13.6——数据作为 T2 触发判据基线,避免过早优化)
- 环境:本机 Docker + compose 拓扑(容器形态;见 apps/session-api/README.md 的拓扑说明)

| 场景 | 关键指标 | 数值 |
|---|---|---|
| action-rtt-wss | wss_action_rtt_ms | avg 6.336 / med 6 / p(90) 7 / p(95) 10 / max 16 |
| action-rtt-wss | wss_actions_confirmed | count 848 |
| action-rtt-wss | sessions_created | count 106 |
| action-rtt-wss | http_req_duration | avg 20.268 / med 6.898 / p(90) 50.099 / p(95) 52.652 / max 77.654 |
| rest-lifecycle | lifecycle_cycle_ms | avg 62.789 / med 61 / p(90) 68 / p(95) 69.65 / max 96 |
| rest-lifecycle | lifecycle_cycles_completed | count 228 |
| rest-lifecycle | http_req_duration | avg 10.384 / med 2.233 / p(90) 48.567 / p(95) 50.334 / max 79.964 |
| concurrent-sessions | server_live_sessions | avg 5.083 / med 6 / p(90) 6 / p(95) 6 / max 6 |
| concurrent-sessions | held_sessions | count 12 |
| concurrent-sessions | http_req_duration | avg 16.889 / med 3.278 / p(90) 47.861 / p(95) 48.965 / max 70.996 |

## 采集前 /metrics 快照(指标面最小集;D-API-70)

```text
# HELP session_api_action_rtt_seconds 动作往返时长(manager.applyAction 入口到响应/异常;秒)
# TYPE session_api_action_rtt_seconds histogram
session_api_action_rtt_seconds_bucket{le="0.001",action="write_bytes",outcome="accepted"} 0
session_api_action_rtt_seconds_bucket{le="0.0025",action="write_bytes",outcome="accepted"} 0
session_api_action_rtt_seconds_bucket{le="0.005",action="write_bytes",outcome="accepted"} 104
session_api_action_rtt_seconds_bucket{le="0.01",action="write_bytes",outcome="accepted"} 106
session_api_action_rtt_seconds_bucket{le="0.025",action="write_bytes",outcome="accepted"} 106
session_api_action_rtt_seconds_bucket{le="0.05",action="write_bytes",outcome="accepted"} 106
session_api_action_rtt_seconds_bucket{le="0.1",action="write_bytes",outcome="accepted"} 106
session_api_action_rtt_seconds_bucket{le="0.25",action="write_bytes",outcome="accepted"} 106
session_api_action_rtt_seconds_bucket{le="0.5",action="write_bytes",outcome="accepted"} 106
session_api_action_rtt_seconds_bucket{le="1",action="write_bytes",outcome="accepted"} 106
session_api_action_rtt_seconds_bucket{le="2.5",action="write_bytes",outcome="accepted"} 106
session_api_action_rtt_seconds_bucket{le="5",action="write_bytes",outcome="accepted"} 106
session_api_action_rtt_seconds_bucket{le="10",action="write_bytes",outcome="accepted"} 106
session_api_action_rtt_seconds_bucket{le="+Inf",action="write_bytes",outcome="accepted"} 106
session_api_action_rtt_seconds_sum{action="write_bytes",outcome="accepted"} 0.46011198099976175
session_api_action_rtt_seconds_count{action="write_bytes",outcome="accepted"} 106

# HELP session_api_live_sessions 并发会话数(在途会话管理器持有量)
# TYPE session_api_live_sessions gauge
session_api_live_sessions 2

# HELP session_api_action_queue_depth 编排器动作队列深度(manager 在途动作调用数;单会话串行上限为逐会话 1)
# TYPE session_api_action_queue_depth gauge
session_api_action_queue_depth 0

# HELP session_api_worker_processes Worker 池占用(本编排器进程持有的 vm-worker 子进程数;T0 = 每在途会话 1)
# TYPE session_api_worker_processes gauge
session_api_worker_processes 2

# HELP session_api_projection_delta_bytes 投影增量字节数(已接受动作的 ProjectionDelta 序列化字节)
# TYPE session_api_projection_delta_bytes histogram
session_api_projection_delta_bytes_bucket{le="128",action="write_bytes"} 106
session_api_projection_delta_bytes_bucket{le="256",action="write_bytes"} 106
session_api_projection_delta_bytes_bucket{le="512",action="write_bytes"} 106
session_api_projection_delta_bytes_bucket{le="1024",action="write_bytes"} 106
session_api_projection_delta_bytes_bucket{le="2048",action="write_bytes"} 106
session_api_projection_delta_bytes_bucket{le="4096",action="write_bytes"} 106
session_api_projection_delta_bytes_bucket{le="8192",action="write_bytes"} 106
session_api_projection_delta_bytes_bucket{le="16384",action="write_bytes"} 106
session_api_projection_delta_bytes_bucket{le="32768",action="write_bytes"} 106
session_api_projection_delta_bytes_bucket{le="65536",action="write_bytes"} 106
session_api_projection_delta_bytes_bucket{le="131072",action="write_bytes"} 106
session_api_projection_delta_bytes_bucket{le="262144",action="write_bytes"} 106
session_api_projection_delta_bytes_bucket{le="524288",action="write_bytes"} 106
session_api_projection_delta_bytes_bucket{le="1048576",action="write_bytes"} 106
session_api_projection_delta_bytes_bucket{le="+Inf",action="write_bytes"} 106
session_api_projection_delta_bytes_sum{action="write_bytes"} 12932
session_api_projection_delta_bytes_count{action="write_bytes"} 106
```

## 采集后 /metrics 快照

```text
# HELP session_api_action_rtt_seconds 动作往返时长(manager.applyAction 入口到响应/异常;秒)
# TYPE session_api_action_rtt_seconds histogram
session_api_action_rtt_seconds_bucket{le="0.001",action="write_bytes",outcome="accepted"} 0
session_api_action_rtt_seconds_bucket{le="0.0025",action="write_bytes",outcome="accepted"} 0
session_api_action_rtt_seconds_bucket{le="0.005",action="write_bytes",outcome="accepted"} 996
session_api_action_rtt_seconds_bucket{le="0.01",action="write_bytes",outcome="accepted"} 1059
session_api_action_rtt_seconds_bucket{le="0.025",action="write_bytes",outcome="accepted"} 1060
session_api_action_rtt_seconds_bucket{le="0.05",action="write_bytes",outcome="accepted"} 1060
session_api_action_rtt_seconds_bucket{le="0.1",action="write_bytes",outcome="accepted"} 1060
session_api_action_rtt_seconds_bucket{le="0.25",action="write_bytes",outcome="accepted"} 1060
session_api_action_rtt_seconds_bucket{le="0.5",action="write_bytes",outcome="accepted"} 1060
session_api_action_rtt_seconds_bucket{le="1",action="write_bytes",outcome="accepted"} 1060
session_api_action_rtt_seconds_bucket{le="2.5",action="write_bytes",outcome="accepted"} 1060
session_api_action_rtt_seconds_bucket{le="5",action="write_bytes",outcome="accepted"} 1060
session_api_action_rtt_seconds_bucket{le="10",action="write_bytes",outcome="accepted"} 1060
session_api_action_rtt_seconds_bucket{le="+Inf",action="write_bytes",outcome="accepted"} 1060
session_api_action_rtt_seconds_sum{action="write_bytes",outcome="accepted"} 4.661180647998293
session_api_action_rtt_seconds_count{action="write_bytes",outcome="accepted"} 1060

# HELP session_api_live_sessions 并发会话数(在途会话管理器持有量)
# TYPE session_api_live_sessions gauge
session_api_live_sessions 2

# HELP session_api_action_queue_depth 编排器动作队列深度(manager 在途动作调用数;单会话串行上限为逐会话 1)
# TYPE session_api_action_queue_depth gauge
session_api_action_queue_depth 0

# HELP session_api_worker_processes Worker 池占用(本编排器进程持有的 vm-worker 子进程数;T0 = 每在途会话 1)
# TYPE session_api_worker_processes gauge
session_api_worker_processes 2

# HELP session_api_projection_delta_bytes 投影增量字节数(已接受动作的 ProjectionDelta 序列化字节)
# TYPE session_api_projection_delta_bytes histogram
session_api_projection_delta_bytes_bucket{le="128",action="write_bytes"} 1060
session_api_projection_delta_bytes_bucket{le="256",action="write_bytes"} 1060
session_api_projection_delta_bytes_bucket{le="512",action="write_bytes"} 1060
session_api_projection_delta_bytes_bucket{le="1024",action="write_bytes"} 1060
session_api_projection_delta_bytes_bucket{le="2048",action="write_bytes"} 1060
session_api_projection_delta_bytes_bucket{le="4096",action="write_bytes"} 1060
session_api_projection_delta_bytes_bucket{le="8192",action="write_bytes"} 1060
session_api_projection_delta_bytes_bucket{le="16384",action="write_bytes"} 1060
session_api_projection_delta_bytes_bucket{le="32768",action="write_bytes"} 1060
session_api_projection_delta_bytes_bucket{le="65536",action="write_bytes"} 1060
session_api_projection_delta_bytes_bucket{le="131072",action="write_bytes"} 1060
session_api_projection_delta_bytes_bucket{le="262144",action="write_bytes"} 1060
session_api_projection_delta_bytes_bucket{le="524288",action="write_bytes"} 1060
session_api_projection_delta_bytes_bucket{le="1048576",action="write_bytes"} 1060
session_api_projection_delta_bytes_bucket{le="+Inf",action="write_bytes"} 1060
session_api_projection_delta_bytes_sum{action="write_bytes"} 129320
session_api_projection_delta_bytes_count{action="write_bytes"} 1060
```

## 纪律注记

- 本基线在本机 dev 拓扑采集,数字不构成性能承诺(10.3:目标值待真实网络 / 设备 benchmark 后确定);
- 会话 ID、租户、用户等标识符不出现在指标输出(标签纪律,D-API-71;/metrics 快照可作为附件复核);
- 原始 summary JSON 与 /metrics 快照逐场景归档于本目录。