const test = require('node:test');
const assert = require('node:assert/strict');
const { buildPlan, validatePlan } = require('../js/timeline-plan.js');

test('builds a continuous two-segment plan and calculates overlap', () => {
    const plan = buildPlan({
        fps: 24,
        global_prompt: '角色沿街前行，电影感运镜',
        segments: [
            { start: 0, end: 175 / 24 },
            { start: 153 / 24, end: 328 / 24, prompt: '角色推门进入室内' }
        ]
    });
    assert.equal(plan.segments[1].overlap_frames, 22);
    assert.equal(plan.segments[0].prompt, '角色沿街前行，电影感运镜');
    assert.equal(plan.segments[1].end_frame, 328);
});

test('rejects a gap between adjacent segments', () => {
    const result = validatePlan({
        global_prompt: '测试',
        segments: [{ start: 0, end: 175 / 24 }, { start: 8, end: 8 + 175 / 24 }]
    });
    assert.equal(result.valid, false);
    assert.match(result.errors[0], /空白/);
});

test('rejects excess reference images', () => {
    const assets = Array.from({ length: 10 }, (_, i) => ({ type: 'image', uri: `asset://${i}` }));
    const result = validatePlan({
        global_prompt: '测试',
        segments: [{ start: 0, end: 175 / 24, assets }]
    });
    assert.equal(result.valid, false);
    assert.match(result.errors[0], /参考图片超过/);
});

test('rejects invalid two-stage sampling split', () => {
    const result = validatePlan({
        global_prompt: '测试',
        sampling: { steps: 8, low_resolution_steps: 9 },
        segments: [{ start: 0, end: 175 / 24 }]
    });
    assert.equal(result.valid, false);
    assert.match(result.errors[0], /低分辨率步数/);
});

test('1080p requires both low and high resolution sampling steps', () => {
    const input = { size: '1920x1080', global_prompt: '测试',
        sampling: { steps: 8, low_resolution_steps: 8 },
        segments: [{ start: 0, end: 175 / 24 }] };
    assert.match(validatePlan(input).errors[0], /1080p 超分/);
    input.sampling.low_resolution_steps = 6;
    assert.equal(validatePlan(input).valid, true);
});

test('normalises segment assets for the worker contract', () => {
    const plan = buildPlan({
        global_prompt: '测试',
        segments: [{
            start: 0,
            end: 175 / 24,
            assets: [
                { id: 'portrait', type: 'image', uri: 'asset://portrait', role: 'character' },
                { id: 'voice', type: 'audio', uri: 'https://example.test/voice.wav' }
            ]
        }]
    });
    assert.deepEqual(plan.segments[0].assets[0], {
        id: 'portrait', type: 'image', uri: 'asset://portrait', role: 'character'
    });
    assert.equal(plan.segments[0].assets[1].role, 'reference');
});

test('rejects durations and overlaps outside H3 frame alignment', () => {
    const duration = validatePlan({ global_prompt: '测试', segments: [{ start: 0, end: 4 }] });
    assert.equal(duration.valid, false);
    assert.match(duration.errors[0], /5\+17×n/);
    const overlap = validatePlan({ global_prompt: '测试', segments: [
        { start: 0, end: 175 / 24 },
        { start: 151 / 24, end: 326 / 24 }
    ] });
    assert.equal(overlap.valid, false);
    assert.match(overlap.errors[0], /重叠/);
});

test('keeps total timeline within the current ten-minute service limit', () => {
    const result = validatePlan({ global_prompt: '测试', segments: [
        { start: 0, end: 3592 / 24 },
        { start: 3592 / 24, end: 7184 / 24 },
        { start: 7184 / 24, end: 10776 / 24 },
        { start: 10776 / 24, end: 14368 / 24 },
        { start: 14368 / 24, end: 17960 / 24 }
    ] });
    assert.equal(result.valid, false);
    assert.match(result.errors[0], /10 分钟/);
});
