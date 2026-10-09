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
static const float3 Ground = float3(11.0, 8.0, 18.0) / 255.0;
static const float3 Palette[46] = {
    float3(20.0, 18.0, 48.0) / 255.0,
    float3(29.0, 26.0, 66.0) / 255.0,
    float3(39.0, 34.0, 87.0) / 255.0,
    float3(51.0, 43.0, 106.0) / 255.0,
    float3(69.0, 53.0, 122.0) / 255.0,
    float3(90.0, 67.0, 136.0) / 255.0,
    float3(114.0, 89.0, 168.0) / 255.0,
    float3(109.0, 58.0, 115.0) / 255.0,
    float3(138.0, 70.0, 119.0) / 255.0,
    float3(168.0, 82.0, 122.0) / 255.0,
    float3(196.0, 96.0, 122.0) / 255.0,
    float3(217.0, 122.0, 146.0) / 255.0,
    float3(184.0, 102.0, 160.0) / 255.0,
    float3(154.0, 104.0, 200.0) / 255.0,
    float3(200.0, 104.0, 176.0) / 255.0,
    float3(232.0, 112.0, 122.0) / 255.0,
    float3(217.0, 112.0, 95.0) / 255.0,
    float3(232.0, 133.0, 82.0) / 255.0,
    float3(242.0, 159.0, 74.0) / 255.0,
    float3(248.0, 184.0, 90.0) / 255.0,
    float3(252.0, 208.0, 122.0) / 255.0,
    float3(255.0, 227.0, 166.0) / 255.0,
    float3(255.0, 242.0, 210.0) / 255.0,
    float3(26.0, 18.0, 32.0) / 255.0,
    float3(36.0, 24.0, 42.0) / 255.0,
    float3(48.0, 31.0, 51.0) / 255.0,
    float3(63.0, 40.0, 56.0) / 255.0,
    float3(82.0, 51.0, 64.0) / 255.0,
    float3(58.0, 44.0, 76.0) / 255.0,
    float3(77.0, 58.0, 100.0) / 255.0,
    float3(94.0, 53.0, 36.0) / 255.0,
    float3(125.0, 69.0, 39.0) / 255.0,
    float3(160.0, 88.0, 42.0) / 255.0,
    float3(192.0, 110.0, 46.0) / 255.0,
    float3(217.0, 138.0, 70.0) / 255.0,
    float3(255.0, 255.0, 255.0) / 255.0,
    float3(255.0, 246.0, 216.0) / 255.0,
    float3(255.0, 216.0, 96.0) / 255.0,
    float3(255.0, 159.0, 42.0) / 255.0,
    float3(240.0, 106.0, 30.0) / 255.0,
    float3(200.0, 64.0, 26.0) / 255.0,
    float3(138.0, 42.0, 22.0) / 255.0,
    float3(15.0, 26.0, 44.0) / 255.0,
    float3(22.0, 37.0, 64.0) / 255.0,
    float3(32.0, 50.0, 90.0) / 255.0,
    float3(214.0, 212.0, 238.0) / 255.0
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
