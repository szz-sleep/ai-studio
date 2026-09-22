# H3 长视频时间线 API（草案 v1）

此文档定义 AI Studio、MaaS 网关和 Python GPU Worker 之间的边界。当前阶段不要求服务器已部署。

## 架构边界

- AI Studio：编辑、校验并提交时间线计划；轮询任务状态；显示分段进度。
- MaaS：鉴权、限流、任务持久化、队列和统一任务 API；不处理 PyTorch tensor。
- Python Worker：加载 H3，执行分段采样、latent 延续、漂移控制、二阶段采样和音视频合并。
- 对象存储：保存上传素材、片段检查点和最终视频。MaaS 与 Worker 只交换 URI，不通过 JSON 传大体积 base64。

## 创建任务

`POST /v1/video/timeline/generations`

```json
{
  "version": "1.0",
  "model": "minimax-h3",
  "fps": 24,
  "size": "1024x576",
  "seed": 12345,
  "global_prompt": "同一角色与服装，电影感运镜",
  "sampling": {
    "steps": 8,
    "low_resolution_steps": 6,
    "enable_drift_control": true,
    "enable_soft_audio": true
  },
  "segments": [
    {
      "id": "segment-01",
      "start": 0,
      "end": 7,
      "start_frame": 0,
      "end_frame": 168,
      "overlap_frames": 0,
      "prompt": "角色走向城门",
      "assets": [{ "id": "character", "type": "image", "uri": "asset://character", "role": "reference" }]
    },
    {
      "id": "segment-02",
      "start": 6,
      "end": 13,
      "start_frame": 144,
      "end_frame": 312,
      "overlap_frames": 24,
      "prompt": "角色推门进入室内",
      "assets": []
    }
  ],
  "output": { "container": "mp4", "codec": "h264" }
}
```

成功返回 `202 Accepted`：

```json
{ "id": "tl_01...", "status": "queued", "created_at": "2026-09-22T00:00:00Z" }
```

## 查询与取消

- `GET /v1/video/timeline/generations/{id}`：查询总体状态及当前分段。
- `DELETE /v1/video/timeline/generations/{id}`：请求取消；已经生成的检查点按保留策略处理。

建议状态对象：

```json
{
  "id": "tl_01...",
  "status": "running",
  "progress": 42,
  "current_segment": 2,
  "segment_count": 4,
  "phase": "high_resolution_sampling",
  "segments": [
    { "id": "segment-01", "status": "completed", "progress": 100 },
    { "id": "segment-02", "status": "running", "progress": 68 }
  ]
}
```

终态为 `completed`、`failed` 或 `cancelled`。完成时返回 `output.url`、`output.duration`、`output.width`、`output.height`。

## Worker 任务消息

MaaS 写入队列时传计划对象和已签名素材 URI。Worker 每完成一个分段，应写出：

- 可恢复的采样检查点；
- 下一段需要的 latent carry 元数据；
- 分段预览/日志；
- 当前阶段与进度事件。

latent tensor 不应经 MaaS HTTP JSON 往返；它应停留在 Worker 显存/内存，或以受控检查点写入本地高速盘/对象存储。

## 首版范围

首版建议只实现 2–4 段、单任务单 GPU、固定共享 seed、逐段检查点和最终拼接。素材编辑、选择性重跑、断点跨机器恢复与多 GPU pipeline 放到后续版本。
