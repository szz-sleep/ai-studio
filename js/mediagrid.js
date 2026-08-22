/**
 * AI Studio - 多模态参考素材上传工具（9宫格）
 * 支持图片上传 + 视频/音频 URL 粘贴 + 右键标记角色
 * 供 video.js (t2v/i2v) 共用
 */

const MAX_MEDIA_ITEMS = 9;

/**
 * 用 XMLHttpRequest 把素材上传到临时托管(uguu.se)，并实时回报进度。
 * 相比 fetch，XHR 能拿到真实的 upload.onprogress 字节进度。
 *
 * 上传策略：
 *  - 超时设为 180 秒（覆盖绝大多数慢网大文件，实际基本够用）
 *  - 失败重试 3 次（超时/网络抖动时自动重试，避免一次失败就放弃）
 *  - 明确区分「上传被拒绝」(HTTP 非200 / success:false) 与「网络/超时」两类错误
 *
 * @param {string|File} dataUrl - base64 DataURL (data:mime;base64,...) 或 File 对象
 * @param {string} filename - 原始文件名
 * @param {function} onProgress - (percent:0-100) 进度回调（上传中实时调用）
 * @returns {Promise<string>} 公网 HTTP URL
 * @throws {Error} 失败时抛出，error.kind='rejected' | 'network' 用于区分失败类型
 */
async function uploadMediaToHost(dataUrl, filename, onProgress) {
    // 已是 HTTP URL，无需上传
    if (typeof dataUrl === 'string' && dataUrl.startsWith('http')) return dataUrl;

    let mimeType, safeName, blob;

    // —— 支持直接传 File 对象（素材库等场景）——
    if (typeof File !== 'undefined' && dataUrl instanceof File) {
        blob = dataUrl;
        mimeType = dataUrl.type || 'application/octet-stream';
        const origName = filename || dataUrl.name || 'file';
        const namePart = (origName.replace(/\.[^.]+$/, '') || 'file').replace(/[^a-zA-Z0-9._-]/g, '_');
        const ext = (origName.match(/\.\w+$/) || [''])[0];
        safeName = namePart.slice(-80) + ext;
    } else {
        // —— base64 DataURL 路径 ——
        if (!dataUrl || typeof dataUrl !== 'string') return dataUrl;
        const match = dataUrl.match(/^data:([^;]+);base64,(.+)$/);
        if (!match) return dataUrl;
        mimeType = match[1];
        const base64Data = match[2];
        const extMap = {
            'audio/mpeg': '.mp3', 'audio/mp3': '.mp3', 'audio/wav': '.wav',
            'audio/ogg': '.ogg', 'audio/mp4': '.m4a', 'audio/x-m4a': '.m4a',
            'video/mp4': '.mp4', 'video/webm': '.webm', 'video/quicktime': '.mov',
            'image/jpeg': '.jpg', 'image/png': '.png', 'image/webp': '.webp', 'image/gif': '.gif'
        };
        const ext = extMap[mimeType] || '.' + (mimeType.split('/')[1] || 'bin');
        safeName = (filename || 'file').replace(/[^a-zA-Z0-9._-]/g, '_') + ext;
        const binaryStr = atob(base64Data);
        const bytes = new Uint8Array(binaryStr.length);
        for (let i = 0; i < binaryStr.length; i++) bytes[i] = binaryStr.charCodeAt(i);
        blob = new Blob([bytes], { type: mimeType });
    }

    // 单次 XHR 上传；resolve(url) / reject(Error with kind)
    function uploadOnce() {
        return new Promise((resolve, reject) => {
            const xhr = new XMLHttpRequest();
            const fd = new FormData();
            fd.append('files[]', blob, safeName);

            // 180 秒超时：足够覆盖慢网大文件；无硬性上限，实际很少触发
            xhr.timeout = 180000;

            xhr.upload.onprogress = (e) => {
                if (e.lengthComputable && onProgress) {
                    onProgress(Math.round((e.loaded / e.total) * 100));
                }
            };

            xhr.onload = () => {
                if (xhr.status >= 200 && xhr.status < 300) {
                    try {
                        const res = JSON.parse(xhr.responseText);
                        if (res.success && res.files && res.files[0] && res.files[0].url) {
                            resolve(res.files[0].url);
                        } else {
                            const err = new Error('托管服务未返回素材地址（可能被拒绝）');
                            err.kind = 'rejected';
                            reject(err);
                        }
                    } catch (parseErr) {
                        const err = new Error('托管服务返回异常数据');
                        err.kind = 'rejected';
                        reject(err);
                    }
                } else {
                    const err = new Error(`上传被拒绝 (HTTP ${xhr.status})`);
                    err.kind = 'rejected';
                    reject(err);
                }
            };

            xhr.onerror = () => {
                const err = new Error('网络异常，无法连接上传服务器');
                err.kind = 'network';
                reject(err);
            };
            xhr.ontimeout = () => {
                const err = new Error('上传超时（网络过慢），已自动重试');
                err.kind = 'network';
                reject(err);
            };
            xhr.onabort = () => {
                const err = new Error('上传已中断');
                err.kind = 'network';
                reject(err);
            };

            xhr.open('POST', 'https://uguu.se/upload', true);
            xhr.send(fd);
        });
    }

    // 重试最多 3 次，退避递增
    let lastErr = null;
    for (let attempt = 0; attempt < 3; attempt++) {
        try {
            if (onProgress) onProgress(attempt === 0 ? 1 : 0); // 开始上传（重置进度条）
            const url = await uploadOnce();
            if (onProgress) onProgress(100);
            // 打印上传成功的公网 URL，便于排查引用是否正确
            Logger.info(`[上传托管] 上传成功: ${safeName} → ${url}`);
            return url;
        } catch (e) {
            lastErr = e;
            if (attempt < 2) {
                await new Promise(r => setTimeout(r, 1000 * (attempt + 1)));
            }
        }
    }
    throw lastErr || new Error('上传失败');
}

