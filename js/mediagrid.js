/**
 * AI Studio - 多模态参考素材上传工具（9宫格）
 * 支持图片上传 + 视频/音频 URL 粘贴 + 右键标记角色
 * 供 video.js (t2v/i2v) 共用
 */

const MAX_MEDIA_ITEMS = 9;

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

                // 立即上传到临时托管，拿到 HTTP URL
                if (callbacks.onUpload) {
                    try {
                        const httpUrl = await callbacks.onUpload(dataUrl, file.name);
                        if (httpUrl && httpUrl.startsWith('http')) {
                            items[index].url = httpUrl;
                            // 保留 base64 供本地/自部署模型使用（不释放内存）
                            render();

                            // 说明：九宫格上传的素材仅用于本次生成，不再自动加入素材库
                            // （素材库只供火山素材引用，需用户主动保存才会入库）
                        }
                    } catch (e) {
                        Logger.warn(`[${tabName}] 自动上传失败: ${e.message}，使用本地数据`);
                    }
                }
                resolve();
            } catch (e) {
                Logger.warn(`[${tabName}] 文件处理失败: ${e.message}`);
                UI.toast(e.message || '文件处理失败', 'error');
                resolve();
            }
        });
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

    return { getItems, getMediaByType, getImages, clearAll, setItem, gridElement: grid, maxSlots: maxSlots };
}
