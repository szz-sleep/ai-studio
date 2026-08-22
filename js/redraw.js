/**
 * AI Studio - 图生图模块
 * 支持多图上9宫格上传，所有图片 + 提示词 一次发给模型（多图融合）
 */

const RedrawModule = {
    /**
     * 当前上传网格控制器
     */
    uploader: null,

    /**
     * 用于取消的 AbortController
     */
    abortController: null,

    /**
     * 初始化图生图面板
     */
    /**
     * 校验是否为有效的火山素材库 assetId（local_/temp_ 前缀不是火山 assetId）
     */
    _validAssetId(id) {
        return !!(id && typeof id === 'string' && !id.startsWith('local_') && !id.startsWith('temp_'));
    },

    /**
     * 绑定素材库按钮到图生图九宫格（复用 video 的多模态模式）
     */
    _bindMaterialLibBtn() {
        const btn = document.getElementById('i2iOpenMaterialLibBtn');
        if (!btn || typeof MaterialLib === 'undefined') return;
        btn.addEventListener('click', () => {
            MaterialLib.openPicker((item) => {
                const uploader = this.uploader;
                if (!uploader) return;
                const items = uploader.getItems?.() || [];
                const maxSlots = uploader.maxSlots || 9;
                if (items.length >= maxSlots) {
                    UI.toast(`最多${maxSlots}个素材，已满`, 'error');
                    return;
                }
                const grid = uploader.gridElement;
                if (!grid) return;
                const emptyCell = grid.querySelector('.upload-grid-cell.empty');
                if (!emptyCell) {
                    UI.toast(`最多${maxSlots}个素材，已满`, 'error');
                    return;
                }
                const index = parseInt(emptyCell.dataset.index);
                if (isNaN(index)) return;
                if (uploader.setItem) {
                    const validAssetId = this._validAssetId(item.id) ? item.id : null;
                    uploader.setItem(index, {
                        type: item.type || 'image',
                        base64: null,
                        url: item.url,
                        assetId: validAssetId,
                        sourceUrl: item.sourceUrl || item.url,
                        name: item.name || '素材'
                    });
                    Logger.info(`[图生图] 素材库: ${item.name}${validAssetId ? ` (assetId: ${validAssetId})` : ` (${item.url})`}`);
                    UI.toast('已添加到素材区', 'success');
                }
            }, 'image');
        });
    },

    /**
     * 初始化图生图面板
     */
    init() {
        // 初始化9宫格上传（复用 mediagrid：图片自动托管到公网，支持 assetId 素材库引用）
        this.uploader = initMediaGrid('i2iUploadGrid', 'i2iFileInput', '图生图', {
            onItemsChange: (items) => {
                if (items.length === 0) {
                    Logger.info('[图生图] 已无图片');
                } else {
                    Logger.info(`[图生图] 当前 ${items.length} 张图片`);
                }
            },
            // 选文件后自动上传到 uguu.se 拿公网 URL，避免请求体过大(413)
            onUpload: async (dataUrl, fileName) => {
                return await RedrawModule._uploadToTempHost(dataUrl, fileName);
            }
        });

        // 素材库按钮
        this._bindMaterialLibBtn();

        // 比例按钮
        const ratioBtns = document.querySelectorAll('#i2iRatio .ratio-btn');
        ratioBtns.forEach(btn => {
            btn.addEventListener('click', () => {
                ratioBtns.forEach(b => b.classList.remove('active'));
                btn.classList.add('active');
            });
        });

        // 生成按钮
        document.getElementById('i2iGenerateBtn').addEventListener('click', () => this.generate());
    },

    /**
     * 上传 base64 DataURL 到 uguu.se 获取临时公网 URL（与 video 模块一致）
     * @param {string} dataUrl - data:image/jpeg;base64,...
     * @param {string} filename
     * @returns {Promise<string>} 公网 URL，失败降级返回原 dataUrl
     */
    async _uploadToTempHost(dataUrl, filename) {
        if (!dataUrl || dataUrl.startsWith('http')) return dataUrl;
        const match = dataUrl.match(/^data:([^;]+);base64,(.+)$/);
        if (!match) return dataUrl;

        const mimeType = match[1];
        const base64Data = match[2];
        const extMap = {
            'image/jpeg': '.jpg', 'image/jpg': '.jpg', 'image/png': '.png',
            'image/webp': '.webp', 'image/gif': '.gif', 'image/bmp': '.bmp'
        };
        const ext = extMap[mimeType] || '.' + (mimeType.split('/')[1] || 'bin');
        const safeName = (filename || 'image').replace(/[^a-zA-Z0-9._-]/g, '_') + ext;

        try {
            Logger.info(`[图生图] 正在上传 ${safeName} 到临时托管...`);
            const binaryStr = atob(base64Data);
            const bytes = new Uint8Array(binaryStr.length);
            for (let i = 0; i < binaryStr.length; i++) bytes[i] = binaryStr.charCodeAt(i);
            const blob = new Blob([bytes], { type: mimeType });

            async function uploadOnce() {
                const fd = new FormData();
                fd.append('files[]', blob, safeName);
                const controller = new AbortController();
                const timeoutId = setTimeout(() => controller.abort(), 45000);
                try {
                    const r = await fetch('https://uguu.se/upload', {
                        method: 'POST',
                        body: fd,
                        signal: controller.signal
                    });
                    if (!r.ok) throw new Error(`HTTP ${r.status}`);
                    return r;
                } finally {
                    clearTimeout(timeoutId);
                }
            }

            let resp = null;
            let lastErr = null;
            for (let attempt = 0; attempt < 3; attempt++) {
                try {
                    resp = await uploadOnce();
                    break;
                } catch (e) {
                    lastErr = e;
                    Logger.warn(`[图生图] 上传第 ${attempt + 1} 次失败(${e.message})，${attempt < 2 ? '重试中...' : '放弃'}`);
                    if (attempt < 2) await new Promise(r => setTimeout(r, 1000 * (attempt + 1)));
                }
            }

            if (!resp) {
                Logger.warn(`[图生图] 托管上传失败: ${lastErr?.message || '未知'}`);
                return dataUrl;
            }

            const result = await resp.json();
            if (result.success && result.files && result.files[0] && result.files[0].url) {
                const httpUrl = result.files[0].url;
                Logger.info(`[图生图] 托管成功: ${httpUrl}`);
                return httpUrl;
            }
            Logger.warn('[图生图] 托管返回异常，降级使用原 base64');
            throw new Error('素材托��上传异常（图生图需要公网图片地址），请稍后重试');
        } catch (e) {
            Logger.warn(`[图生图] 托管上传异常: ${e.message}`);
            throw new Error(`图片无法上传到公网托管，火山引擎不支持 base64 图片。请检查网络后重试`);
        }
    },

    /**
     * 根据选中的分辨率和比例计算实际像素尺寸
     */
    getSelectedSize() {
        const ratio = document.querySelector('#i2iRatio .ratio-btn.active');
        const resolution = document.getElementById('i2iResolution')?.value || '720p';
        const ratioKey = ratio ? ratio.dataset.ratio : '16:9';
        const sizeMap = RESOLUTION_SIZE_MAP[resolution];
        return (sizeMap && sizeMap[ratioKey]) || '1920x1920';
    },

    /**
     * 获取当前选中的分辨率
     */
    getSelectedResolution() {
        return document.getElementById('i2iResolution')?.value || '720p';
    },

    /**
     * 生成图生图 - 所有图片+提示词一次发给模型（多图融合）
     */
    async generate() {
        const images = this.uploader.getImages();
        if (images.length === 0) {
            UI.toast('请先上传参考图片', 'error');
            return;
        }

        const prompt = document.getElementById('i2iPrompt').value.trim();
        if (!prompt) {
            UI.toast('请输入修改描述', 'error');
            return;
        }

        const model = document.getElementById('i2iModel').value;
        if (!model) {
            UI.toast('请选择模型', 'error');
            return;
        }

        const size = this.getSelectedSize();

        const btn = document.getElementById('i2iGenerateBtn');
        const resultArea = document.getElementById('i2iResult');

        btn.disabled = true;
        btn.textContent = '提交中...';

        Logger.info(`[图生图] 开始, 模型=${model}, 分辨率=${this.getSelectedResolution()}, 尺寸=${size}, 图片数=${images.length}`);
        Logger.req(`提示词: "${prompt.substring(0, 100)}${prompt.length > 100 ? '...' : ''}"`);

        UI.showLoading('正在生成图生图...');

        // 创建 AbortController 用于取消
        this.abortController = new AbortController();
        UI.showCancelBtn(() => {
            this.abortController.abort();
            Logger.warn('用户取消了图生图');
            UI.toast('已取消图生图', 'warn');
        });

        // 清空上次结果
        resultArea.innerHTML = '';

       try {
           // 收集所有参考图：素材库选中的用 asset://<id> 引用（火山素材库，免上传）；普通上传的走已托管的公网 URL
           const imageList = [];
           const items = this.uploader.getItems ? this.uploader.getItems() : this.uploader.getImages();
           for (const img of items) {
               if (img.type && img.type !== 'image') continue;
               // 素材库选中的：带火山 assetId → asset:// 引用
               if (this._validAssetId(img.assetId)) {
                   imageList.push('asset://' + img.assetId);
                   Logger.info(`[图生图] 素材库引用: asset://${img.assetId}`);
                   continue;
               }
               // 普通上传：mediagrid 已自动托管，/或直接取 url
               const url = img.url || img.base64 || '';
               if (!url) {
                   UI.toast('存在无效图片，请移除后重试', 'error');
                   Logger.warn('[图生图] 发现无 url 且无 base64 的图片项');
                   throw new Error('无效图片');
               }
               imageList.push(url.startsWith('data:') ? await this._uploadToTempHost(url, img.name || 'image') : url);
               Logger.info(`[图生图] 参考图: ${img.name || 'image'} -> ${url.startsWith('data:') ? '(已托管)' : url.substring(0, 80)}`);
           }

           Logger.req(`[图生图] 发送 ${imageList.length} 张参考图 + 提示词`);
           imageList.forEach((u, i) => Logger.info(`[图生图] 图${i + 1}: ${u.substring(0, 90)}`));

           const selRatio = document.querySelector('#i2iRatio .ratio-btn.active')?.dataset.ratio || '16:9';
           const resolution = this.getSelectedResolution();
           const result = await API.generateImageEdit({
               prompt,
               model,
               size,
               images: imageList,
               ratio: selRatio,
               qualityLabel: resolution,
               signal: this.abortController.signal
           });

            Logger.req(`[图生图] API 返回状态: ${result.code || 200}`);
            Logger.success(`[图生图] 生成成功`);

            // 展示结果
            if (result.data && result.data.length > 0) {
                const item = result.data[0];
                const url = item.url || (item.b64_json ? `data:image/png;base64,${item.b64_json}` : '');

                if (url) {
                    const filename = `aistudio-redraw-${Date.now()}.png`;
                    const div = document.createElement('div');
                    div.className = 'result-item';
                    div.innerHTML = `
                        <div class="result-subtitle">图生图结果</div>
                        <img src="${url}" alt="图生图结果">
                        <div class="result-actions">
                            <button class="result-action-btn view-btn" data-url="${url}">🔍 查看</button>
                            <button class="result-action-btn download-btn" data-url="${url}" data-filename="${filename}">下载</button>
                        </div>
                    `;
                    div.querySelector('.view-btn').addEventListener('click', () => {
                        UI.previewImage(url);
                    });
                    div.querySelector('.download-btn').addEventListener('click', () => {
                        UI.downloadFile(url, filename);
                    });
                    resultArea.appendChild(div);

                    History.add({
                        type: 'image',
                        url,
                        prompt: `[图生图] ${prompt.substring(0, 150)}`,
                        model,
                        time: Date.now(),
                        autosave: true
                    });

                    UI.toast('图生图成功！', 'success');
                } else {
                    Logger.error(`[图生图] 未返回图片数据`);
                    resultArea.innerHTML = this._createErrorCard('未返回图片数据');
                    UI.toast('生成失败', 'error');
                }
            } else {
                Logger.error(`[图生图] data 数组为空`);
                resultArea.innerHTML = this._createErrorCard('未返回图片数据');
                UI.toast('生成失败', 'error');
            }
        } catch (err) {
            if (err.name === 'AbortError') {
                Logger.warn('用户取消了图生图');
            } else {
                const msg = err.message || '';
                // 针对模型不支持图片生成的友好提示
                if (msg.includes('image generation is only supported') || msg.includes('not valid')) {
                    const friendlyMsg = '当前选中的模型不支持图片生成，请在模型下拉列表中选择其他模型（如图片类模型）后重试。';
                    Logger.error(`[图生图] 模型不支持: ${msg}`);
                    resultArea.innerHTML = this._createErrorCard(friendlyMsg);
                    UI.toast('当前模型不支持图片生成，请换一个模型', 'error', 6000);
                } else {
                    Logger.error(`[图生图] 生成失败: ${msg}`);
                    resultArea.innerHTML = this._createErrorCard(msg);
                    UI.toast(`生成失败: ${msg}`, 'error');
                }
            }
        } finally {
            btn.disabled = false;
            btn.textContent = '图生图';
            UI.hideLoading();
            UI.hideCancelBtn();
            this.abortController = null;
        }
    },

    /**
     * 创建错误卡片
     */
    _createErrorCard(message) {
        return `
            <div class="result-item result-item-error" style="border:1px solid var(--accent-border);background:var(--accent-soft);">
                <div style="text-align:center;padding:20px;color:var(--red);">
                    <div style="font-size:14px;margin-bottom:6px;">图生图失败</div>
                    <div style="font-size:12px;color:var(--text-muted);">${message}</div>
                </div>
            </div>
        `;
    }
};
