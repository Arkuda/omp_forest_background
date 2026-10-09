// Windows Terminal full-viewport post-process. The baked image is data, not RGB art.
// Generate assets/scenes/<id>/{background.hlsl,atlas.png} with scripts/generate-assets.ts.
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
static const float2 SceneCells = float2(200.0, 100.0);
static const float CellAspect = 1.0;
static const float2 AtlasSize = float2(1600.0, 800.0);
static const float TilesPerRow = 8.0;
static const float FrameCount = 64.0;
static const float SampleFps = 2.0;
static const float3 Ground = float3(3.0, 4.0, 8.0) / 255.0;
static const float3 Palette[38] = {
    float3(24.0, 24.0, 27.0) / 255.0,
    float3(35.0, 35.0, 38.0) / 255.0,
    float3(48.0, 48.0, 51.0) / 255.0,
    float3(65.0, 65.0, 67.0) / 255.0,
    float3(85.0, 85.0, 86.0) / 255.0,
    float3(107.0, 106.0, 105.0) / 255.0,
    float3(131.0, 129.0, 125.0) / 255.0,
    float3(156.0, 153.0, 147.0) / 255.0,
    float3(182.0, 178.0, 170.0) / 255.0,
    float3(207.0, 202.0, 193.0) / 255.0,
    float3(230.0, 225.0, 216.0) / 255.0,
    float3(247.0, 244.0, 238.0) / 255.0,
    float3(12.0, 17.0, 32.0) / 255.0,
    float3(19.0, 26.0, 46.0) / 255.0,
    float3(27.0, 37.0, 64.0) / 255.0,
    float3(38.0, 47.0, 74.0) / 255.0,
    float3(223.0, 233.0, 255.0) / 255.0,
    float3(10.0, 34.0, 89.0) / 255.0,
    float3(15.0, 47.0, 114.0) / 255.0,
    float3(21.0, 64.0, 140.0) / 255.0,
    float3(29.0, 83.0, 166.0) / 255.0,
    float3(42.0, 105.0, 191.0) / 255.0,
    float3(67.0, 134.0, 211.0) / 255.0,
    float3(110.0, 174.0, 234.0) / 255.0,
    float3(168.0, 211.0, 246.0) / 255.0,
    float3(232.0, 240.0, 250.0) / 255.0,
    float3(194.0, 208.0, 227.0) / 255.0,
    float3(139.0, 159.0, 188.0) / 255.0,
    float3(47.0, 74.0, 38.0) / 255.0,
    float3(59.0, 90.0, 44.0) / 255.0,
    float3(91.0, 114.0, 56.0) / 255.0,
    float3(122.0, 145.0, 80.0) / 255.0,
    float3(119.0, 120.0, 63.0) / 255.0,
    float3(143.0, 133.0, 80.0) / 255.0,
    float3(168.0, 149.0, 94.0) / 255.0,
    float3(107.0, 86.0, 52.0) / 255.0,
    float3(185.0, 119.0, 74.0) / 255.0,
    float3(138.0, 72.0, 56.0) / 255.0
};

float maximumChannel(float3 color)
{
    return max(color.r, max(color.g, color.b));
}

float3 renderFrame(float frame, float2 cell, float dotDistance, float edgeWidth)
{
    // Sample descriptor texel centers: interpolation invents colors and classes.
    float2 tile = float2(fmod(frame, TilesPerRow), floor(frame / TilesPerRow));
    float2 atlasUV = (tile * SceneCells + floor(cell) + 0.5) / AtlasSize;
    uint packed = (uint)(frameAtlas.SampleLevel(textureSampler, atlasUV, 0).r * 255.0 + 0.5);
    uint paletteIndex = packed >> 2;
    uint dotStep = packed & 3;
    // Original COVER classes are 0, .3, .6 and 1; the full class fills the cell.
    float radius = (dotStep == 1 ? 0.30901936 : 0.43701937) * sqrt(CellAspect);
    float coverage = dotStep == 0 ? 0.0 : dotStep == 3 ? 1.0
        : 1.0 - smoothstep(radius - edgeWidth, radius + edgeWidth, dotDistance);
    return lerp(Ground, Palette[paletteIndex], coverage);
}

float4 main(float4 position : SV_POSITION, float2 tex : TEXCOORD) : SV_TARGET
{
    float4 terminal = terminalTexture.Sample(textureSampler, tex);
    if (Brightness <= 0.0)
        return terminal;

    // Contain the whole scene at its original cell aspect; letterboxes stay untouched.
    float2 viewport = max(Resolution, float2(1.0, 1.0));
    float2 cellAspect = float2(1.0, CellAspect);
    float cellPixels = min(viewport.x / SceneCells.x, viewport.y / (SceneCells.y * CellAspect));
    float2 sceneSize = SceneCells * cellAspect * cellPixels;
    float2 scenePixel = tex * viewport - (viewport - sceneSize) * 0.5;
    float2 cell = scenePixel / (cellPixels * cellAspect);
    if (cell.x < 0.0 || cell.y < 0.0 || cell.x >= SceneCells.x || cell.y >= SceneCells.y)
        return terminal;

    float dotDistance = length((frac(cell) - 0.5) * cellAspect);
    float edgeWidth = min(0.25, 0.5 / max(cellPixels, 1.0));
    // Reflect all samples instead of cross-fading unrelated endpoints.
    // Time remains referenced so Windows Terminal redraws continuously while idle.
    float lastFrame = FrameCount - 1.0;
    float phase = fmod(max(Time, 0.0) * SampleFps * Animated, lastFrame * 2.0);
    float frame = lastFrame - abs(phase - lastFrame);
    float first = floor(frame);
    float3 scene = renderFrame(first, cell, dotDistance, edgeWidth);
    if (Animated > 0.5)
    {
        float3 next = renderFrame(min(first + 1.0, lastFrame), cell, dotDistance, edgeWidth);
        scene = lerp(scene, next, frac(frame));
    }

    // Input alpha is often 1 even on empty terminal cells. Mask RGB brightness
    // instead: dark native and omp panels receive the scene, while foreground
    // and cursor pixels retain their exact RGB/alpha. Adapt to the profile's dark
    // base without allowing a light theme to erase text contrast.
    float base = maximumChannel(Background.rgb);
    float low = min(0.20, max(0.13, base + 0.07));
    float high = min(0.38, max(0.30, base + 0.20));
    float darkPixel = 1.0 - smoothstep(low, high, maximumChannel(terminal.rgb));
    terminal.rgb = saturate(terminal.rgb + scene * Brightness * darkPixel);
    return terminal;
}
