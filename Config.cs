using System.Text.Json;
using System.Text.Json.Serialization;

namespace MiniInspector;

public sealed record ConfigUpdate(int? Port, int? RetentionSeconds, int? IntervalMs);

public sealed class AppConfig
{
    private readonly object _gate = new();
    private readonly string _path;

    public int Port { get; private set; } = 8181;
    public int RetentionSeconds { get; private set; } = 3600;
    public int IntervalMs { get; private set; } = 1000;

    private static readonly JsonSerializerOptions Json = new() { WriteIndented = true };

    private AppConfig(string path) => _path = path;

    public static AppConfig Load(string path)
    {
        var config = new AppConfig(path);
        try
        {
            if (File.Exists(path))
            {
                var dto = JsonSerializer.Deserialize<Dto>(File.ReadAllText(path));
                if (dto is not null)
                {
                    config.Apply(
                        dto.Port > 0 ? dto.Port : null,
                        dto.RetentionSeconds > 0 ? dto.RetentionSeconds : null,
                        dto.IntervalMs > 0 ? dto.IntervalMs : null);
                }
            }
        }
        catch
        {
            // keep defaults on malformed config
        }
        return config;
    }

    public bool Update(int? port, int? retentionSeconds, int? intervalMs)
    {
        bool restartRequired;
        lock (_gate)
        {
            restartRequired = port is int p && p != Port;
            Apply(port, retentionSeconds, intervalMs);
            Save();
        }
        return restartRequired;
    }

    private void Apply(int? port, int? retentionSeconds, int? intervalMs)
    {
        if (port is int p) Port = Math.Clamp(p, 1, 65535);
        if (retentionSeconds is int r) RetentionSeconds = Math.Clamp(r, 60, 86400);
        if (intervalMs is int i) IntervalMs = Math.Clamp(i, 100, 60000);
    }

    private void Save()
    {
        var dto = new Dto
        {
            Port = Port,
            RetentionSeconds = RetentionSeconds,
            IntervalMs = IntervalMs
        };
        File.WriteAllText(_path, System.Text.Json.JsonSerializer.Serialize(dto, Json));
    }

    private sealed class Dto
    {
        [JsonPropertyName("port")] public int Port { get; set; }
        [JsonPropertyName("retention_seconds")] public int RetentionSeconds { get; set; }
        [JsonPropertyName("interval_ms")] public int IntervalMs { get; set; }
    }
}
