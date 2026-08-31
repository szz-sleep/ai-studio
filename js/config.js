/**
 * AI Studio - 配置与 Key 管理
 * 支持多平台 API 接入
 */

// ===== 平台配置 =====
// 所有平台均由用户通过"自定义平台"自行添加与管理，本文件不再内置任何预设平台。
const PLATFORM_PRESETS = {
    custom: {
        name: '自定义平台',
        baseUrl: '',
        apiKeyPattern: '',
        modelsEndpoint: '/v1/models',
        chatEndpoint: '/v1/chat/completions',
        imageEndpoint: '/v1/images/generations',
        imageEditEndpoint: '/v1/images/edits',
        videoEndpoint: '/v1/video/generations',
        videoPollBase: '/v1/video',
        headerStyle: 'bearer',
        hint: '填入 API 地址和 API Key 即可使用。'
    }
};

const Config = {
    // 默认平台
    DEFAULT_PLATFORM: 'custom',

    // 默认单图上传限制（MB）
    DEFAULT_UPLOAD_SIZE_MB: 50,

    // localStorage 键名
    STORAGE_KEYS: {
        PLATFORM: 'opc_platform',
        API_KEYS: 'opc_api_keys',       // JSON: { volcengine: "xxx", custom_1: "yyy", ... }
        CUSTOM_PLATFORMS: 'opc_custom_platforms', // JSON: [{ id, name, baseUrl, apiKey }, ...]
        CUSTOM_API_STANDARD: 'opc_custom_api_standard',
        CUSTOM_ANTHROPIC_VERSION: 'opc_custom_anthropic_version',
        HISTORY: 'opc_history',
        UPLOAD_SIZE: 'opc_upload_size_mb'
    },

    // ===== 自定义平台管理 =====

    /**
     * 获取所有自定义平台
     */
    getCustomPlatforms() {
        try {
            return JSON.parse(localStorage.getItem(this.STORAGE_KEYS.CUSTOM_PLATFORMS) || '[]');
        } catch { return []; }
    },

    /**
     * 保存自定义平台列表
     */
    _saveCustomPlatforms(list) {
        localStorage.setItem(this.STORAGE_KEYS.CUSTOM_PLATFORMS, JSON.stringify(list));
    },

    /**
     * 添加自定义平台
     */
    addCustomPlatform(name, baseUrl, apiKey) {
        const list = this.getCustomPlatforms();
        const id = 'custom_' + Date.now();
        list.push({ id, name: name || '自定义平台', baseUrl: baseUrl.replace(/\/+$/, ''), apiKey: apiKey || '' });
        this._saveCustomPlatforms(list);
        // 同时保存 Key 到 API_KEYS
        const keys = this._getAllKeys();
        keys[id] = apiKey || '';
        localStorage.setItem(this.STORAGE_KEYS.API_KEYS, JSON.stringify(keys));
        return id;
    },

    /**
     * 更新自定义平台
     */
    updateCustomPlatform(id, updates) {
        const list = this.getCustomPlatforms();
        const item = list.find(p => p.id === id);
        if (!item) return;
        Object.assign(item, updates);
        if (updates.baseUrl) item.baseUrl = updates.baseUrl.replace(/\/+$/, '');
        this._saveCustomPlatforms(list);
        if (updates.apiKey !== undefined) {
            const keys = this._getAllKeys();
            keys[id] = updates.apiKey;
            localStorage.setItem(this.STORAGE_KEYS.API_KEYS, JSON.stringify(keys));
        }
    },

    /**
     * 删除自定义平台
     */
    removeCustomPlatform(id) {
        const list = this.getCustomPlatforms().filter(p => p.id !== id);
        this._saveCustomPlatforms(list);
        // 删除对应的 Key
        const keys = this._getAllKeys();
        delete keys[id];
        localStorage.setItem(this.STORAGE_KEYS.API_KEYS, JSON.stringify(keys));
        // 如果当前平台就是被删的，切回默认
        if (this.getPlatform() === id) {
            this.setPlatform(this.DEFAULT_PLATFORM);
        }
    },

    /**
     * 获取自定义平台配置（含 baseUrl/name）
     */
    getCustomPlatformConfig(id) {
        const list = this.getCustomPlatforms();
        const item = list.find(p => p.id === id);
        if (!item) return null;
        return {
            name: item.name,
            baseUrl: item.baseUrl,
            apiKey: item.apiKey,
            modelsEndpoint: '/v1/models',
            chatEndpoint: '/v1/chat/completions',
            imageEndpoint: '/v1/images/generations',
            imageEditEndpoint: '/v1/images/edits',
            videoEndpoint: '/v1/video/generations',
            videoPollBase: '/v1/video',
            headerStyle: 'bearer',
            hint: `${item.name} — OpenAI 兼容接口`
        };
    },

    // ===== 平台管理 =====

    getPlatform() {
        return localStorage.getItem(this.STORAGE_KEYS.PLATFORM) || this.DEFAULT_PLATFORM;
    },

    setPlatform(platformId) {
        localStorage.setItem(this.STORAGE_KEYS.PLATFORM, platformId);
    },

    getCurrentPlatformConfig() {
        const id = this.getPlatform();
        if (PLATFORM_PRESETS[id]) return PLATFORM_PRESETS[id];
        // 自定义平台
        const custom = this.getCustomPlatformConfig(id);
        if (custom) return custom;
        return PLATFORM_PRESETS[this.DEFAULT_PLATFORM];
    },

    // ===== API Key 管理（多平台） =====

    _getAllKeys() {
        try {
            return JSON.parse(localStorage.getItem(this.STORAGE_KEYS.API_KEYS) || '{}');
        } catch { return {}; }
    },

    getApiKey() {
        const keys = this._getAllKeys();
        return keys[this.getPlatform()] || '';
    },

    setApiKey(key) {
        const keys = this._getAllKeys();
        keys[this.getPlatform()] = key;
        localStorage.setItem(this.STORAGE_KEYS.API_KEYS, JSON.stringify(keys));
    },

    clearApiKey() {
        const keys = this._getAllKeys();
        delete keys[this.getPlatform()];
        localStorage.setItem(this.STORAGE_KEYS.API_KEYS, JSON.stringify(keys));
    },

    hasKey() {
        return this.getApiKey().length > 0;
    },

    // ===== API 地址 =====

    getBaseUrl() {
        const id = this.getPlatform();
        // 自定义平台：从自定义平台列表中取
        const custom = this.getCustomPlatformConfig(id);
        if (custom) return custom.baseUrl;
        // 预设平台：优先读 localStorage，回退到预设
        const customUrl = localStorage.getItem(`opc_base_url_${id}`);
        if (customUrl !== null) return customUrl;
        return PLATFORM_PRESETS[id]?.baseUrl || '';
    },

    setBaseUrl(url, platform) {
        platform = platform || this.getPlatform();
        url = url.replace(/\/+$/, '');
        const custom = this.getCustomPlatformConfig(platform);
        if (custom) {
            this.updateCustomPlatform(platform, { baseUrl: url });
        } else {
            localStorage.setItem(`opc_base_url_${platform}`, url);
        }
    },

    // 恢复某平台地址为默认预设值
    resetBaseUrl(platform) {
        platform = platform || this.getPlatform();
        localStorage.removeItem(`opc_base_url_${platform}`);
    },

    // ===== 上传限制 =====

    getUploadSizeMB() {
        const val = localStorage.getItem(this.STORAGE_KEYS.UPLOAD_SIZE);
        if (val) {
            const n = parseInt(val, 10);
            if (!isNaN(n) && n > 0) return n;
        }
        return this.DEFAULT_UPLOAD_SIZE_MB;
    },

    setUploadSizeMB(mb) {
        const n = parseInt(mb, 10);
        if (!isNaN(n) && n >= 5 && n <= 500) {
            localStorage.setItem(this.STORAGE_KEYS.UPLOAD_SIZE, String(n));
        }
    },

    getUploadSizeBytes() {
        return this.getUploadSizeMB() * 1024 * 1024;
    },

    // ===== 重置 =====

    resetToDefaults() {
        const skipKeys = [this.STORAGE_KEYS.HISTORY];
        Object.values(this.STORAGE_KEYS)
            .filter(k => !skipKeys.includes(k))
            .forEach(k => localStorage.removeItem(k));
        // 清除所有平台 base URL 缓存
        Object.keys(localStorage).forEach(k => {
            if (k.startsWith('opc_base_url_')) localStorage.removeItem(k);
        });
    },

    // ===== UI 更新 =====

    updateKeyStatus() {
        const el = document.getElementById('keyStatus');
        if (this.hasKey()) {
            const key = this.getApiKey();
            const masked = key.substring(0, 6) + '****' + key.substring(key.length - 4);
            const platformName = this.getCurrentPlatformConfig().name;
            el.textContent = `${platformName}: ${masked}`;
            el.classList.add('set');
            el.classList.remove('unset');
        } else {
            const platformName = this.getCurrentPlatformConfig().name;
            el.textContent = `${platformName} - 未设置Key`;
            el.classList.add('unset');
            el.classList.remove('set');
        }
    }
};
