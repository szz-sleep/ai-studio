/**
 * AI Studio - 配置与 Key 管理
 * 支持多平台 API 接入
 */

// 所有图片/视频生成请求自动追加此提示，禁止水印
const DEFAULT_PROMPT_SUFFIX = '，图片或视频中不允许出现任何水印、文字标识、LOGO、品牌标记或无关文字。';

// ===== 预设平台配置 =====
const PLATFORM_PRESETS = {
    opc: {
        name: 'OPC Cloud',
        baseUrl: 'https://openai.zhrccp.com',
        apiKeyPattern: 'sk-',
        modelsEndpoint: '/v1/models',
        chatEndpoint: '/v1/chat/completions',
        imageEndpoint: '/v1/images/generations',
        imageEditEndpoint: '/v1/images/edits',
        videoEndpoint: '/v1/video/generations',
        videoPollBase: '/v1/video',
        headerStyle: 'bearer',
        hint: 'OPC Cloud 平台，填入 API Key 即可使用。'
    },
    neutoken: {
        name: '牛头词元',
        baseUrl: 'https://neutoken.net/v1',
        apiKeyPattern: 'sk-',
        modelsEndpoint: '/models',
        chatEndpoint: '/chat/completions',
        imageEndpoint: '/images/generations',
        imageEditEndpoint: '/images/edits',
       videoEndpoint: null,
       videoPollBase: null,
       headerStyle: 'bearer',
       hint: '牛头词元平台，OpenAI 兼容接口，填入 API Key 即可使用。'
   },
    agnes: {
        name: 'Agnes AI',
        baseUrl: 'https://apihub.agnes-ai.com',
        apiKeyPattern: '',
        modelsEndpoint: '/v1/models',
        chatEndpoint: '/v1/chat/completions',
        imageEndpoint: '/v1/images/generations',
        imageEditEndpoint: null,
        videoEndpoint: '/v1/videos',
        videoResultEndpoint: '/agnesapi',
        headerStyle: 'bearer',
        hint: 'Agnes AI 平台，一个 API Key 通用图片与视频模型（agnes-image-2.1-flash / agnes-video-v2.0）。'
    },
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
        hint: 'OpenAI 兼容接口，填入 API 地址和 API Key 即可使用。'
    }
};

const Config = {
    // 默认平台
    DEFAULT_PLATFORM: 'opc',

    // 默认单图上传限制（MB）
    DEFAULT_UPLOAD_SIZE_MB: 50,

    // localStorage 键名
    STORAGE_KEYS: {
        PLATFORM: 'opc_platform',
        API_KEYS: 'opc_api_keys',       // JSON: { opc: "sk-xxx", neutoken: "sk-yyy", custom: "sk-zzz" }
        CUSTOM_BASE_URL: 'opc_custom_base_url', // 自定义平台地址
        CUSTOM_API_STANDARD: 'opc_custom_api_standard', // 自定义平台 API 标准 (openai/anthropic)
        CUSTOM_ANTHROPIC_VERSION: 'opc_custom_anthropic_version', // Anthropic API 版本
        HISTORY: 'opc_history',
        UPLOAD_SIZE: 'opc_upload_size_mb'
    },

    // ===== 平台管理 =====

    getPlatform() {
        return localStorage.getItem(this.STORAGE_KEYS.PLATFORM) || this.DEFAULT_PLATFORM;
    },

    setPlatform(platformId) {
        if (PLATFORM_PRESETS[platformId]) {
            localStorage.setItem(this.STORAGE_KEYS.PLATFORM, platformId);
        }
    },

    getCurrentPlatformConfig() {
        const id = this.getPlatform();
        return PLATFORM_PRESETS[id] || PLATFORM_PRESETS.opc;
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

    // ===== API 地址（所有平台均可自定义覆盖） =====

    getBaseUrl() {
        const platform = this.getPlatform();
        // 优先读 localStorage 中用户自定义的地址
        const customUrl = localStorage.getItem(`opc_base_url_${platform}`);
        if (customUrl !== null) return customUrl;
        // 回退到预设默认值
        return PLATFORM_PRESETS[platform]?.baseUrl || '';
    },

    setBaseUrl(url, platform) {
        platform = platform || this.getPlatform();
        url = url.replace(/\/+$/, '');
        localStorage.setItem(`opc_base_url_${platform}`, url);
    },

    // 兼容旧方法
    setCustomBaseUrl(url) {
        this.setBaseUrl(url, 'custom');
    },

    // 恢复某平台地址为默认预设值
    resetBaseUrl(platform) {
        platform = platform || this.getPlatform();
        localStorage.removeItem(`opc_base_url_${platform}`);
    },

    // ===== 自定义平台 API 标准 =====

    getCustomApiStandard() {
        return localStorage.getItem(this.STORAGE_KEYS.CUSTOM_API_STANDARD) || 'openai';
    },

    setCustomApiStandard(standard) {
        localStorage.setItem(this.STORAGE_KEYS.CUSTOM_API_STANDARD, standard);
    },

    getCustomAnthropicVersion() {
        return localStorage.getItem(this.STORAGE_KEYS.CUSTOM_ANTHROPIC_VERSION) || '2023-06-01';
    },

    setCustomAnthropicVersion(version) {
        localStorage.setItem(this.STORAGE_KEYS.CUSTOM_ANTHROPIC_VERSION, version);
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
