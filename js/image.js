/**
 * AI Studio - 文生图模块
 */

// ===== 尺寸计算（双层：模型参数优先，标准阶梯兜底） =====
// 标准分辨率阶梯：短边像素；16:9/9:16 使用精确标准尺寸（横竖自动切换）
const RES_PRESETS = {
    '480P':  { short: 480,  land: [854, 480],   port: [480, 854] },
    '720P':  { short: 720,  land: [1280, 720],  port: [720, 1280] },
    '1080P': { short: 1080, land: [1920, 1080], port: [1080, 1920] },
    '2K':    { short: 1440, land: [2560, 1440], port: [1440, 2560] },
    '4K':    { short: 2160, land: [3840, 2160], port: [2160, 3840] },
};

// 已知模型的生成参数（自动匹配层）：按模型 id 正则匹配；匹配不到的模型走标准阶梯
// sizes 有值 → 模型只支持固定尺寸；min/max → 约束 WxH 计算结果（超限自动升降档）
const MODEL_IMAGE_CAPS = [
    {
        match: /seedream[-_]?4/i, label: 'Seedream 4.0',
        minSide: 720, maxSide: 4096, minPixels: 1280 * 720, maxPixels: 4096 * 4096,
    },
    {
        match: /seedream[-_]?3|doubao-seedream/i, label: 'Seedream 3.x',
        minSide: 512, maxSide: 4096, minPixels: 3686400, maxPixels: 4096 * 4096,
    },
    {
        // MUX 等中转的 gpt-image 系列：接受任意 WxH（1024x1024 ~ 3840x2160），
        // 比例直接用标准阶梯的精确宽高控制；-1K 结尾的型号上限 1024
        match: /gpt-image/i, label: 'GPT Image',
        minSide: 512, minPixels: 512 * 512,
        maxSideFor(model) { return /-1k$/i.test(String(model || '')) ? 1024 : 4096; },
    },
    {
        match: /qwen-image|wanx/i, label: '通义万相',
        minSide: 512, maxSide: 2048, minPixels: 512 * 512, maxPixels: 2048 * 2048,
    },
];

const ImageSize = {
    /** 解析比例字符串 '16:9' → 宽高比数值 */
    _aspect(ratio) {
        const m = String(ratio || '').match(/^(\d+(?:\.\d+)?)\s*[:\/]\s*(\d+(?:\.\d+)?)$/);
        return m ? Number(m[1]) / Number(m[2]) : 16 / 9;
    },
    /** 偶数取整（编码器友好） */
    _even(n) { return Math.max(2, Math.round(n / 2) * 2); },
    /**
     * 计算实际尺寸
     * @returns {{size: string, preset: string, bumped: string|null, caps: object|null}}
     */
    compute(model, resolution, ratio) {
        const resKey = String(resolution || '720P').toUpperCase();
        const preset = RES_PRESETS[resKey] || RES_PRESETS['720P'];
        let usedKey = RES_PRESETS[resKey] ? resKey : '720P';
        const caps = MODEL_IMAGE_CAPS.find((c) => c.match.test(String(model || ''))) || null;

        // 模型只支持固定尺寸 → 直接用
        if (caps && caps.sizes) {
            const fixed = caps.sizes[String(ratio)] || caps.sizes['1:1'] || '1024x1024';
            return { size: fixed, preset: usedKey, bumped: null, caps };
        }

        // 标准阶梯：16:9/9:16 精确标准尺寸；其他比例：高度 = 阶梯短边值
        const ar = this._aspect(ratio);
        const is169 = Math.abs(ar - 16 / 9) < 0.01;
        const is916 = Math.abs(ar - 9 / 16) < 0.01;
        const sizeFor = (key) => {
            const p = RES_PRESETS[key];
            if (is169) return [p.land[0], p.land[1]];
            if (is916) return [p.port[0], p.port[1]];
            return [this._even(p.short * ar), p.short];
        };
        let [w, h] = sizeFor(usedKey);

        // 模型约束：像素不足自动升档，边长钳制
        let bumped = null;
        if (caps) {
            if (caps.minPixels && w * h < caps.minPixels) {
                const allKeys = Object.keys(RES_PRESETS);
                const ok = allKeys.find((k) => { const [a, b] = sizeFor(k); return a * b >= caps.minPixels; });
                if (ok && ok !== usedKey) { usedKey = ok; bumped = ok; [w, h] = sizeFor(ok); }
            }
            if (caps.minSide) {
                const s = Math.min(w, h);
                if (s < caps.minSide) { const k = caps.minSide / s; w = this._even(w * k); h = this._even(h * k); }
            }
            const maxSide = caps.maxSideFor ? caps.maxSideFor(model) : caps.maxSide;
            if (maxSide) { w = Math.min(w, maxSide); h = Math.min(h, maxSide); }
            if (caps.maxPixels && w * h > caps.maxPixels) {
                const k = Math.sqrt(caps.maxPixels / (w * h)); w = this._even(w * k); h = this._even(h * k);
            }
        }
        return { size: `${w}x${h}`, preset: usedKey, bumped, caps };
    },
};

