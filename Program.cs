using System.Diagnostics;
using System.Text.Json;
using MiniInspector;

var builder = WebApplication.CreateBuilder(args);

var configPath = Path.Combine(builder.Environment.ContentRootPath, "config.json");
var config = AppConfig.Load(configPath);

bool createdNew;
Mutex instanceMutex;
try
{
    instanceMutex = new Mutex(true, @"Global\MiniInspector.SingleInstance", out createdNew);
}
catch (UnauthorizedAccessException)
{
    instanceMutex = new Mutex(true, "MiniInspector.SingleInstance", out createdNew);
}
using (instanceMutex)
{
    if (!createdNew)
    {
        var acquired = false;
        if (args.Contains("--restarting"))
        {
            // spawned by a running instance that is about to exit; wait for the handoff
            var deadline = DateTime.UtcNow.AddSeconds(15);
            while (!acquired && DateTime.UtcNow < deadline)
            {
                try
                {
                    acquired = instanceMutex.WaitOne(500);
                }
                catch (AbandonedMutexException)
                {
                    acquired = true;
                }
            }
        }
        if (!acquired)
        {
            Console.Error.WriteLine("MiniInspector is already running.");
            return 1;
        }
    }

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

app.MapPost("/api/restart", (IHostApplicationLifetime lifetime) =>
{
    _ = Task.Run(async () =>
    {
        await Task.Delay(500);
        SpawnSelf(app.Environment.ContentRootPath);
        lifetime.StopApplication();
    });
    return Results.Json(new { ok = true, action = "restart" }, json);
});

app.MapPost("/api/shutdown", (IHostApplicationLifetime lifetime) =>
{
    _ = Task.Run(async () =>
    {
        await Task.Delay(500);
        lifetime.StopApplication();
    });
    return Results.Json(new { ok = true, action = "shutdown" }, json);
});

    for (var attempt = 0; ; attempt++)
    {
        try
        {
            app.Run();
            break;
        }
        catch (IOException) when (attempt < 5)
        {
            // port still held by the previous instance during restart
            Thread.Sleep(1000);
        }
    }
    return 0;
}

static void SpawnSelf(string workingDirectory)
{
    var processPath = Environment.ProcessPath!;
    var cmdArgs = Environment.GetCommandLineArgs();
    var isDotnetHost = Path.GetFileNameWithoutExtension(processPath)
        .Equals("dotnet", StringComparison.OrdinalIgnoreCase);

    var psi = new ProcessStartInfo
    {
        FileName = processPath,
        WorkingDirectory = workingDirectory,
        UseShellExecute = false,
        CreateNoWindow = true,
        WindowStyle = ProcessWindowStyle.Hidden
    };
    foreach (var arg in cmdArgs.Skip(isDotnetHost ? 0 : 1))
        psi.ArgumentList.Add(arg);
    if (!psi.ArgumentList.Contains("--restarting"))
        psi.ArgumentList.Add("--restarting");
    Process.Start(psi);
}
