using System.Text.Json;
using MiniInspector;

var builder = WebApplication.CreateBuilder(args);

var configPath = Path.Combine(builder.Environment.ContentRootPath, "config.json");
var config = AppConfig.Load(configPath);

builder.WebHost.UseUrls(builder.Configuration.GetValue("Urls", $"http://127.0.0.1:{config.Port}"));
builder.Logging.SetMinimumLevel(LogLevel.Information);

builder.Services.AddSingleton(config);
builder.Services.AddSingleton<MetricsStore>();
builder.Services.AddSingleton<CollectorService>();
builder.Services.AddHostedService(sp => sp.GetRequiredService<CollectorService>());

var app = builder.Build();

var json = new JsonSerializerOptions
{
    PropertyNamingPolicy = JsonNamingPolicy.SnakeCaseLower
};

app.UseDefaultFiles();
app.UseStaticFiles();

app.MapGet("/api/status", (CollectorService collector) =>
    Results.Json(collector.BuildStatus(), json));

app.MapGet("/api/metrics", (long? since, MetricsStore store) =>
    Results.Json(new { samples = store.Since(since ?? 0) }, json));

app.MapGet("/api/config", (AppConfig cfg) => Results.Json(new
{
    port = cfg.Port,
    retention_seconds = cfg.RetentionSeconds,
    interval_ms = cfg.IntervalMs
}, json));

app.MapPost("/api/config", async (HttpRequest req, AppConfig cfg) =>
{
    var body = await req.ReadFromJsonAsync<ConfigUpdate>(json);
    if (body is null)
        return Results.BadRequest(new { error = "invalid JSON body" });
    var restart = cfg.Update(body.Port, body.RetentionSeconds, body.IntervalMs);
    return Results.Json(new
    {
        port = cfg.Port,
        retention_seconds = cfg.RetentionSeconds,
        interval_ms = cfg.IntervalMs,
        restart_required = restart
    }, json);
});

app.Run();
