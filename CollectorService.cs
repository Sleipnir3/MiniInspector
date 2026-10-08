using LibreHardwareMonitor.Hardware;

namespace MiniInspector;

public sealed class CollectorService : BackgroundService
{
    private static readonly TimeSpan Tick = TimeSpan.FromSeconds(1);

    private readonly MetricsStore _store;
    private readonly ILogger<CollectorService> _log;
    private readonly UpdateVisitor _visitor = new();

    private Computer? _computer;
    private bool _warned;

    private ISensor? _cpuTotal;
    private readonly List<ISensor> _cores = new();
    private ISensor? _memUsed;
    private ISensor? _memAvail;
    private readonly List<ISensor> _diskRead = new();
    private readonly List<ISensor> _diskWrite = new();
    private readonly List<ISensor> _netUp = new();
    private readonly List<ISensor> _netDown = new();

    private ISensor? _gpuLoad;
    private ISensor? _gpuMemUsed;
    private ISensor? _gpuMemFree;
    private ISensor? _gpuMemTotal;
    private ISensor? _gpuTemp;
    private ISensor? _gpuPower;

    public string CpuName { get; private set; } = "Unknown CPU";
    public int CoreCount { get; private set; } = Environment.ProcessorCount;
    public string GpuName { get; private set; } = "";
    public bool GpuPresent => _gpuLoad is not null;

    public CollectorService(MetricsStore store, ILogger<CollectorService> log)
    {
        _store = store;
        _log = log;
    }

    protected override async Task ExecuteAsync(CancellationToken stoppingToken)
    {
        try
        {
            InitHardware();
        }
        catch (Exception ex)
        {
            _log.LogWarning(ex, "Hardware init failed; will retry every tick");
        }

        using var timer = new PeriodicTimer(Tick);
        while (await timer.WaitForNextTickAsync(stoppingToken))
        {
            try
            {
                if (_computer is null) InitHardware();
                Collect();
            }
            catch (Exception ex)
            {
                if (!_warned)
                {
                    _warned = true;
                    _log.LogWarning(ex, "Collection failed");
                }
            }
        }
    }

    private void InitHardware()
    {
        _computer = new Computer
        {
            IsCpuEnabled = true,
            IsGpuEnabled = true,
            IsMemoryEnabled = true,
            IsStorageEnabled = true,
            IsNetworkEnabled = true
        };
        _computer.Open();
        _computer.Accept(_visitor);
        FindSensors();
        _log.LogInformation("Hardware ready: {Cpu}, {Cores} cores, GPU: {Gpu}, {Sensors} sensors bound",
            CpuName, CoreCount, GpuPresent ? GpuName : "none",
            (_cpuTotal is null ? 0 : 1) + _cores.Count + _diskRead.Count + _netUp.Count);
    }

    private void FindSensors()
    {
        if (_computer is null) return;
        _cpuTotal = null;
        _cores.Clear();
        _memUsed = null;
        _memAvail = null;
        _diskRead.Clear();
        _diskWrite.Clear();
        _netUp.Clear();
        _netDown.Clear();
        _gpuLoad = null;
        _gpuMemUsed = null;
        _gpuMemFree = null;
        _gpuMemTotal = null;
        _gpuTemp = null;
        _gpuPower = null;
        GpuName = "";

        var all = AllHardware(_computer.Hardware).ToList();
        BindGpu(all.FirstOrDefault(h => h.HardwareType is HardwareType.GpuNvidia or HardwareType.GpuAmd)
                ?? all.FirstOrDefault(h => h.HardwareType is HardwareType.GpuIntel));

        foreach (var hardware in all)
        {
            switch (hardware.HardwareType)
            {
                case HardwareType.Cpu:
                    CpuName = hardware.Name;
                    foreach (var s in hardware.Sensors)
                    {
                        if (s.SensorType != SensorType.Load) continue;
                        if (s.Name == "CPU Total") _cpuTotal = s;
                        else if (s.Name.StartsWith("CPU Core #")) _cores.Add(s);
                    }
                    break;
                case HardwareType.Memory:
                    foreach (var s in hardware.Sensors)
                    {
                        if (s.SensorType != SensorType.Data) continue;
                        if (s.Name == "Memory Used") _memUsed = s;
                        else if (s.Name == "Memory Available") _memAvail = s;
                    }
                    break;
                case HardwareType.Storage:
                    foreach (var s in hardware.Sensors)
                    {
                        if (s.SensorType != SensorType.Throughput) continue;
                        if (s.Name == "Read Rate") _diskRead.Add(s);
                        else if (s.Name == "Write Rate") _diskWrite.Add(s);
                    }
                    break;
                case HardwareType.Network:
                    foreach (var s in hardware.Sensors)
                    {
                        if (s.SensorType != SensorType.Throughput) continue;
                        if (s.Name == "Upload Speed") _netUp.Add(s);
                        else if (s.Name == "Download Speed") _netDown.Add(s);
                    }
                    break;
            }
        }

        if (_cores.Count > 0) CoreCount = _cores.Count;
    }