// 兼容旧代码的全局映射（保留但不再使用）
const RESOLUTION_SIZE_MAP = null;

const ImageModule = {
    /**
     * 初始化文生图面板
     */
    init() {
        // 比例按钮
        const ratioBtns = document.querySelectorAll('#t2iRatio .ratio-btn');
        ratioBtns.forEach(btn => {
            btn.addEventListener('click', () => {
                ratioBtns.forEach(b => b.classList.remove('active'));
                btn.classList.add('active');
            });
        });

        // 生成按钮
        document.getElementById('t2iGenerateBtn').addEventListener('click', () => this.generate());
    },

    /**
     * 根据选中的模型/分辨率/比例计算实际像素尺寸
     */
    getSelectedSize(model) {
        const ratio = document.querySelector('#t2iRatio .ratio-btn.active');
        const resolution = document.getElementById('t2iResolution')?.value || '720P';
        const ratioKey = ratio ? ratio.dataset.ratio : '16:9';
        return ImageSize.compute(model, resolution, ratioKey);
    },

    /**
     * 获取当前选中的分辨率
     */
    getSelectedResolution() {
        return (document.getElementById('t2iResolution')?.value || '720P').toUpperCase();
    },

    /**
     * 生成图片
     */
    async generate() {
        const prompt = document.getElementById('t2iPrompt').value.trim();
        if (!prompt) {
            UI.toast('请输入画面描述', 'error');
            return;
        }

        const model = document.getElementById('t2iModel').value;
        if (!model) {
            UI.toast('请选择模型', 'error');
            return;
        }

        const sel = this.getSelectedSize(model);
        const size = sel.size;
        if (sel.bumped) {
            UI.toast(`${sel.caps && sel.caps.label || model} 对该比例要求更高像素，已自动改用 ${sel.bumped}`, 'warn', 6000);
        }

        const n = parseInt(document.getElementById('t2iCount').value);
        const quality = document.getElementById('t2iQuality').value;
        const style = document.getElementById('t2iStyle').value;

        const btn = document.getElementById('t2iGenerateBtn');
        btn.disabled = true;
        btn.textContent = '生成中...';

        Logger.info(`[文生图] 开始生成, 模型=${model}, 分辨率=${this.getSelectedResolution()}, 尺寸=${size}, 数量=${n}`);
        Logger.req(`prompt: "${prompt.substring(0, 80)}${prompt.length > 80 ? '...' : ''}"`);

        UI.showLoading('正在生成图片...');

        // 创建 AbortController 用于取消
        const abortController = new AbortController();
        UI.showCancelBtn(() => {
            abortController.abort();
            Logger.warn('用户取消了生成');
            UI.toast('已取消生成', 'warn');
        });

        try {
            const resultArea = document.getElementById('t2iResult');
            resultArea.innerHTML = '';

           let imageUrls = [];

            const selRatio = document.querySelector('#t2iRatio .ratio-btn.active')?.dataset.ratio || '16:9';
            const resolution = this.getSelectedResolution();
            const apiOptions = { prompt, model, size, n: 1, quality, style, ratio: selRatio, qualityLabel: resolution, signal: abortController.signal };

            // n > 1 时并行请求，避免后端不支持批量
            if (n > 1) {
                Logger.info(`[文生图] 批量 ${n} 张，并行请求...`);
                UI.updateLoading(`正在生成 ${n} 张图片 (1/${n})...`);

                const requests = [];
                for (let i = 0; i < n; i++) {
                    requests.push(API.generateImage(apiOptions));
                }

                // Promise.allSettled 避免某一张失败导致全部失败
                const results = await Promise.allSettled(requests);
                for (const res of results) {
                    if (res.status === 'fulfilled' && res.value?.data?.length > 0) {
                        const item = res.value.data[0];
                        const url = item.url || (item.b64_json ? `data:image/png;base64,${item.b64_json}` : '');
                        if (url) imageUrls.push(url);
                    }
                }
                Logger.success(`批量完成，成功获取 ${imageUrls.length}/${n} 张`);
            } else {
                const result = await API.generateImage(apiOptions);
                if (result.data && result.data.length > 0) {
                    result.data.forEach(item => {
                        const url = item.url || (item.b64_json ? `data:image/png;base64,${item.b64_json}` : '');
                        if (url) imageUrls.push(url);
                    });
                }
                Logger.success(`单张生成完成`);
            }

            // 展示结果
            if (imageUrls.length > 0) {
                imageUrls.forEach((url, idx) => {
                    const div = document.createElement('div');
                    div.className = 'result-item';
                    const filename = `aistudio-image-${Date.now()}-${idx}.png`;
                    div.innerHTML = `
                        <img src="${url}" alt="生成结果${idx + 1}">
                        <div class="result-actions">
                            <button class="result-action-btn view-btn" data-url="${url}">🔍 查看</button>
                            <button class="result-action-btn download-btn" data-url="${url}" data-filename="${filename}">下载</button>
                        </div>
                    `;
                    // 点击查看（灯箱预览）
                    div.querySelector('.view-btn').addEventListener('click', () => {
                        UI.previewImage(url);
                    });
                    // 点击下载（fetch+blob 可靠下载）
                    div.querySelector('.download-btn').addEventListener('click', () => {
                        UI.downloadFile(url, filename);
                    });
                    resultArea.appendChild(div);

                    History.add({
                        type: 'image',
                        url: url,
                        prompt: prompt,
                        model: model,
                        time: Date.now(),
                        autosave: true
                    });
                });
                UI.toast(`成功生成 ${imageUrls.length} 张图片！`, 'success');
            } else {
                UI.toast('未返回图片数据', 'error');
            }
        } catch (err) {
            if (err.name === 'AbortError') {
                Logger.warn('[文生图] 用户取消了生成');
                return;
            }
            Logger.error(`[文生图] 失败: ${err.message}`);
            // 针对 Seedream 尺寸不足的错误给出友好提示
            if (err.message.includes('image size must be at least')) {
                UI.toast('请选择更高的分辨率（720p 或以上）以满足模型要求', 'error', 6000);
            } else if (err.message.includes('image generation is only supported') || err.message.includes('not valid')) {
                UI.toast('当前模型不支持图片生成，请在模型下拉列表中换一个模型', 'error', 6000);
            } else {
                UI.toast(err.message, 'error');
            }
        } finally {
            btn.disabled = false;
            btn.textContent = '生成图片';
            UI.hideLoading();
        }
    }
};
