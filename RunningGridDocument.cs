using Newtonsoft.Json;
using Newtonsoft.Json.Linq;
using SwarmUI.Utils;

namespace GridTweaks;

public class RunningGridDocument
{
    public string Id = Guid.NewGuid().ToString("N");
    public string Title;
    public JObject BaseParams;
    public List<RunningGridAxis> Axes = [];
    public Dictionary<string, string> Completed = [];
    public Dictionary<string, string> Presets = [];
    public string Format;
    public bool PublishMetadata = true;
    public bool WeightOrder = true;
    public bool ContinueOnError;
    public bool TrackModelChanges = true;
    public string Status = "Ready";
    public string Error;
    public bool SimilarityEnabled;
    public string SimilarityStatus = "Not analyzed";
    public Dictionary<string, string> CellSettings = [];
    public Dictionary<string, string> CellVersions = [];

    public static string Hash(string value) => Utilities.HashSHA256(Encoding.UTF8.GetBytes(value));

    public static string Identity(Dictionary<string, string> values)
        => Hash(JsonConvert.SerializeObject(new SortedDictionary<string, string>(values, StringComparer.Ordinal)));

    public static string Segment(RunningGridValue value) => $"v{value.Id}_{value.Revision}";

    public static bool Includes(string stem, int axisIndex, RunningGridValue value)
    {
        string[] parts = stem.Split('/');
        return axisIndex >= 0 && axisIndex < parts.Length && parts[axisIndex].StartsWith($"v{value.Id}_", StringComparison.Ordinal);
    }

    public void RemoveCell(string stem)
    {
        Completed.Remove(stem);
        CellSettings.Remove(stem);
        CellVersions.Remove(stem);
    }

    public void DiscardLegacyRemovedValues()
    {
        for (int i = 0; i < Axes.Count; i++)
        {
            List<RunningGridValue> removed = Axes[i].Values.Where(value => value.Removed).ToList();
            if (removed.Count == 0)
            {
                continue;
            }
            foreach (string stem in Completed.Keys.Where(stem => removed.Any(value => Includes(stem, i, value))).ToArray())
            {
                RemoveCell(stem);
            }
            Axes[i].Values.RemoveAll(value => value.Removed);
        }
    }

    public static int Merge(RunningGridAxis axis, IEnumerable<RunningGridValue> additions)
    {
        int added = 0;
        foreach (RunningGridValue value in additions)
        {
            if (axis.Values.Any(old => old.Id == value.Id))
            {
                continue;
            }
            axis.Values.Add(value);
            added++;
        }
        return added;
    }
}

public class RunningGridAxis
{
    public string Mode;
    public string Title;
    public List<RunningGridValue> Values = [];
}

public class RunningGridValue
{
    // Hash of normalized parameters before locking random seeds.
    public string Id;
    public string Title;
    public Dictionary<string, string> Params = [];
    public string Revision = "initial";
    public string Fingerprint;
    public bool Skip;
    [JsonProperty(DefaultValueHandling = DefaultValueHandling.Ignore)]
    public bool Removed;
}
