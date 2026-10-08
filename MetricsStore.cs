namespace MiniInspector;

public record DiskSample(float ReadBps, float WriteBps);
public record NetSample(float UpBps, float DownBps);
public record GpuSample(float CoreLoad, float MemUsedMb, float MemTotalMb, float TempC, float PowerW);

public record Sample(
    long Ts,
    float Cpu,
    float[] Cores,
    float MemUsedMb,
    float MemTotalMb,
    DiskSample Disk,
    NetSample Net,
    GpuSample? Gpu);

public sealed class MetricsStore
{
    private const int MaxCount = 100_000;

    private readonly object _gate = new();
    private readonly Queue<Sample> _samples = new();
    private readonly AppConfig _config;
    private Sample? _latest;

    public DateTimeOffset StartedAt { get; } = DateTimeOffset.UtcNow;

    public MetricsStore(AppConfig config)
    {
        _config = config;
    }

    public void Add(Sample sample)
    {
        lock (_gate)
        {
            _samples.Enqueue(sample);
            var cutoff = sample.Ts - _config.RetentionSeconds;
            while (_samples.Count > 0 && _samples.Peek().Ts < cutoff) _samples.Dequeue();
            while (_samples.Count > MaxCount) _samples.Dequeue();
            _latest = sample;
        }
    }

    public List<Sample> Since(long ts)
    {
        lock (_gate)
            return _samples.Where(s => s.Ts > ts).ToList();
    }

    public Sample? Latest()
    {
        lock (_gate)
            return _latest;
    }
}
