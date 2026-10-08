using System.Text.Json;
using MiniInspector;

var builder = WebApplication.CreateBuilder(args);
builder.WebHost.UseUrls(builder.Configuration.GetValue("Urls", "http://127.0.0.1:8181"));
builder.Logging.SetMinimumLevel(LogLevel.Information);

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

app.Run();