/**
 * 初始化一个多模态9宫格上传区域
 * @param {string} gridId - 网格容器ID
 * @param {string} fileInputId - 隐藏的 file input ID
 * @param {string} tabName - 标签名（用于日志）
 * @param {object} callbacks
 * @param {function} callbacks.onItemsChange - 素材列表变化时回调
 */
function initMediaGrid(gridId, fileInputId, tabName, callbacks) {
    const grid = document.getElementById(gridId);
    const fileInput = document.getElementById(fileInputId);
    const maxSlots = (callbacks && callbacks.maxSlots) ? callbacks.maxSlots : MAX_MEDIA_ITEMS;
    // items: [{ type:'image'|'video'|'audio', base64?, url?, name, role? }]
    let items = new Array(maxSlots).fill(null);

    /** 渲染全部 9 格 */
    function render() {
        grid.innerHTML = '';
        for (let i = 0; i < maxSlots; i++) {
            const cell = document.createElement('div');
            cell.className = 'upload-grid-cell' + (items[i] ? ' has-image' : ' empty');
            cell.dataset.index = i;

            if (items[i]) {
                const item = items[i];
                // 缩略图/图标
                if (item.type === 'image' && (item.base64 || item.url)) {
                    const img = document.createElement('img');
                    img.src = item.base64 || item.url;
                    img.alt = item.name || '图片';
                    cell.appendChild(img);
                } else if (item.type === 'video') {
                    const icon = document.createElement('div');
                    icon.className = 'cell-icon';
                    icon.textContent = '视频';
                    cell.appendChild(icon);
                } else if (item.type === 'audio') {
                    const icon = document.createElement('div');
                    icon.className = 'cell-icon';
                    icon.textContent = '音频';
                    cell.appendChild(icon);
                }

                // 名称标签
                const label = document.createElement('span');
                label.className = 'cell-label';
                const roleLabels = { first_frame: '首帧', last_frame: '尾帧', reference_image: '参考', reference_video: '参考', reference_audio: '参考' };
                const roleTag = item.role && roleLabels[item.role] ? ` [${roleLabels[item.role]}]` : '';
                label.textContent = (item.name || (item.type === 'video' ? '参考视频' : item.type === 'audio' ? '参考音频' : '图片')) + roleTag;
                cell.appendChild(label);

                // —— 上传状态反馈（进度条 / 失败原因），直接显示在格子上 ——
                if (item.status === 'uploading') {
                    // 半透明遮罩 + 进度条
                    const overlay = document.createElement('div');
                    overlay.className = 'cell-upload-overlay';
                    const bar = document.createElement('div');
                    bar.className = 'cell-upload-bar';
                    const fill = document.createElement('div');
                    fill.className = 'cell-upload-bar-fill';
                    fill.style.width = (item.progress || 0) + '%';
                    bar.appendChild(fill);
                    overlay.appendChild(bar);
                    const pct = document.createElement('div');
                    pct.className = 'cell-upload-text';
                    const p = item.progress || 0;
                    pct.textContent = `上传中 ${p}%`;
                    overlay.appendChild(pct);
                    cell.appendChild(overlay);
                } else if (item.status === 'failed') {
                    // 半透明遮罩 + 红色失败原因 + 重试按钮
                    const overlay = document.createElement('div');
                    overlay.className = 'cell-upload-overlay' + ' cell-upload-error';
                    const err = document.createElement('div');
                    err.className = 'cell-upload-error-text';
                    err.textContent = item.error || '上传失败';
                    overlay.appendChild(err);
                    const retry = document.createElement('button');
                    retry.className = 'cell-upload-retry';
                    retry.textContent = '重新上传';
                    retry.addEventListener('click', (e) => {
                        e.stopPropagation();
                        e.preventDefault();
                        // 让该格重新走一次上传流程（复用已选文件的提交逻辑）
                        handleMediaFileUploadItem(index);
                    });
                    overlay.appendChild(retry);
                    cell.appendChild(overlay);
                }

                // 删除按钮
                const del = document.createElement('button');
                del.className = 'cell-delete';
                del.innerHTML = 'X';
                del.title = '删除';
                del.addEventListener('click', (e) => {
                    e.stopPropagation();
                    removeAt(i);
                });
                cell.appendChild(del);

                // 右键菜单：标记角色
                cell.addEventListener('contextmenu', (e) => {
                    e.preventDefault();
                    e.stopPropagation();
                    if (item.type === 'image') {
                        showRoleMenu(i, e.clientX, e.clientY);
                    }
                });

                // 点击已有素材可替换
                cell.addEventListener('click', (e) => {
                    if (e.target.closest('.cell-delete')) return;
                    replaceAt(i);
                });
            } else {
                cell.textContent = '+';
                cell.addEventListener('click', (e) => {
                    uploadMedia(i);
                });
            }

            grid.appendChild(cell);
        }
    }

    /** 点击+号直接上传，自动识别文件类型 */
    async function uploadMedia(index) {
        const files = await openPicker('image/*,video/*,audio/*');
        if (!files || files.length === 0) return;
        const file = files[0];
        await handleMediaFile(file, index);
    }

    /** 根据文件类型自动处理（图片/视频/音频） */
    async function handleMediaFile(file, index) {
        const limitBytes = Config.getUploadSizeBytes();
        const limitMB = Config.getUploadSizeMB();
        let type;
        if (file.type.startsWith('image/')) type = 'image';
        else if (file.type.startsWith('video/')) type = 'video';
        else if (file.type.startsWith('audio/')) type = 'audio';
        else {
            // 根据扩展名反推
            const ext = file.name.split('.').pop()?.toLowerCase();
            if (['mp4','mov','webm','avi','mkv','m4v'].includes(ext)) type = 'video';
            else if (['mp3','wav','ogg','flac','aac','m4a','wma'].includes(ext)) type = 'audio';
            else type = 'image';
        }

        // 图片可在客户端自动缩放压缩；视频和音频仍执行原始大小限制。
        if (type !== 'image' && file.size > limitBytes) {
            UI.toast(`文件不能超过 ${limitMB}MB`, 'error');
            return;
        }

        // 自动重命名：图片1/图片2/音频1/音频2/视频1/视频2...
        const typeLabel = type === 'video' ? '视频' : type === 'audio' ? '音频' : '图片';
        const typeCount = items.filter(i => i && i.type === type).length + 1;
        const autoName = `${typeLabel}${typeCount}`;
        Logger.info(`[${tabName}] 读取${typeLabel}: ${file.name} → 重命名为 ${autoName} (${(file.size / 1024 / 1024).toFixed(1)}MB)`);
        return new Promise(async (resolve) => {
            try {
                let dataUrl;
                let uploadSize = file.size;
                let uploadMimeType = file.type;
                if (type === 'image') {
                    const prepared = await prepareImageForUpload(file);
                    dataUrl = prepared.dataUrl;
                    uploadSize = prepared.size;
                    uploadMimeType = prepared.mimeType;
                    if (prepared.compressed) {
                        Logger.info(`[${tabName}] 大图已自动压缩: ${(file.size / 1024 / 1024).toFixed(1)}MB → ${(uploadSize / 1024 / 1024).toFixed(1)}MB`);
                        UI.toast(`图片已自动压缩至 ${(uploadSize / 1024 / 1024).toFixed(1)}MB`, 'success');
                    }
                } else {
                    dataUrl = await new Promise((readResolve, readReject) => {
                        const reader = new FileReader();
                        reader.onload = () => readResolve(reader.result);
                        reader.onerror = () => readReject(reader.error || new Error('文件读取失败'));
                        reader.readAsDataURL(file);
                    });
                }

                items[index] = { type, base64: dataUrl, url: null, name: autoName };
                render();
                if (callbacks.onItemsChange) callbacks.onItemsChange(getItems());

                // 立即上传到临时托管，拿到 HTTP URL；在格子上实时显示进度 / 失败原因
                try {
                        // 实时进度回调：更新格子上的进度条与文字。仅更新 UI，不通知 onItemsChange
                        // （避免进度事件风暴刷屏——按钮状态只在 开始上传/成功/失败 时同步）
                        const onProgress = (pct) => {
                            items[index].status = 'uploading';
                            items[index].progress = pct;
                            render();
                        };
                        items[index].status = 'uploading';
                        items[index].progress = 0;
                        items[index].error = null;
                        render();
                        if (callbacks.onItemsChange) callbacks.onItemsChange(getItems());

                        let httpUrl;
                        // 优先使用内置 XHR 进度上传（否则回退到外部传入的 onUpload）
                        if (callbacks.onUploadFile) {
                            httpUrl = await callbacks.onUploadFile(dataUrl, file.name, onProgress);
                        } else if (callbacks.onUpload) {
                            httpUrl = await callbacks.onUpload(dataUrl, file.name);
                        } else {
                            httpUrl = await uploadMediaToHost(dataUrl, file.name, onProgress);
                        }

                        if (httpUrl && httpUrl.startsWith('http')) {
                            items[index].url = httpUrl;
                            items[index].status = 'success';
                            items[index].progress = 100;
                            items[index].error = null;
                            // 保留 base64 供本地/自部署模型使用（不释放内存）
                            render();
                            if (callbacks.onItemsChange) callbacks.onItemsChange(getItems());
                        }
                    } catch (e) {
                        // 明确区分「被拒绝」与「网络/超时」，直接显示在格子上
                        const isRejected = e && (e.kind === 'rejected' || (e.message && e.message.indexOf('拒绝') !== -1));
                        items[index].status = 'failed';
                        items[index].error = isRejected
                            ? (e && e.message ? e.message : '上传被拒绝') + '，请重试或更换素材'
                            : ((e && e.message ? e.message : '网络异常') + '，请检查网络后点击重试');
                        Logger.warn(`[${tabName}] 自动上传失败: ${items[index].error}`);
                        render();
                        if (callbacks.onItemsChange) callbacks.onItemsChange(getItems());
                    }
                resolve();
            } catch (e) {
                Logger.warn(`[${tabName}] 文件处理失败: ${e.message}`);
                UI.toast(e.message || '文件处理失败', 'error');
                resolve();
            }
        });
    }

    /**
     * 对已存在格子的素材重新上传（用于「重新上传」按钮）。
     * 复用已缓存的 base64，不重新打开文件选择器。
     */
    async function handleMediaFileUploadItem(index) {
        const item = items[index];
        if (!item || !item.base64) return;

        // 重置状态，重新走一次上传
        try {
            const onProgress = (pct) => {
                items[index].status = 'uploading';
                items[index].progress = pct;
                render();
            };
            items[index].status = 'uploading';
            items[index].progress = 0;
            items[index].error = null;
            render();
            if (callbacks.onItemsChange) callbacks.onItemsChange(getItems());

            let httpUrl;
            if (callbacks.onUploadFile) {
                httpUrl = await callbacks.onUploadFile(item.base64, item.name, onProgress);
            } else if (callbacks.onUpload) {
                httpUrl = await callbacks.onUpload(item.base64, item.name);
            } else {
                httpUrl = await uploadMediaToHost(item.base64, item.name, onProgress);
            }

            if (httpUrl && httpUrl.startsWith('http')) {
                items[index].url = httpUrl;
                items[index].status = 'success';
                items[index].progress = 100;
                items[index].error = null;
                render();
                if (callbacks.onItemsChange) callbacks.onItemsChange(getItems());
            } else {
                items[index].status = 'failed';
                items[index].error = '未获取到公网地址，请重新上传';
                render();
                if (callbacks.onItemsChange) callbacks.onItemsChange(getItems());
            }
        } catch (e) {
            const isRejected = e && (e.kind === 'rejected' || (e.message && e.message.indexOf('拒绝') !== -1));
            items[index].status = 'failed';
            items[index].error = isRejected
                ? (e && e.message ? e.message : '上传被拒绝')
                : ((e && e.message ? e.message : '网络异常') + '，请检查网络');
            render();
            if (callbacks.onItemsChange) callbacks.onItemsChange(getItems());
        }
    }

    /** 显示角色标记菜单（仅图片） */
    function showRoleMenu(index, x, y) {
        removeExistingMenu();
        const item = items[index];
        if (!item || item.type !== 'image') return;
        const menu = document.createElement('div');
        menu.className = 'context-menu';
        menu.style.left = x + 'px';
        menu.style.top = y + 'px';
        const currentRole = item.role || '';
        menu.innerHTML = `
            <div class="context-menu-item ${currentRole === 'first_frame' ? 'active' : ''}" data-role="first_frame">标记为首帧</div>
            <div class="context-menu-item ${currentRole === 'last_frame' ? 'active' : ''}" data-role="last_frame">标记为尾帧</div>
            <div class="context-menu-item ${currentRole === 'reference_image' || !currentRole ? 'active' : ''}" data-role="reference_image">普通参考图</div>
            <div class="context-menu-separator"></div>
            <div class="context-menu-item" data-role="">清除标记</div>
        `;
        menu.addEventListener('click', (e) => {
            const role = e.target.closest('.context-menu-item')?.dataset.role;
            removeExistingMenu();
            if (role !== undefined && items[index]) {
                items[index].role = role || undefined;
                render();
                if (callbacks.onItemsChange) callbacks.onItemsChange(getItems());
            }
        });
        document.body.appendChild(menu);
        setTimeout(() => {
            document.addEventListener('click', function closeMenu() {
                removeExistingMenu();
                document.removeEventListener('click', closeMenu);
            });
        }, 0);
    }

    function removeExistingMenu() {
        document.querySelectorAll('.context-menu').forEach(m => m.remove());
    }

    /** 弹出文件选择器 */
    function openPicker(accept) {
        return new Promise((resolve) => {
            fileInput.value = '';
            fileInput.accept = accept || 'image/*';
            fileInput.onchange = () => {
                resolve(fileInput.files);
                fileInput.onchange = null;
            };
            fileInput.click();
        });
    }

    /** 替换某个素材（点击已有素材直接打开文件选择器替换） */
    async function replaceAt(index) {
        await uploadMedia(index);
    }

    /** 删除某个素材 */
    function removeAt(index) {
        if (!items[index]) return;
        const name = items[index].name;
        items[index] = null;
        render();
        Logger.info(`[${tabName}] 已删除 ${name}`);
        if (callbacks.onItemsChange) callbacks.onItemsChange(getItems());
    }

    /** 获取所有有效素材 */
    function getItems() {
        return items.filter(Boolean);
    }

    /**
     * 检查是否存在未就绪的素材（上传中或上传失败）。
     * 生成前必须调用：上传没完成（uploading）或失败（failed）都不能生成。
     * @returns {{ hasUploading: boolean, hasFailed: boolean, uploadingNames: string[], failedNames: string[] }}
     */
    function checkUnready() {
        const uploadingNames = [];
        const failedNames = [];
        for (const item of items) {
            if (!item) continue;
            if (item.status === 'uploading') uploadingNames.push(item.name || '素材');
            else if (item.status === 'failed') failedNames.push(item.name || '素材');
        }
        return {
            hasUploading: uploadingNames.length > 0,
            hasFailed: failedNames.length > 0,
            uploadingNames,
            failedNames
        };
    }

    /** 获取指定类型的素材（兼容旧版 getImages） */
    function getMediaByType(type) {
        return items.filter(i => i && i.type === type);
    }

    /** 获取所有图片（兼容旧版 getImages） */
    function getImages() {
        return getMediaByType('image');
    }

    /** 清空所有素材 */
    function clearAll() {
        items = new Array(MAX_MEDIA_ITEMS).fill(null);
        render();
        if (callbacks.onItemsChange) callbacks.onItemsChange([]);
    }

    // 初始渲染
    render();

    // 支持拖拽到整个网格
    grid.addEventListener('dragover', (e) => {
        e.preventDefault();
        grid.style.borderColor = 'var(--accent)';
    });
    grid.addEventListener('dragleave', () => {
        grid.style.borderColor = '';
    });
    grid.addEventListener('drop', (e) => {
        e.preventDefault();
        grid.style.borderColor = '';
        if (e.dataTransfer.files.length > 0) {
            const files = Array.from(e.dataTransfer.files);
            const slotsLeft = MAX_MEDIA_ITEMS - getItems().length;
            if (slotsLeft <= 0) { UI.toast('最多9个素材，已满', 'error'); return; }
            const toAdd = files.slice(0, slotsLeft);
            let si = 0;
            toAdd.forEach(file => {
                while (si < MAX_MEDIA_ITEMS && items[si]) si++;
                if (si >= MAX_MEDIA_ITEMS) return;
                const idx = si;
                handleMediaFile(file, idx);
                si++;
            });
        }
    });

    /** 直接设置指定索引的素材（用于素材库等外部调用） */
    function setItem(index, item) {
        if (index < 0 || index >= maxSlots) return;
        items[index] = item;
        render();
        if (callbacks.onItemsChange) callbacks.onItemsChange(getItems());
    }

    return { getItems, getMediaByType, getImages, clearAll, setItem, checkUnready, gridElement: grid, maxSlots: maxSlots };
}
