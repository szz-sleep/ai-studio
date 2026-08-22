/**
 * AI Studio - 多图上传工具（9宫格）
 * 供 redraw.js (i2i) 和 video.js (i2v) 共用
 */

const MAX_GRID_IMAGES = 9;

/**
 * 为模型接口准备图片。
 * 大图会限制最长边并压缩为 JPEG，避免 Base64 膨胀后导致上传或请求失败。
 * @param {File} file
 * @param {object} [options]
 * @returns {Promise<{dataUrl:string, size:number, mimeType:string, compressed:boolean}>}
 */
async function prepareImageForUpload(file, options = {}) {
    const maxDimension = options.maxDimension || 3840;
    const configuredLimit = Config.getUploadSizeBytes();
    const targetBytes = Math.min(options.targetBytes || 8 * 1024 * 1024, configuredLimit);

    const readAsDataUrl = (input) => new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(reader.result);
        reader.onerror = () => reject(reader.error || new Error('图片读取失败'));
        reader.readAsDataURL(input);
    });

    const objectUrl = URL.createObjectURL(file);
    try {
        const img = await new Promise((resolve, reject) => {
            const element = new Image();
            element.onload = () => resolve(element);
            element.onerror = () => reject(new Error('无法解析图片，请换用 JPG、PNG 或 WebP'));
            element.src = objectUrl;
        });

        const needsResize = Math.max(img.naturalWidth, img.naturalHeight) > maxDimension;
        if (!needsResize && file.size <= targetBytes) {
            return {
                dataUrl: await readAsDataUrl(file),
                size: file.size,
                mimeType: file.type || 'image/jpeg',
                compressed: false
            };
        }

        const scale = Math.min(1, maxDimension / Math.max(img.naturalWidth, img.naturalHeight));
        let width = Math.max(1, Math.round(img.naturalWidth * scale));
        let height = Math.max(1, Math.round(img.naturalHeight * scale));
        let quality = 0.9;
        let blob = null;

        for (let attempt = 0; attempt < 8; attempt++) {
            const canvas = document.createElement('canvas');
            canvas.width = width;
            canvas.height = height;
            const ctx = canvas.getContext('2d');
            ctx.fillStyle = '#ffffff';
            ctx.fillRect(0, 0, width, height);
            ctx.drawImage(img, 0, 0, width, height);
            blob = await new Promise(resolve => canvas.toBlob(resolve, 'image/jpeg', quality));
            if (!blob) throw new Error('图片压缩失败');
            if (blob.size <= targetBytes) break;

            if (quality > 0.6) {
                quality -= 0.1;
            } else {
                width = Math.max(1, Math.round(width * 0.82));
                height = Math.max(1, Math.round(height * 0.82));
            }
        }

        if (!blob || blob.size > configuredLimit) {
            throw new Error(`压缩后仍超过 ${Config.getUploadSizeMB()}MB，请换用更小的图片`);
        }

        return {
            dataUrl: await readAsDataUrl(blob),
            size: blob.size,
            mimeType: 'image/jpeg',
            compressed: true
        };
    } finally {
        URL.revokeObjectURL(objectUrl);
    }
}

