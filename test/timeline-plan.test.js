const test = require('node:test');
const assert = require('node:assert/strict');
const { buildPlan, validatePlan } = require('../js/timeline-plan.js');

test('builds a continuous two-segment plan and calculates overlap', () => {
    const plan = buildPlan({
        fps: 24,
        global_prompt: '角色沿街前行，电影感运镜',
        segments: [
            { start: 0, end: 7 },
            { start: 6, end: 13, prompt: '角色推门进入室内' }
        ]
    });
    assert.equal(plan.segments[1].overlap_frames, 24);
    assert.equal(plan.segments[0].prompt, '角色沿街前行，电影感运镜');
    assert.equal(plan.segments[1].end_frame, 312);
});

test('rejects a gap between adjacent segments', () => {
    const result = validatePlan({
        global_prompt: '测试',
        segments: [{ start: 0, end: 7 }, { start: 8, end: 15 }]
    });
    assert.equal(result.valid, false);
    assert.match(result.errors[0], /空白/);
});

test('rejects excess reference images', () => {
    const assets = Array.from({ length: 10 }, (_, i) => ({ type: 'image', uri: `asset://${i}` }));
    const result = validatePlan({
        global_prompt: '测试',
        segments: [{ start: 0, end: 7, assets }]
    });
    assert.equal(result.valid, false);
    assert.match(result.errors[0], /参考图片超过/);
});

test('rejects invalid two-stage sampling split', () => {
    const result = validatePlan({
        global_prompt: '测试',
        sampling: { steps: 8, low_resolution_steps: 9 },
        segments: [{ start: 0, end: 7 }]
    });
    assert.equal(result.valid, false);
    assert.match(result.errors[0], /低分辨率步数/);
});
