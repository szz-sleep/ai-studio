/**
 * AI Studio - 多图上传工具（9宫格）
 * 供 redraw.js (i2i) 和 video.js (i2v) 共用
 */

const MAX_GRID_IMAGES = 9;

/**
 * 初始化一个9宫格上传区域
 * @param {string} gridId - 网格容器ID
 * @param {string} fileInputId - 隐藏的 file input ID
 * @param {string} tabName - 标签名（用于日志）
 * @param {object} callbacks
 * @param {function} callbacks.onImagesChange - 图片列表变化时回调
 */
function initUploadGrid(gridId, fileInputId, tabName, callbacks) {
    const grid = document.getElementById(gridId);
    const fileInput = document.getElementById(fileInputId);
    let images = []; // { base64, name, file }

    /** 渲染全部 9 格 */
    function render() {
        grid.innerHTML = '';
        for (let i = 0; i < MAX_GRID_IMAGES; i++) {
            const cell = document.createElement('div');
            cell.className = 'upload-grid-cell' + (images[i] ? ' has-image' : ' empty');

            if (images[i]) {
                const img = document.createElement('img');
                img.src = images[i].base64;
                img.alt = images[i].name;
                cell.appendChild(img);

                const label = document.createElement('span');
                label.className = 'cell-label';
                label.textContent = images[i].name;
                cell.appendChild(label);

                const del = document.createElement('button');
                del.className = 'cell-delete';
                del.innerHTML = '✕';
                del.title = '删除此图片';
                del.addEventListener('click', (e) => {
                    e.stopPropagation();
                    removeAt(i);
                });
                cell.appendChild(del);

                // 点击已有图片可替换
                cell.addEventListener('click', (e) => {
                    // 如果点的是删除按钮，不触发替换
                    if (e.target.closest('.cell-delete')) return;
                    replaceAt(i);
                });
            } else {
                cell.textContent = '+';
                cell.addEventListener('click', () => fillAt(i));
            }

            grid.appendChild(cell);
        }
    }

    /** 弹出文件选择器 */
    function openPicker() {
        return new Promise((resolve) => {
            fileInput.value = '';
            fileInput.onchange = () => {
                resolve(fileInput.files);
                fileInput.onchange = null;
            };
            fileInput.click();
        });
    }

    /** 点击某个空位，填入文件 */
    async function fillAt(index) {
        const files = await openPicker();
        if (!files || files.length === 0) return;
        const file = Array.from(files).find(f => f.type.startsWith('image/'));
        if (!file) { UI.toast('请选择图片文件', 'error'); return; }
        await readAndPlace(file, index);
    }

    /** 替换某一张已有图片 */
    async function replaceAt(index) {
        const files = await openPicker();
        if (!files || files.length === 0) return;
        const file = Array.from(files).find(f => f.type.startsWith('image/'));
        if (!file) { UI.toast('请选择图片文件', 'error'); return; }
        await readAndPlace(file, index);
    }

    /** 读取文件并放到指定格子 */
    function readAndPlace(file, index) {
        return new Promise((resolve) => {
            const limitBytes = Config.getUploadSizeBytes();
            const limitMB = Config.getUploadSizeMB();
            if (file.size > limitBytes) {
                UI.toast(`图片不能超过 ${limitMB}MB`, 'error');
                resolve();
                return;
            }
            Logger.info(`[${tabName}] 正在读取 ${(file.size / 1024 / 1024).toFixed(1)}MB 图片: ${file.name}`);
            const reader = new FileReader();
            reader.onload = function(e) {
                const base64 = e.target.result;
                images[index] = { base64, name: '', file };
                renumber();
                render();
                Logger.info(`[${tabName}] 已上传 ${images[index].name}`);
                if (callbacks.onImagesChange) callbacks.onImagesChange(getImages());
                resolve();
            };
            reader.readAsDataURL(file);
        });
    }

    /** 删除某张图片 */
    function removeAt(index) {
        if (!images[index]) return;
        const name = images[index].name;
        images[index] = null;
        renumber();
        render();
        Logger.info(`[${tabName}] 已删除 ${name}`);
        UI.toast(`已删除 ${name}`, '');
        if (callbacks.onImagesChange) callbacks.onImagesChange(getImages());
    }

    /** 重新编号 图片1、图片2…… */
    function renumber() {
        const valid = images.filter(Boolean);
        valid.forEach((img, i) => { img.name = `图片${i + 1}`; });
    }

    /** 获取当前有效图片数组 */
    function getImages() {
        return images.filter(Boolean);
    }

    /** 清空所有图片 */
    function clearAll() {
        images = [];
        render();
        if (callbacks.onImagesChange) callbacks.onImagesChange([]);
    }

    /** 外部拖拽多张图片 */
    function handleDrop(fileList) {
        const files = Array.from(fileList).filter(f => f.type.startsWith('image/'));
        if (files.length === 0) { UI.toast('请拖入图片文件', 'error'); return; }
        const total = getImages().length;
        const slotsLeft = MAX_GRID_IMAGES - total;
        if (slotsLeft <= 0) { UI.toast('最多9张图片，已满', 'error'); return; }
        const toAdd = files.slice(0, slotsLeft);
        // 找到第一个空位
        let si = 0;
        while (si < MAX_GRID_IMAGES && images[si]) si++;
        let pending = toAdd.length;
        toAdd.forEach((file, fi) => {
            // 找到下一个空位
            while (si < MAX_GRID_IMAGES && images[si]) si++;
            if (si >= MAX_GRID_IMAGES) return;
            const idx = si;
            readAndPlace(file, idx).then(() => {
                pending--;
                if (pending === 0 && callbacks.onImagesChange) {
                    callbacks.onImagesChange(getImages());
                }
            });
            si++;
        });
    }

    // 初始渲染
    images = new Array(MAX_GRID_IMAGES).fill(null);
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
            handleDrop(e.dataTransfer.files);
        }
    });

    return { getImages, clearAll };
}
