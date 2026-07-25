/**
 * AI Studio - API 调用封装
 * 支持多平台：OPC Cloud / OpenAI / Google Gemini / Anthropic / 自定义
 */

const API = {
    /**
     * 从 models.json 加载模型分类配置
     */
    _modelConfig: null,

    /**
     * 当前平台是否为 Agnes AI
     */
    _isAgnes() {
        return Config.getPlatform() === 'agnes';
    },

    /**
     * 当前平台是否为火山引擎
     */
    _isVolcengine() {
        return Config.getPlatform() === 'volcengine';
    },

    /**
     * 画质档位 → Agnes size 档位
     */
    _agnesSizeFromQuality(qualityLabel) {
        const map = { '1080': '1K', '2K': '2K', '4K': '4K' };
        return map[qualityLabel] || '2K';
    },

    /**
     * 时长(秒) + 帧率 → Agnes num_frames（遵循 8n+1 且 ≤441）
     */
    _agnesSecondsToFrames(seconds, frameRate) {
        let n = Math.round((seconds * frameRate - 1) / 8);
        if (n < 1) n = 1;
       return Math.min(441, n * 8 + 1);
   },

    /**
     * 纯 base64 → Data URI（自动检测 MIME，避免一律标 jpeg）
     */
   _agnesDataUri(b64) {
       if (!b64) return b64;
       if (b64.startsWith('data:')) return b64; // 已是完整 Data URI
       let mime = 'image/png';
       if (b64.startsWith('/9j/')) mime = 'image/jpeg';
       else if (b64.startsWith('UklGR')) mime = 'image/webp';
      return `data:${mime};base64,${b64}`;
  },


    /**
     * 画质档位 + 比例 → Agnes 精确输出尺寸
     * 图生图时使用精确像素尺寸而非档位+ratio（Agnes 文档图生图示例均用精确尺寸）
     */
    _agnesPreciseSize(qualityLabel, ratio) {
        const map = {
            '1080': { '1:1': '1024x1024', '9:16': '736x1312', '16:9': '1312x736', '21:9': '1568x672', '3:4': '864x1152', '4:3': '1152x864', '2:3': '832x1248' },
            '2K':   { '1:1': '2048x2048', '9:16': '1472x2624', '16:9': '2624x1472', '21:9': '3136x1344', '3:4': '1728x2304', '4:3': '2304x1728', '2:3': '1664x2496' },
            '4K':   { '1:1': '4096x4096', '9:16': '2944x5248', '16:9': '5248x2944', '21:9': '6272x2688', '3:4': '3456x4608', '4:3': '4608x3456', '2:3': '3328x4992' },
        };
        const q = qualityLabel || '1080';
        const r = ratio || '1:1';
        return (map[q] && map[q][r]) || '1024x1024';
    },

    async _loadModelConfig() {
        if (this._modelConfig) return this._modelConfig;
        try {
            const resp = await fetch('models.json');
            this._modelConfig = await resp.json();
            Logger.info(`[API] 模型配置加载成功，共 ${this._modelConfig.rules.length} 条规则`);
        } catch (e) {
            Logger.warn(`[API] 模型配置文件加载失败，使用默认规则: ${e.message}`);
            this._modelConfig = null;
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

        // 自定义平台支持 Anthropic 标准（x-api-key + anthropic-version）
        if (Config.getPlatform() === 'custom' && Config.getCustomApiStandard() === 'anthropic') {
            headers['x-api-key'] = apiKey;
            headers['anthropic-version'] = Config.getCustomAnthropicVersion();
        } else {
            // OpenAI 标准 / 所有预设平台: Bearer Token
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

        // 火山引擎平台：尝试从 API 获取模型列表，失败则使用内置列表
        if (this._isVolcengine()) {
            Logger.info('[API/Volcengine] 尝试从 API 获取模型列表');
            try {
                const resp = await fetch(this._url('/models'), {
                    headers: this._headers()
                });
                if (resp.ok) {
                    const data = await resp.json();
                    const models = data.data || [];
                    if (models.length > 0) {
                        Logger.info(`[API/Volcengine] API 返回 ${models.length} 个模型`);
                        return models;
                    }
                }
                Logger.warn('[API/Volcengine] API 返回空列表或无权限，降级使用内置模型');
            } catch (e) {
                Logger.warn('[API/Volcengine] 获取模型列表失败，降级使用内置模型:', e.message);
            }
            // fallback: 内置模型列表
            Logger.info('[API/Volcengine] 使用内置模型列表');
            return [
                // 文本模型（已验证可用）
                { id: 'doubao-seed-2-0-pro-260215', object: 'model', owned_by: 'volcengine' },
                { id: 'doubao-seed-2-0-lite-260215', object: 'model', owned_by: 'volcengine' },
                { id: 'doubao-seed-2-0-lite-260428', object: 'model', owned_by: 'volcengine' },
                { id: 'doubao-seed-character-251128', object: 'model', owned_by: 'volcengine' },
                { id: 'doubao-1-5-pro-32k-250115', object: 'model', owned_by: 'volcengine' },
                { id: 'doubao-1-5-lite-32k-250115', object: 'model', owned_by: 'volcengine' },
                // 视频模型
                { id: 'doubao-seedance-2-0-260128', object: 'model', owned_by: 'volcengine' },
                { id: 'doubao-seedance-1-0-pro-250528', object: 'model', owned_by: 'volcengine' },
                { id: 'doubao-seedance-1-0-lite-t2v-250428', object: 'model', owned_by: 'volcengine' },
                { id: 'doubao-seedance-1-0-lite-i2v-250428', object: 'model', owned_by: 'volcengine' },
                // 图片模型
                { id: 'doubao-seedream-4-5-251128', object: 'model', owned_by: 'volcengine' },
                { id: 'doubao-seedream-4-0-250828', object: 'model', owned_by: 'volcengine' },
                { id: 'doubao-seedream-3-0-t2i-250828', object: 'model', owned_by: 'volcengine' },
                { id: 'doubao-seedream-3-0-t2i-250428', object: 'model', owned_by: 'volcengine' }
            ];
        }

        // 使用平台配置的 models 端点
       let modelsPath = platform.modelsEndpoint || '/v1/models';

        // Agnes：/v1/models 失败时仍返回已知模型，确保 UI 可用
        let models = [];
        try {
            const resp = await fetch(this._url(modelsPath), {
                headers: this._headers()
            });
            if (resp.ok) {
                const data = await resp.json();
                models = data.data || [];
            } else if (!this._isAgnes()) {
                const err = await resp.json().catch(() => ({}));
                throw new Error(err.error?.message || `获取模型列表失败 (${resp.status})`);
            }
            // Agnes 的 4xx/5xx 在此被忽略，走下面的 fallback
        } catch (e) {
            if (this._isAgnes()) {
                Logger.warn(`[API/Agnes] 模型列表接口不可用，使用内置模型: ${e.message}`);
            } else {
                throw e;
            }
        }

        // Agnes 平台：确保两个已知模型始终可用（即使 /v1/models 未列出）
        if (this._isAgnes()) {
            const knownIds = ['agnes-image-2.1-flash', 'agnes-video-v2.0'];
            const existing = new Set(models.map(m => m.id));
            knownIds.forEach(id => {
                if (!existing.has(id)) {
                    models.push({ id, object: 'model', owned_by: 'agnes' });
                }
            });
        }

        return models;
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
        // 火山引擎平台：添加 extra_body.response_format（seedream 4.5 需要）
        if (this._isVolcengine()) {
            return this._volcengineGenerateImage({ prompt, model, size, n, image, images, signal });
        }
        // Agnes AI 平台：size 档位 + ratio，response_format 放 extra_body，图生图走 extra_body.image
        if (this._isAgnes()) {
            return this._agnesGenerateImage({ prompt, model, ratio, qualityLabel, image, images, signal });
        }
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
     * Agnes 图片生成（文生图 + 图生图统一走 /v1/images/generations）
     * 文生图: size 用档位(1K/2K/3K/4K) + ratio；图生图: 用精确像素尺寸（ratio 在图生图模式下可能被忽略）；
     * 图生图通过 extra_body.image 数组传图。
     */
    async _agnesGenerateImage({ prompt, model, ratio, qualityLabel, image, images, signal }) {
        const body = { model, prompt };
        const hasImages = (Array.isArray(images) && images.length > 0) || typeof image === 'string';

        if (hasImages) {
            // 图生图：使用精确像素尺寸（Agnes 官方图生图示例均用精确尺寸如 1024x768，不带 ratio）
            body.size = this._agnesPreciseSize(qualityLabel, ratio);
        } else {
            // 文生图：档位 + ratio（文档推荐方式）
            body.size = this._agnesSizeFromQuality(qualityLabel);
            if (ratio) body.ratio = ratio;
        }
        body.extra_body = { response_format: 'url' };

        if (Array.isArray(images) && images.length > 0) {
           body.extra_body.image = images.map(b64 => this._agnesDataUri(b64));
          Logger.info(`[API/Agnes] 图生图: ${images.length} 张图, 模型=${model}, 尺寸=${body.size}, 比例=${ratio || '1:1'}`);
      } else if (typeof image === 'string') {
           body.extra_body.image = [this._agnesDataUri(image)];
            Logger.info(`[API/Agnes] 图生图: 1 张图, 模型=${model}, 尺寸=${body.size}, 比例=${ratio || '1:1'}`);
        } else {
            Logger.info(`[API/Agnes] 文生图, 模型=${model}, 尺寸=${body.size}, 比例=${ratio || '1:1'}`);
        }

        const controller = new AbortController();
        const mergedSignal = signal || controller.signal;
        const timeoutId = setTimeout(() => controller.abort(), 180000);

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
        // 火山引擎平台：图生图也走 /images/generations，通过 image 字段传参考图
        if (this._isVolcengine()) {
            return this._volcengineImageToImage({ prompt, model, size, images, signal });
        }
        // Agnes 平台：图生图统一走 /v1/images/generations + extra_body.image
        if (this._isAgnes()) {
            return this._agnesGenerateImage({ prompt, model, ratio, qualityLabel, images, signal });
        }
        const body = { prompt, model, n: 1 };
        if (size) body.size = size;

        if (Array.isArray(images) && images.length > 0) {
            if (images.length === 1) {
                // 单图：image 字段需要带 data URI 前缀
                body.image = 'data:image/jpeg;base64,' + images[0];
                Logger.info('[API] 图生图: 1 张图 + 提示词, 模型=' + model + ', 尺寸=' + (size || 'auto'));
            } else {
                // 多图：拼成一张合成图，用 image 字段发送
                Logger.info('[API] 图生图: ' + images.length + ' 张图，正在拼接...');
                const merged = await this._stitchImages(images);
                body.image = 'data:image/jpeg;base64,' + merged;
                Logger.info('[API] 图生图: 拼接完成, 模型=' + model + ', 尺寸=' + (size || 'auto'));
            }
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
     * 火山引擎文生图（POST /images/generations，添加 extra_body.response_format=url）
     */
    async _volcengineGenerateImage({ prompt, model, size, n, image, images, signal }) {
        const body = { prompt, model, size: size || '1024x1024', n: n || 1 };
        if (image) body.image = image;
        if (Array.isArray(images) && images.length > 0) body.images = images;
        body.response_format = 'url';
        body.watermark = false;

        Logger.info('[API/Volcengine] 文生图请求, 模型=' + model + ', 尺寸=' + body.size);

        const controller = new AbortController();
        const mergedSignal = signal || controller.signal;
        const timeoutId = setTimeout(() => controller.abort(), 120000);

        try {
            const resp = await fetch(this._url('/images/generations'), {
                method: 'POST',
                headers: this._headers(),
                body: JSON.stringify(body),
                signal: mergedSignal
            });
            clearTimeout(timeoutId);
            if (!resp.ok) {
                const errText = await resp.text().catch(() => '');
                Logger.error('[API/Volcengine] 图片生成失败: ' + errText.substring(0, 300));
                let errMsg;
                try { errMsg = JSON.parse(errText).error?.message; } catch { errMsg = errText.substring(0, 200); }
                throw new Error(errMsg || '图片生成失败 (' + resp.status + ')');
            }
            return await resp.json();
        } catch (err) {
            clearTimeout(timeoutId);
            if (err.name === 'AbortError') throw new Error('请求超时或已取消，请重试');
            throw err;
        }
    },

    /**
     * 火山引擎图生图（POST /images/generations，通过 image 字段传参考图）
     */
    async _volcengineImageToImage({ prompt, model, size, images, signal }) {
        const body = { prompt: prompt || '', model, n: 1 };
        if (size) body.size = size;

        if (Array.isArray(images) && images.length > 0) {
            if (images.length === 1) {
                body.image = 'data:image/jpeg;base64,' + images[0];
                Logger.info('[API/Volcengine] 图生图: 1 张参考图, 模型=' + model);
            } else {
                Logger.info('[API/Volcengine] 图生图: ' + images.length + ' 张图，正在拼接...');
                const merged = await this._stitchImages(images);
                body.image = 'data:image/jpeg;base64,' + merged;
                Logger.info('[API/Volcengine] 图生图: 拼接完成, 模型=' + model);
            }
        }

        // 添加 response_format（seedream 4.5 支持）
        body.response_format = 'url';
        body.watermark = false;

        const controller = new AbortController();
        const mergedSignal = signal || controller.signal;
        const timeoutId = setTimeout(() => controller.abort(), 180000);

        try {
            const endpoint = '/images/generations';
            Logger.info('[API/Volcengine] 图生图请求端点: ' + endpoint);
            Logger.req(JSON.stringify({ model: body.model, prompt: body.prompt?.substring(0, 60), size: body.size, has_image: !!body.image }).substring(0, 200));
            const resp = await fetch(this._url(endpoint), {
                method: 'POST',
                headers: this._headers(),
                body: JSON.stringify(body),
                signal: mergedSignal
            });
            clearTimeout(timeoutId);
            if (!resp.ok) {
                const errText = await resp.text().catch(() => '');
                Logger.error('[API/Volcengine] 图生图失败: ' + errText.substring(0, 300));
                let errMsg;
                try { errMsg = JSON.parse(errText).error?.message; } catch { errMsg = errText.substring(0, 200); }
                throw new Error(errMsg || '图生图失败 (' + resp.status + ')');
            }
            return await resp.json();
        } catch (err) {
            clearTimeout(timeoutId);
            if (err.name === 'AbortError') throw new Error('请求超时或已取消，请重试');
            throw err;
        }
    },

    /**
     * 将多张 base64 图片拼接成一张（横向排列）
     * @param {string[]} images - 纯 base64 数组
     * @returns {Promise<string>} 拼接后的纯 base64
     */
    _stitchImages(images) {
        return new Promise((resolve, reject) => {
            const imgs = [];
            let loaded = 0;
            images.forEach((b64, i) => {
                const img = new Image();
                img.onload = () => {
                    imgs[i] = img;
                    loaded++;
                    if (loaded === images.length) {
                        try {
                            // 计算合成图尺寸：横向排列
                            const totalW = imgs.reduce((s, im) => s + im.width, 0);
                            const maxH = Math.max(...imgs.map(im => im.height));
                            const canvas = document.createElement('canvas');
                            canvas.width = totalW;
                            canvas.height = maxH;
                            const ctx = canvas.getContext('2d');
                            // 白色背景
                            ctx.fillStyle = '#ffffff';
                            ctx.fillRect(0, 0, totalW, maxH);
                            // 依次绘制每张图
                            let x = 0;
                            imgs.forEach(im => {
                                ctx.drawImage(im, x, 0);
                                x += im.width;
                            });
                            const dataUrl = canvas.toDataURL('image/jpeg', 0.85);
                            const result = dataUrl.substring(dataUrl.indexOf(',') + 1);
                            Logger.info('[API] 拼接完成: ' + totalW + 'x' + maxH + ', base64长度:' + result.length);
                            resolve(result);
                        } catch (e) {
                            reject(e);
                        }
                    }
                };
                img.onerror = () => reject(new Error('图片加载失败'));
                // 检测格式
                let mime = 'image/png';
                if (b64.startsWith('/9j/')) mime = 'image/jpeg';
                else if (b64.startsWith('UklGR')) mime = 'image/webp';
                img.src = 'data:' + mime + ';base64,' + b64;
            });
        });
    },

    /**
     * 创建视频生成任务
     * POST /v1/video/generations
     * @param {object} opts
     * @param {string[]} [opts.images] - 多图 base64 数组
     */
   async createVideoTask({ model, prompt, image, images, resolution, ratio, duration, fps, seed, n, referenceImages, referenceVideos, referenceAudios, firstFrameUrl, lastFrameUrl }) {
       const size = resolution;  // backward compat for non-volc platforms
       // 火山引擎平台：使用 contents/generations/tasks API
       if (this._isVolcengine()) {
           return this._volcengineCreateVideo({ model, prompt, image, images, resolution, ratio, duration, fps, seed, referenceImages, referenceVideos, referenceAudios, firstFrameUrl, lastFrameUrl });
       }
       const body = {
           model,
           prompt: prompt || ''
       };
       // Agnes 平台：参数体系不同（num_frames/frame_rate/width/height）
       if (this._isAgnes()) {
           const fr = fps || 24;
           body.frame_rate = fr;
           if (size && typeof size === 'string') {
               const parts = size.split('x').map(Number);
               if (parts.length === 2 && parts.every(v => !isNaN(v))) {
                   body.width = parts[0];
                   body.height = parts[1];
               }
           }
           if (duration) body.num_frames = this._agnesSecondsToFrames(duration, fr);
           if (seed !== undefined && seed !== '') body.seed = seed;
           // 图生视频：单图用 image，多图走关键帧 extra_body.image
           if (Array.isArray(images) && images.length > 0) {
               const dataUris = images.map(b64 => this._agnesDataUri(b64));
               if (dataUris.length === 1) {
                   body.image = dataUris[0];
               } else {
                   body.extra_body = { image: dataUris, mode: 'keyframes' };
               }
           } else if (image) {
               body.image = image;
           }
           Logger.info(`[API/Agnes] 视频任务, 模型=${model}, 帧数=${body.num_frames || '默认'}, 帧率=${fr}, 尺寸=${body.width || ''}x${body.height || ''}`);
           return this._agnesCreateVideo(body);
       }
       if (images && images.length > 0) {
           if (images.length === 1) {
               // 单图：image 字段带 data URI 前缀
               body.image = 'data:image/jpeg;base64,' + images[0];
            } else {
                // 多图：拼成一张合成图
                const merged = await this._stitchImages(images);
                body.image = 'data:image/jpeg;base64,' + merged;
            }
        } else if (image) {
            body.image = image;
        }
        if (size) body.size = size;
        if (duration) body.duration = duration;
        if (fps) body.fps = fps;
        if (seed !== undefined && seed !== '') body.seed = seed;
        if (n) body.n = n;

        const platform = Config.getCurrentPlatformConfig();
        const endpoint = platform.videoEndpoint || '/v1/video/generations';
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
     * Agnes 视频任务创建（POST /v1/videos）
     */
    async _agnesCreateVideo(body) {
        const platform = Config.getCurrentPlatformConfig();
        const endpoint = platform.videoEndpoint || '/v1/videos';
        const resp = await fetch(this._url(endpoint), {
            method: 'POST',
            headers: this._headers(),
            body: JSON.stringify(body)
        });
        if (!resp.ok) {
            const errText = await resp.text().catch(() => '');
            Logger.error('[API/Agnes] 视频创建失败响应: ' + errText.substring(0, 500));
            let errMsg;
            try { errMsg = JSON.parse(errText).error?.message; } catch { errMsg = ''; }
            throw new Error(errMsg || `视频任务创建失败 (${resp.status}): ${errText.substring(0, 200)}`);
        }
        return await resp.json();
    },

    /**
     * 火山引擎视频任务创建（POST /content_generation/tasks）
     * 支持 doldu-seedance 系列模型，含参考图片/视频/音频
     */
    async _volcengineCreateVideo({ model, prompt, image, images, resolution, ratio, duration, fps, seed, referenceImages, referenceVideos, referenceAudios, firstFrameUrl, lastFrameUrl }) {
        // 构建 content 数组
        const content = [];

        // 文本提示词
        if (prompt) {
            content.push({ type: 'text', text: prompt });
        }

        // 首帧参考图（标记为 first_frame）
        if (firstFrameUrl) {
            content.push({
                type: 'image_url',
                image_url: { url: firstFrameUrl },
                role: 'first_frame'
            });
        }

        // 尾帧参考图（标记为 last_frame）
        if (lastFrameUrl) {
            content.push({
                type: 'image_url',
                image_url: { url: lastFrameUrl },
                role: 'last_frame'
            });
        }

        // 参考图片（URL 数组）
        if (Array.isArray(referenceImages)) {
            referenceImages.forEach(url => {
                // 跳过已经是首帧/尾帧的图
                if (url === firstFrameUrl || url === lastFrameUrl) return;
                content.push({
                    type: 'image_url',
                    image_url: { url },
                    role: 'reference_image'
                });
            });
        }

        // 参考视频（URL 数组）
        if (Array.isArray(referenceVideos)) {
            referenceVideos.forEach(url => {
                content.push({
                    type: 'video_url',
                    video_url: { url },
                    role: 'reference_video'
                });
            });
        }

        // 参考音频（URL 数组）
        if (Array.isArray(referenceAudios)) {
            referenceAudios.forEach(url => {
                content.push({
                    type: 'audio_url',
                    audio_url: { url },
                    role: 'reference_audio'
                });
            });
        }

        // 图生视频：如果上传了本地图片（base64），先转成 URL 再发
        // 火山引擎目前要求图片通过 URL 引用，base64 需要先上传
        if (Array.isArray(images) && images.length > 0) {
            Logger.warn('[API/Volcengine] 火山引擎图生视频需要图片 URL，暂不支持直接传 base64。请通过参考图片 URL 传入。');
        } else if (image) {
            Logger.warn('[API/Volcengine] 火山引擎图生视频需要图片 URL，暂不支持直接传 base64。请通过参考图片 URL 传入。');
        }

        // 使用传入的比例，或默认 16:9
        const finalRatio = ratio || '16:9';

        const body = {
            model,
            content,
            generate_audio: true,
            resolution: resolution || '720p',
            ratio: finalRatio,
            duration: duration || 5,
            watermark: false
        };

        Logger.info(`[API/Volcengine] 视频任务创建, 模型=${model}, 分辨率=${body.resolution}, ratio=${ratio}, duration=${body.duration}s`);
        Logger.info(`[API/Volcengine] content 数组: ${content.length} 个元素 (text:${content.filter(c=>c.type==='text').length}, image:${content.filter(c=>c.type==='image_url').length}, video:${content.filter(c=>c.type==='video_url').length}, audio:${content.filter(c=>c.type==='audio_url').length})`);

        const platform = Config.getCurrentPlatformConfig();
        const endpoint = platform.videoEndpoint || '/content_generation/tasks';
        const resp = await fetch(this._url(endpoint), {
            method: 'POST',
            headers: this._headers(),
            body: JSON.stringify(body)
        });
        if (!resp.ok) {
            const errText = await resp.text().catch(() => '');
            Logger.error('[API/Volcengine] 视频创建失败响应: ' + errText.substring(0, 500));
            let errMsg;
            try {
                const errJson = JSON.parse(errText);
                errMsg = errJson.error?.message || errJson.error?.code || errJson.message;
            } catch {
                errMsg = '';
            }
            // 404 可能意味着未开通 content_generation 权限
            if (resp.status === 404) {
                throw new Error('API端点不存在或未开通 Seedance 视频生成权限。请确认：\n1. 已在方舟控制台开通 doubao-seedance 模型\n2. 已获得 Seedance 2.0 公测权限\n3. 申请链接: https://www.volcengine.com/contact/seedance2-0public');
            }
            throw new Error(errMsg || `视频任务创建失败 (${resp.status})`);
        }
        const result = await resp.json();
        Logger.success('[API/Volcengine] 视频任务创建成功, task_id=' + (result.id || 'unknown'));
        return result;
    },

    /**
     * 查询视频任务状态
     * GET /v1/video/generations/{task_id}
     */
    async getVideoTask(taskId) {
        const platform = Config.getCurrentPlatformConfig();
        // Agnes 平台：用 GET /agnesapi?video_id=<VIDEO_ID> 查询结果
        if (this._isAgnes()) {
            const resultPath = platform.videoResultEndpoint || '/agnesapi';
            const resp = await fetch(this._url(`${resultPath}?video_id=${encodeURIComponent(taskId)}`), {
                headers: this._headers()
            });
            if (!resp.ok) {
                const err = await resp.json().catch(() => ({}));
                throw new Error(err.error?.message || `查询任务状态失败 (${resp.status})`);
            }
            return await resp.json();
        }
        // 火山引擎平台：轮询 endpoint/{task_id}
        if (this._isVolcengine()) {
            const endpoint = platform.videoEndpoint || '/content_generation/tasks';
            const resp = await fetch(this._url(`${endpoint}/${taskId}`), {
                headers: this._headers()
            });
            if (!resp.ok) {
                const err = await resp.json().catch(() => ({}));
                throw new Error(err.error?.message || `查询任务状态失败 (${resp.status})`);
            }
            return await resp.json();
        }
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
    async pollVideoTask(taskId, onProgress, interval = 5000, timeout = 600000, signal) {
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
                throw new Error('视频生成超时，请稍后在历史记录中查看');
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
        const isAnthropic = Config.getPlatform() === 'custom' && Config.getCustomApiStandard() === 'anthropic';
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
        const isAnthropic = Config.getPlatform() === 'custom' && Config.getCustomApiStandard() === 'anthropic';
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
