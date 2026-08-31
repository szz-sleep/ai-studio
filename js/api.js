/**
 * AI Studio - API 调用封装
 * 支持多平台：OPC Cloud / OpenAI / Google Gemini / Anthropic / 自定义
 */

const API = {
    // 视频任务可能需要较长时间，统一允许前台轮询最多 30 分钟。
    VIDEO_POLL_INTERVAL_MS: 15000,
    VIDEO_POLL_TIMEOUT_MS: 30 * 60 * 1000,

    /**
     * 从 models.json 加载模型分类配置
     */
    _modelConfig: null,

    /**
     * 根据模型名称从 models.json 查询匹配的规则
     */
    _getModelRule(modelName) {
        if (!this._modelConfig || !this._modelConfig.rules) return null;
        const name = (modelName || '').toLowerCase();
        return this._modelConfig.rules.find(r => name.includes(r.match.toLowerCase())) || null;
    },

    /**
     * 判断模型是否为本地自部署模型
     * 通过 models.json 中的 local 字段识别
     */
    _isLocalModel(modelName) {
        const rule = this._getModelRule(modelName);
        return !!(rule && rule.local);
    },

    /**
     * 获取本地模型支持的分辨率（1024x576 等）
     * 根据比例自动匹配
     */
    _getLocalModelSize(ratio, modelName) {
        const rule = this._getModelRule(modelName);
        if (rule && rule.supportedSizes) {
            return rule.supportedSizes[ratio] || Object.values(rule.supportedSizes)[0];
        }
        return null;
    },

    async _loadModelConfig() {
        if (this._modelConfig) return this._modelConfig;
        try {
            const resp = await fetch('models.json');
            this._modelConfig = await resp.json();
            Logger.info(`[API] 模型配置加载成功，共 ${this._modelConfig.rules.length} 条规则`);
        } catch (e) {
            Logger.warn(`[API] 模型配置文件加载失败，使用默认规则: ${e.message}`);
            // 兜底默认规则：models.json 缺失时也能正确分类常见模型，保证本地/云端识别不失效
            this._modelConfig = {
                rules: [
                    { match: 'seedream', type: 'image', label: 'Seedream', tags: [], local: false },
                    { match: 'seedance', type: 'video', label: 'Seedance', tags: [], local: false },
                    { match: 'doubao', type: 'text', label: '豆包', tags: [], local: false },
                    { match: 'deepseek', type: 'text', label: 'DeepSeek', tags: [], local: false },
                    { match: 'gpt', type: 'text', label: 'GPT', tags: [], local: false },
                    { match: 'claude', type: 'text', label: 'Claude', tags: [], local: false },
                    { match: 'llama', type: 'text', label: 'Llama', tags: [], local: false },
                    { match: 'qwen', type: 'text', label: '通义千问', tags: [], local: false },
                    { match: 'video', type: 'video', label: '视频模型', tags: [], local: false }
                ]
            };
        }
    },

    /**
     * 获取完整请求 URL
     */
    _url(path) {
        let base = Config.getBaseUrl().replace(/\/+$/, ''); // 去尾部斜杠
        // 如果 base 以 /v1 结尾，且 path 以 /v1 开头，去重
        if (base.endsWith('/v1') && path.startsWith('/v1')) {
            path = path.slice(3); // 去掉 path 开头的 /v1
        }
        return base + path;
    },

    /**
     * 获取请求头（按平台适配）
     */
    _headers() {
        const platform = Config.getCurrentPlatformConfig();
        const headers = { 'Content-Type': 'application/json' };
        const apiKey = Config.getApiKey();

        // Anthropic 自动识别：Key 以 sk-ant- 开头，使用 x-api-key 头
        if (apiKey && apiKey.startsWith('sk-ant-')) {
            headers['x-api-key'] = apiKey;
            headers['anthropic-version'] = '2023-06-01';
        } else {
            headers['Authorization'] = `Bearer ${apiKey}`;
        }
        return headers;
    },

    /**
     * 拉取所有模型列表
     * GET /v1/models
     */
    async getModels() {
        const platform = Config.getCurrentPlatformConfig();
        const modelsPath = platform.modelsEndpoint || '/v1/models';
        const resp = await fetch(this._url(modelsPath), {
            headers: this._headers()
        });
        if (!resp.ok) {
            const err = await resp.json().catch(() => ({}));
            throw new Error(err.error?.message || `获取模型列表失败 (${resp.status})`);
        }
        const data = await resp.json();
        return data.data || [];
    },

    /**
     * 将模型按类型分类
     * @returns {{image: Array, video: Array, other: Array}}
     */
    /**
     * 根据 models.json 规则对模型进行分类
     * @param {Array} models - API 返回的原始模型列表
     * @returns {object} { image, video, other }
     */
    classifyModels(models) {
        const cfg = this._modelConfig;
        const image = [];
        const video = [];
        const text = [];
        const other = [];

        // 快速查找：构建 match → rule 字典
        const ruleMap = {};
        if (cfg && cfg.rules) {
            cfg.rules.forEach(r => { ruleMap[r.match.toLowerCase()] = r; });
        }

        models.forEach(m => {
            const id = (m.id || '').toLowerCase();
            let matched = null;

            // 精确/包含匹配：先找 models.json 中 match 字段
            if (cfg && cfg.rules) {
                matched = cfg.rules.find(r => id.includes(r.match.toLowerCase()));
            }

            if (matched) {
                m._label = matched.label;
                m._tags = matched.tags || [];
                if (matched.type === 'image') {
                    image.push(m);
                } else if (matched.type === 'video') {
                    video.push(m);
                } else if (matched.type === 'text') {
                    text.push(m);
                } else {
                    other.push(m);
                }
            } else {
                other.push(m);
            }
        });

        // 如果某类为空，把无法识别的也塞进去（兼容策略）
        if (image.length === 0 && other.length > 0) {
            other.forEach(m => image.push(m));
        }
        if (video.length === 0 && other.length > 0) {
            other.forEach(m => video.push(m));
        }
        if (text.length === 0 && other.length > 0) {
            other.forEach(m => text.push(m));
        }

        return { image, video, text, other };
    },

    /**
     * 文生图（图生图通过 image/images 参数支持）
     * POST /v1/images/generations
     * @param {object} opts
     * @param {string} opts.prompt - 提示词
     * @param {string} opts.model - 模型
     * @param {string} [opts.size]
     * @param {number} [opts.n]
     * @param {string} [opts.quality]
     * @param {string} [opts.style]
     * @param {string} [opts.image] - 单图 base64
     * @param {string[]} [opts.images] - 多图 base64 数组，所有图片+提示词一次发给模型
     * @param {AbortSignal} [opts.signal]
     */
    async generateImage({ prompt, model, size, n, quality, style, image, images, ratio, qualityLabel, signal }) {
        const body = {
           prompt,
           model,
           size: size || '1024x1024',
            n: n || 1
        };
        if (quality) body.quality = quality;
        if (style) body.style = style;
        // 图片参数：支持单图和多图
        if (Array.isArray(images) && images.length > 0) {
            // 多图：传 images 数组（纯 base64，无 data URI 前缀）
            body.images = images;
            Logger.info(`[API] 图片生成请求: 多图模式, ${images.length} 张图, 模型=${model}, 尺寸=${body.size}`);
        } else if (typeof image === 'string') {
            // 单图：传 image
            body.image = image;
            Logger.info(`[API] 图片生成请求: 单图模式, 模型=${model}, 尺寸=${body.size}`);
        } else {
            Logger.info(`[API] 图片生成请求: 纯文生图, 模型=${model}, 尺寸=${body.size}`);
        }

        // 带超时的 fetch
        const controller = new AbortController();
        const mergedSignal = signal || controller.signal;
        const timeoutId = setTimeout(() => controller.abort(), 120000); // 2分钟超时

        try {
            const platform = Config.getCurrentPlatformConfig();
            const endpoint = platform.imageEndpoint || '/v1/images/generations';
            const resp = await fetch(this._url(endpoint), {
                method: 'POST',
                headers: this._headers(),
                body: JSON.stringify(body),
                signal: mergedSignal
            });
            clearTimeout(timeoutId);
            if (!resp.ok) {
                const err = await resp.json().catch(() => ({}));
                throw new Error(err.error?.message || `图片生成失败 (${resp.status})`);
            }
            return await resp.json();
        } catch (err) {
            clearTimeout(timeoutId);
            if (err.name === 'AbortError') {
                throw new Error('请求超时或已取消，请重试');
            }
           throw err;
       }
   },

    /**
     * 图生图 - 图片编辑/融合接口
     * POST /v1/images/edits
     * JSON 格式，images 数组传纯 base64 + prompt 一次性发给模型
     * 注意：不传 size、不传 response_format（由模型自动决定）
     */
    async generateImageEdit({ prompt, model, size, images, ratio, qualityLabel, signal }) {
        const body = { prompt, model, n: 1 };
        if (size) body.size = size;

        // images 数组直接透传：普通上传为公网 URL，素材库选中为 asset://<id> 引用
        // 不再在浏览器端 base64 拼接，避免请求体过大导致 413；后端构造 content 数组 + image_url 透传火山
        if (Array.isArray(images) && images.length > 0) {
            body.images = images;
            Logger.info('[API] 图生图: ' + images.length + ' 张参考图, 模型=' + model + ', 尺寸=' + (size || 'auto'));
        }

        const controller = new AbortController();
        const mergedSignal = signal || controller.signal;
        const timeoutId = setTimeout(() => controller.abort(), 180000);

        try {
            const platform = Config.getCurrentPlatformConfig();
            const endpoint = platform.imageEditEndpoint || '/v1/images/edits';
            Logger.info('[API] 请求端点: ' + endpoint);
            const resp = await fetch(this._url(endpoint), {
                method: 'POST',
                headers: this._headers(),
                body: JSON.stringify(body),
                signal: mergedSignal
            });
            clearTimeout(timeoutId);
            if (!resp.ok) {
                const err = await resp.json().catch(() => ({}));
                throw new Error(err.error?.message || '图生图失败 (' + resp.status + ')');
            }
            return await resp.json();
        } catch (err) {
            clearTimeout(timeoutId);
            if (err.name === 'AbortError') throw new Error('请求超时或已取消，请重试');
            throw err;
        }
    },

    /**
     * 创建视频生成任务
     * POST /v1/video/generations
     * @param {object} opts
     * @param {string[]} [opts.images] - 多图 base64 数组
     */
   async createVideoTask({ model, prompt, image, images, resolution, ratio, duration, fps, seed, n, referenceImages, referenceVideos, referenceAudios, firstFrameUrl, lastFrameUrl }) {
       const size = resolution;
       const body = {
           model,
           prompt: prompt || ''
       };
       if (images && images.length > 0) {
           // 多图：直接传 images 数组（纯 base64），不再拼接成一张大图
           // 拼接会产生超大请求体（413/超时），且丢失多图独立性
           body.images = images;
        } else if (image) {
            body.image = image;
        }

        // 本地模型分辨率匹配
        const localSize = this._getLocalModelSize(ratio, model);
        if (localSize) {
            body.size = localSize;
            Logger.info(`[API] 本地模型大小映射: ${ratio} → ${localSize}`);
        } else if (size) {
            body.size = size;
        }
        // 火山视频模型使用 resolution 字段（如 1080p/720p）；size 留给图片/本地模型
        if (size) body.resolution = size;
        if (duration) body.duration = duration;
        if (ratio) body.ratio = ratio;
        if (fps) body.fps = fps;
        if (seed !== undefined && seed !== '') body.seed = seed;
        if (n) body.n = n;

        // 本地模型：传 base64 data URI；云端/火山模型：传 URL
        if (referenceImages && referenceImages.length > 0) {
            body.images = referenceImages;
        }
        if (referenceVideos && referenceVideos.length > 0) {
            body.videos = referenceVideos;
        }
        if (referenceAudios && referenceAudios.length > 0) {
            body.audios = referenceAudios;
        }
        if (firstFrameUrl) body.first_frame = firstFrameUrl;
        if (lastFrameUrl) body.last_frame = lastFrameUrl;

        const platform = Config.getCurrentPlatformConfig();
        const endpoint = platform.videoEndpoint || '/v1/video/generations';
        Logger.info(`[API/视频] 请求体: ${JSON.stringify({...body, prompt: (body.prompt||'').substring(0, 80)+'...'})}`);
        const resp = await fetch(this._url(endpoint), {
            method: 'POST',
            headers: this._headers(),
            body: JSON.stringify(body)
        });
        if (!resp.ok) {
            const errText = await resp.text().catch(() => '');
            Logger.error('[API] 视频创建失败响应: ' + errText.substring(0, 500));
            let errMsg;
            try { errMsg = JSON.parse(errText).error?.message; } catch { errMsg = ''; }
            throw new Error(errMsg || `视频任务创建失败 (${resp.status}): ${errText.substring(0, 200)}`);
        }
       return await resp.json();
   },

    /**
     * 查询视频任务状态
     * GET /v1/video/generations/{task_id}
     */
    async getVideoTask(taskId) {
        const platform = Config.getCurrentPlatformConfig();
        const endpoint = platform.videoEndpoint || '/v1/video/generations';
        const resp = await fetch(this._url(`${endpoint}/${taskId}`), {
            headers: this._headers()
        });
        if (!resp.ok) {
            const err = await resp.json().catch(() => ({}));
            throw new Error(err.error?.message || `查询任务状态失败 (${resp.status})`);
        }
        return await resp.json();
    },

    /**
     * 轮询视频任务直到完成
     * @param {string} taskId
     * @param {function} onProgress - 进度回调
     * @param {number} interval - 轮询间隔(ms)
     * @param {number} timeout - 超时(ms)
     * @param {AbortSignal} signal - 取消信号
     */
    async pollVideoTask(taskId, onProgress, interval = this.VIDEO_POLL_INTERVAL_MS, timeout = this.VIDEO_POLL_TIMEOUT_MS, signal) {
        const start = Date.now();
        while (true) {
            // 检查是否被取消
            if (signal?.aborted) {
                throw new DOMException('用户取消了生成', 'AbortError');
            }

            const task = await this.getVideoTask(taskId);

            // 实际状态可能在 data 里（外包装 {code, message, data}）
            const taskData = task.data || task;
            const rawStatus = taskData.status || task.status || '';
            const status = rawStatus.toLowerCase();
            Logger.req(`轮询响应: status="${rawStatus}", 完整响应: ${JSON.stringify(task).substring(0, 400)}`);

            // 成功状态：兼容多种 API 可能返回的值
            const doneStatuses = ['completed', 'success', 'succeeded', 'done', 'finished', 'complete'];
            if (doneStatuses.includes(status)) {
                if (onProgress) onProgress(100, '完成');
                // 返回时带上完整的 task 对象
                return { ...task, _taskData: taskData };
            }

            // 失败状态
            const failStatuses = ['failed', 'error', 'fail', 'cancelled', 'canceled'];
            if (failStatuses.includes(status)) {
                throw new Error(taskData.error?.message || taskData.error || task.error?.message || `视频生成失败 (status: ${rawStatus})`);
            }

            // 未知/异常状态：连续 6 次（约 30 秒）未返回已知状态，判定异常，避免用户干等 30 分钟
            const knownStatuses = doneStatuses.concat(failStatuses, ['queued', 'pending', 'processing', 'running', 'in_progress', 'submitted', 'created']);
            if (!knownStatuses.includes(status)) {
                this._unknownStatusCount = (this._unknownStatusCount || 0) + 1;
                if (this._unknownStatusCount >= 6) {
                    this._unknownStatusCount = 0;
                    throw new Error(`任务状态异常（无法识别状态 "${rawStatus}"），任务ID ${taskId} 可能仍在平台后台运行，请到模型平台查看详情`);
                }
            } else {
                this._unknownStatusCount = 0;
            }

            // 更新进度（优先使用 API 返回的真实进度）
            if (onProgress) {
                let pct = 0;
                let statusText = `状态: ${rawStatus || '生成中...'}`;
                // API 可能返回 progress 字段，如 "30%" 或 50
                if (taskData.progress) {
                    const rawPct = parseFloat(taskData.progress);
                    if (!isNaN(rawPct)) {
                        pct = Math.min(99, Math.round(rawPct));
                        statusText = `生成中 ${pct}%`;
                    }
                }
                if (pct === 0) {
                    const elapsed = Date.now() - start;
                    pct = Math.min(90, Math.round((elapsed / timeout) * 90));
                }
                onProgress(pct, statusText);
            }

            // 超时检查
            if (Date.now() - start > timeout) {
                throw new Error('视频生成等待超过30分钟，后台任务可能仍在运行，请稍后通过模型平台查看');
            }

            // 等待
            await new Promise(r => setTimeout(r, interval));
        }
    },

    /**
     * 将图片文件转为 Base64
     */
    fileToBase64(file) {
        return new Promise((resolve, reject) => {
            const reader = new FileReader();
            reader.onload = () => resolve(reader.result);
            reader.onerror = reject;
            reader.readAsDataURL(file);
        });
    },

    /**
     * AI 对话/文本生成（文生文）
     * OpenAI 标准: POST /v1/chat/completions
     * Anthropic 标准: POST /v1/messages
     * @param {object} opts
     * @param {string} opts.model - 模型名称
     * @param {Array} opts.messages - 消息数组 [{role, content}]
     * @param {AbortSignal} [opts.signal]
     * @returns {Promise<string>} AI 返回的文本内容
     */
    async chatCompletion({ model, messages, signal }) {
        const apiKey = Config.getApiKey();
        const isAnthropic = apiKey && apiKey.startsWith('sk-ant-');
        const platform = Config.getCurrentPlatformConfig();

        if (isAnthropic) {
            // Anthropic 标准: system 单独传，messages 只含 user/assistant
            const systemMsg = messages.find(m => m.role === 'system');
            const body = {
                model,
                messages: messages.filter(m => m.role !== 'system').map(m => ({
                    role: m.role === 'assistant' ? 'assistant' : 'user',
                    content: m.content
                })),
                max_tokens: 4096,
            };
            if (systemMsg) body.system = systemMsg.content;

            const endpoint = '/v1/messages';
            Logger.info(`[API/Anthropic] chat: model=${model}, messages=${body.messages.length}`);

            const resp = await fetch(this._url(endpoint), {
                method: 'POST',
                headers: this._headers(),
                body: JSON.stringify(body),
                signal
            });
            if (!resp.ok) {
                const err = await resp.json().catch(() => ({}));
                throw new Error(err.error?.message || `AI 请求失败 (${resp.status})`);
            }
            const data = await resp.json();
            // Anthropic 返回格式: { content: [{type: 'text', text: '...'}] }
            const text = data.content?.map(c => c.text || '').join('') || '';
            return text;
        } else {
            // OpenAI 标准
            const body = { model, messages, stream: false };
            const endpoint = platform.chatEndpoint || '/v1/chat/completions';
            Logger.info(`[API] chat: model=${model}, messages=${messages.length}`);

            const resp = await fetch(this._url(endpoint), {
                method: 'POST',
                headers: this._headers(),
                body: JSON.stringify(body),
                signal
            });
            if (!resp.ok) {
                const err = await resp.json().catch(() => ({}));
                throw new Error(err.error?.message || `AI 请求失败 (${resp.status})`);
            }
            const data = await resp.json();
            // OpenAI 返回格式: { choices: [{ message: { content: '...' } }] }
            const text = data.choices?.[0]?.message?.content || '';
            return text;
        }
    },

    /**
     * 流式聊天补全 (SSE stream)
     * @param {function} onChunk - 每收到一段文本时的回调 (text, fullText)
     */
    async chatCompletionStream({ model, messages, signal, onChunk }) {
        const apiKey = Config.getApiKey();
        const isAnthropic = apiKey && apiKey.startsWith('sk-ant-');
        const platform = Config.getCurrentPlatformConfig();
        const endpoint = isAnthropic ? '/v1/messages' : (platform.chatEndpoint || '/v1/chat/completions');

        let body;
        if (isAnthropic) {
            const systemMsg = messages.find(m => m.role === 'system');
            body = {
                model,
                messages: messages.filter(m => m.role !== 'system').map(m => ({
                    role: m.role === 'assistant' ? 'assistant' : 'user',
                    content: m.content
                })),
                max_tokens: 4096,
                stream: true,
            };
            if (systemMsg) body.system = systemMsg.content;
        } else {
            body = { model, messages, stream: true };
        }

        Logger.info(`[API] chat stream: model=${model}, messages=${messages.length}`);

        const resp = await fetch(this._url(endpoint), {
            method: 'POST',
            headers: { ...this._headers(), 'Accept': 'text/event-stream' },
            body: JSON.stringify(body),
            signal
        });

        if (!resp.ok) {
            const err = await resp.json().catch(() => ({}));
            throw new Error(err.error?.message || `AI 请求失败 (${resp.status})`);
        }

        const reader = resp.body.getReader();
        const decoder = new TextDecoder();
        let buffer = '';
        let fullText = '';

        while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            buffer += decoder.decode(value, { stream: true });

            const lines = buffer.split('\n');
            buffer = lines.pop(); // 保留不完整的行

            for (const line of lines) {
                const trimmed = line.trim();
                if (!trimmed || !trimmed.startsWith('data:')) continue;
                const data = trimmed.slice(5).trim();
                if (data === '[DONE]') continue;

                try {
                    const json = JSON.parse(data);
                    if (isAnthropic) {
                        // Anthropic SSE: { type: 'content_block_delta', delta: { type: 'text_delta', text: '...' } }
                        if (json.type === 'content_block_delta' && json.delta?.text) {
                            fullText += json.delta.text;
                            if (onChunk) onChunk(json.delta.text, fullText);
                        }
                    } else {
                        // OpenAI SSE: { choices: [{ delta: { content: '...' } }] }
                        const delta = json.choices?.[0]?.delta?.content;
                        if (delta) {
                            fullText += delta;
                            if (onChunk) onChunk(delta, fullText);
                        }
                    }
                } catch (e) { /* 忽略 JSON 解析错误 */ }
            }
        }

        return fullText;
    },

    /**
     * 修正 API 返回的资源 URL
     * 部分 API 返回 localhost 内部地址，需替换为实际 API 地址
     */
    normalizeResultUrl(url) {
        if (!url) return '';
        try {
            const baseUrl = Config.getBaseUrl();
            const u = new URL(url);
            if (/^localhost(:\d+)?$/.test(u.host) || u.hostname === '127.0.0.1' || u.hostname === '0.0.0.0') {
                const base = new URL(baseUrl);
                u.protocol = base.protocol;
                u.host = base.host;
                return u.toString();
            }
        } catch (e) {}
        return url;
    }
};
