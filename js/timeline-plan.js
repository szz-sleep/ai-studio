/**
 * H3 long-video timeline plan utilities.
 *
 * This is an independent API/data-model implementation. It intentionally
 * contains no code copied from ComfyUI-MiniMaxH3-TimelineDirector.
 */
(function (root, factory) {
    const api = factory();
    if (typeof module === 'object' && module.exports) module.exports = api;
    if (root) root.H3TimelinePlan = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
    'use strict';

    const PLAN_VERSION = '1.0';
    const DEFAULT_FPS = 24;

    function isFiniteNumber(value) {
        return typeof value === 'number' && Number.isFinite(value);
    }

    function assert(condition, message) {
        if (!condition) throw new Error(message);
    }

    function normaliseAsset(asset, segmentIndex) {
        assert(asset && typeof asset === 'object', `第 ${segmentIndex + 1} 段包含无效素材`);
        assert(['image', 'video', 'audio'].includes(asset.type), `第 ${segmentIndex + 1} 段素材类型无效`);
        assert(typeof asset.uri === 'string' && asset.uri.trim(), `第 ${segmentIndex + 1} 段素材缺少 uri`);
        return {
            id: String(asset.id || `${asset.type}-${segmentIndex + 1}`),
            type: asset.type,
            uri: asset.uri.trim(),
            role: String(asset.role || 'reference')
        };
    }

    function normaliseSegment(segment, index, fps) {
        assert(segment && typeof segment === 'object', `第 ${index + 1} 段无效`);
        assert(isFiniteNumber(segment.start) && segment.start >= 0, `第 ${index + 1} 段 start 必须是非负数`);
        assert(isFiniteNumber(segment.end) && segment.end > segment.start, `第 ${index + 1} 段 end 必须大于 start`);

        const startFrame = Math.round(segment.start * fps);
        const endFrame = Math.round(segment.end * fps);
        const durationFrames = endFrame - startFrame;
        assert(durationFrames > 0, `第 ${index + 1} 段时长不足一帧`);

        return {
            id: String(segment.id || `segment-${String(index + 1).padStart(2, '0')}`),
            start: startFrame / fps,
            end: endFrame / fps,
            start_frame: startFrame,
            end_frame: endFrame,
            prompt: String(segment.prompt || '').trim(),
            assets: (segment.assets || []).map(asset => normaliseAsset(asset, index))
        };
    }

    function buildPlan(input) {
        assert(input && typeof input === 'object', '时间线计划不能为空');
        const fps = Number(input.fps || DEFAULT_FPS);
        assert(Number.isInteger(fps) && fps > 0 && fps <= 120, 'fps 必须是 1–120 的整数');
        assert(Array.isArray(input.segments) && input.segments.length > 0, '至少需要一个视频分段');
        assert(input.segments.length <= 64, '视频分段不能超过 64 个');

        const segments = input.segments.map((segment, index) => normaliseSegment(segment, index, fps));
        const globalPrompt = String(input.global_prompt || '').trim();

        segments.forEach((segment, index) => {
            if (!segment.prompt) segment.prompt = globalPrompt;
            assert(segment.prompt, `第 ${index + 1} 段缺少提示词，且未设置全局提示词`);
            if (index === 0) return;
            const previous = segments[index - 1];
            assert(segment.start_frame < segment.end_frame, `第 ${index + 1} 段帧范围无效`);
            assert(segment.start_frame >= previous.start_frame, `第 ${index + 1} 段起点不能早于上一段`);
            assert(segment.end_frame > previous.end_frame, `第 ${index + 1} 段终点必须推进时间线`);
            assert(segment.start_frame <= previous.end_frame, `第 ${index + 1} 段与上一段之间存在空白`);
        });

        const maxReferenceImages = Number(input.limits?.max_reference_images ?? 9);
        const maxReferenceAudios = Number(input.limits?.max_reference_audios ?? 3);
        segments.forEach((segment, index) => {
            const imageCount = segment.assets.filter(asset => asset.type === 'image').length;
            const audioCount = segment.assets.filter(asset => asset.type === 'audio').length;
            assert(imageCount <= maxReferenceImages, `第 ${index + 1} 段参考图片超过 ${maxReferenceImages} 张`);
            assert(audioCount <= maxReferenceAudios, `第 ${index + 1} 段参考音频超过 ${maxReferenceAudios} 个`);
            segment.overlap_frames = index === 0 ? 0 : segments[index - 1].end_frame - segment.start_frame;
        });

        return {
            version: PLAN_VERSION,
            model: String(input.model || 'minimax-h3'),
            fps,
            size: String(input.size || '1024x576'),
            seed: input.seed === '' || input.seed == null ? null : Number(input.seed),
            global_prompt: globalPrompt,
            sampling: {
                steps: Number(input.sampling?.steps ?? 8),
                low_resolution_steps: Number(input.sampling?.low_resolution_steps ?? 6),
                enable_drift_control: input.sampling?.enable_drift_control !== false,
                enable_soft_audio: input.sampling?.enable_soft_audio !== false
            },
            output: {
                container: String(input.output?.container || 'mp4'),
                codec: String(input.output?.codec || 'h264')
            },
            segments
        };
    }

    function validatePlan(input) {
        try {
            const plan = buildPlan(input);
            const { steps, low_resolution_steps: lowSteps } = plan.sampling;
            assert(Number.isInteger(steps) && steps > 0, 'sampling.steps 必须是正整数');
            assert(Number.isInteger(lowSteps) && lowSteps >= 0 && lowSteps <= steps, '低分辨率步数必须介于 0 和总步数之间');
            assert(plan.seed === null || (Number.isInteger(plan.seed) && plan.seed >= 0), 'seed 必须是非负整数');
            return { valid: true, errors: [], plan };
        } catch (error) {
            return { valid: false, errors: [error.message], plan: null };
        }
    }

    return { PLAN_VERSION, DEFAULT_FPS, buildPlan, validatePlan };
});
