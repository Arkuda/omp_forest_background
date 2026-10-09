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
static const float3 Ground = float3(7.0, 8.0, 15.0) / 255.0;
static const float3 Palette[36] = {
    float3(24.0, 33.0, 63.0) / 255.0,
    float3(32.0, 44.0, 85.0) / 255.0,
    float3(42.0, 57.0, 109.0) / 255.0,
    float3(55.0, 74.0, 136.0) / 255.0,
    float3(74.0, 96.0, 162.0) / 255.0,
    float3(104.0, 128.0, 188.0) / 255.0,
    float3(44.0, 33.0, 64.0) / 255.0,
    float3(63.0, 45.0, 88.0) / 255.0,
    float3(86.0, 57.0, 107.0) / 255.0,
    float3(110.0, 74.0, 122.0) / 255.0,
    float3(138.0, 95.0, 136.0) / 255.0,
    float3(90.0, 46.0, 60.0) / 255.0,
    float3(123.0, 64.0, 76.0) / 255.0,
    float3(158.0, 88.0, 88.0) / 255.0,
    float3(85.0, 48.0, 15.0) / 255.0,
    float3(125.0, 69.0, 21.0) / 255.0,
    float3(169.0, 92.0, 27.0) / 255.0,
    float3(210.0, 122.0, 36.0) / 255.0,
    float3(238.0, 150.0, 49.0) / 255.0,
    float3(255.0, 178.0, 70.0) / 255.0,
    float3(255.0, 205.0, 106.0) / 255.0,
    float3(255.0, 227.0, 156.0) / 255.0,
    float3(255.0, 242.0, 207.0) / 255.0,
    float3(255.0, 255.0, 255.0) / 255.0,
    float3(220.0, 230.0, 255.0) / 255.0,
    float3(169.0, 189.0, 232.0) / 255.0,
    float3(106.0, 24.0, 27.0) / 255.0,
    float3(178.0, 42.0, 40.0) / 255.0,
    float3(255.0, 75.0, 62.0) / 255.0,
    float3(19.0, 44.0, 56.0) / 255.0,
    float3(28.0, 63.0, 79.0) / 255.0,
    float3(42.0, 88.0, 104.0) / 255.0,
    float3(41.0, 40.0, 58.0) / 255.0,
    float3(60.0, 58.0, 76.0) / 255.0,
    float3(86.0, 82.0, 102.0) / 255.0,
    float3(121.0, 115.0, 138.0) / 255.0
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