    private void BindGpu(IHardware? gpu)
    {
        if (gpu is null) return;
        GpuName = gpu.Name;
        foreach (var s in gpu.Sensors)
        {
            switch (s.SensorType)
            {
                case SensorType.Load when s.Name == "GPU Core":
                    _gpuLoad = s;
                    break;
                case SensorType.Data or SensorType.SmallData when s.Name == "GPU Memory Used":
                    _gpuMemUsed = s;
                    break;
                case SensorType.Data or SensorType.SmallData when s.Name == "GPU Memory Free":
                    _gpuMemFree = s;
                    break;
                case SensorType.Data or SensorType.SmallData when s.Name == "GPU Memory Total":
                    _gpuMemTotal = s;
                    break;
                case SensorType.Temperature when s.Name == "GPU Core":
                    _gpuTemp = s;
                    break;
                case SensorType.Power when s.Name is "GPU Package" or "GPU Power":
                    _gpuPower ??= s;
                    break;
            }
        }
    }

    private static IEnumerable<IHardware> AllHardware(IEnumerable<IHardware> roots)
    {
        foreach (var hw in roots)
        {
            yield return hw;
            foreach (var sub in AllHardware(hw.SubHardware))
                yield return sub;
        }
    }

    private void Collect()
    {
        if (_computer is null) return;
        _computer.Accept(_visitor);

        float cpu = _cpuTotal?.Value ?? -1f;
        float[] cores = _cores.Select(s => s.Value ?? 0f).ToArray();

        float memUsedMb = -1f, memTotalMb = -1f;
        if (_memUsed?.Value is float used)
        {
            memUsedMb = used * 1024f;
            if (_memAvail?.Value is float avail)
                memTotalMb = (used + avail) * 1024f;
        }

        GpuSample? gpu = null;
        if (GpuPresent)
        {
            float gMemUsed = -1f, gMemTotal = -1f;
            if (_gpuMemUsed?.Value is float gUsed)
            {
                gMemUsed = gUsed;
                if (_gpuMemTotal?.Value is float gTotal) gMemTotal = gTotal;
                else if (_gpuMemFree?.Value is float gFree) gMemTotal = gUsed + gFree;
            }
            gpu = new GpuSample(
                _gpuLoad?.Value ?? -1f,
                gMemUsed,
                gMemTotal,
                _gpuTemp?.Value ?? -1f,
                _gpuPower?.Value ?? -1f);
        }

        var sample = new Sample(
            DateTimeOffset.UtcNow.ToUnixTimeSeconds(),
            cpu,
            cores,
            memUsedMb,
            memTotalMb,
            new DiskSample(Sum(_diskRead), Sum(_diskWrite)),
            new NetSample(Sum(_netUp), Sum(_netDown)),
            gpu);

        _store.Add(sample);
    }

    private static float Sum(IEnumerable<ISensor> sensors)
        => sensors.Sum(s => s.Value ?? 0f);

    public object BuildStatus()
    {
        var drives = DriveInfo.GetDrives()
            .Where(d => d.IsReady && d.DriveType == DriveType.Fixed)
            .Select(d => new
            {
                name = d.Name,
                total_mb = Math.Round(d.TotalSize / 1048576.0, 1),
                used_mb = Math.Round((d.TotalSize - d.AvailableFreeSpace) / 1048576.0, 1)
            })
            .ToArray();

        return new
        {
            started_at = _store.StartedAt.ToUnixTimeSeconds(),
            uptime_s = (long)(DateTimeOffset.UtcNow - _store.StartedAt).TotalSeconds,
            os = Environment.OSVersion.VersionString,
            machine = Environment.MachineName,
            cpu = CpuName,
            cores = CoreCount,
            gpu = GpuName,
            gpu_present = GpuPresent,
            latest = _store.Latest(),
            drives
        };
    }

    public override void Dispose()
    {
        _computer?.Close();
        base.Dispose();
    }

    private sealed class UpdateVisitor : IVisitor
    {
        public void VisitComputer(IComputer computer) => computer.Traverse(this);
        public void VisitHardware(IHardware hardware)
        {
            hardware.Update();
            foreach (var sub in hardware.SubHardware) sub.Accept(this);
        }
        public void VisitSensor(ISensor sensor) { }
        public void VisitParameter(IParameter parameter) { }
    }
}
