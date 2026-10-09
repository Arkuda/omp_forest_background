// Windows Terminal full-viewport post-process. The baked image is data, not RGB art.
// Regenerate forest.hlsl and forest-atlas.png with scripts/generate-assets.ts.
Texture2D terminalTexture : register(t0);
Texture2D frameAtlas : register(t1);
SamplerState textureSampler : register(s0);

cbuffer TerminalConstants : register(b0)
{
    float Time;
    float Scale;
    float2 Resolution;
    float4 Background;
};

static const float Brightness = {{BRIGHTNESS}};
static const float Animated = {{ANIMATED}};
static const float3 Ground = float3(9.0, 15.0, 14.0) / 255.0;
static const float3 Palette[32] = {
{{PALETTE}}
};

float maximumChannel(float3 color)
{
    return max(color.r, max(color.g, color.b));
}

float3 renderFrame(float frame, float2 cell, float dotDistance, float edgeWidth)
{
    // Always sample the center of a descriptor texel: interpolating its packed
    // palette/dot byte would invent colors and dot classes, including at tile edges.
    float2 tile = float2(fmod(frame, 8.0), floor(frame / 8.0));
    float2 atlasUV = (tile * float2(200.0, 100.0) + floor(cell) + 0.5)
        / float2(1600.0, 800.0);
    uint packed = (uint)(frameAtlas.SampleLevel(textureSampler, atlasUV, 0).r * 255.0 + 0.5);
    uint paletteIndex = packed >> 2;
    uint dotStep = packed & 3;
    // The original generator's COVER classes are exactly 0, .3, .6 and 1.
    // Small circles have those areas; the full class fills the cell completely.
    float radius = dotStep == 1 ? 0.30901936 : 0.43701937;
    float coverage = dotStep == 0 ? 0.0 : dotStep == 3 ? 1.0
        : 1.0 - smoothstep(radius - edgeWidth, radius + edgeWidth, dotDistance);
    return lerp(Ground, Palette[paletteIndex], coverage);
}

float4 main(float4 position : SV_POSITION, float2 tex : TEXCOORD) : SV_TARGET
{
    float4 terminal = terminalTexture.Sample(textureSampler, tex);
    if (Brightness <= 0.0)
        return terminal;

    // Contain, never cover: the original 2:1 frame and both foreground pines
    // remain visible on wide and tall windows. Letterbox pixels stay untouched.
    float2 viewport = max(Resolution, float2(1.0, 1.0));
    float cellPixels = min(viewport.x / 200.0, viewport.y / 100.0);
    float2 sceneSize = float2(200.0, 100.0) * cellPixels;
    float2 scenePixel = tex * viewport - (viewport - sceneSize) * 0.5;
    float2 cell = scenePixel / cellPixels;
    if (cell.x < 0.0 || cell.y < 0.0 || cell.x >= 200.0 || cell.y >= 100.0)
        return terminal;

    float dotDistance = length(frac(cell) - 0.5);
    float edgeWidth = min(0.25, 0.5 / max(cellPixels, 1.0));
    // 64 original samples cover 0..31.5 seconds at 2fps. Reflect the timeline
    // instead of cross-fading unrelated endpoints: no jump at the 63s seam.
    float phase = fmod(max(Time, 0.0) * 2.0 * Animated, 126.0);
    float frame = 63.0 - abs(phase - 63.0);
    float first = floor(frame);
    float3 forest = renderFrame(first, cell, dotDistance, edgeWidth);
    if (Animated > 0.5)
    {
        float3 next = renderFrame(min(first + 1.0, 63.0), cell, dotDistance, edgeWidth);
        forest = lerp(forest, next, frac(frame));
    }

    // Input alpha is often 1 even on empty terminal cells. Mask RGB brightness
    // instead: dark native and omp panel backgrounds receive the scene, while
    // white/colored foreground and cursor pixels retain their exact RGB/alpha.
    // Background adapts the fade to the profile's dark base without allowing
    // a light theme to erase text contrast.
    float base = maximumChannel(Background.rgb);
    float low = min(0.20, max(0.13, base + 0.07));
    float high = min(0.38, max(0.30, base + 0.20));
    float darkPixel = 1.0 - smoothstep(low, high, maximumChannel(terminal.rgb));
    terminal.rgb = saturate(terminal.rgb + forest * Brightness * darkPixel);
    return terminal;
}
