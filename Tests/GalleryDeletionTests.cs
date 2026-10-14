using Newtonsoft.Json.Linq;
using SwarmUI.Accounts;
using SwarmUI.Core;
using SwarmUI.Utils;
using SwarmUI.WebAPI;
using Xunit;
using static SwarmUI.Builtin_GridGeneratorExtension.GridGeneratorExtension;

namespace GridTweaks.Tests;

public partial class RunningGridTests
{
    [Theory]
    [InlineData(true, false)]
    [InlineData(true, true)]
    [InlineData(false, false)]
    [InlineData(false, true)]
    public async Task RemovingColumnClearsHostMetadataAndPreviews(bool perFolder, bool reopenCache)
    {
        bool originalPerFolder = Program.ServerSettings.Metadata.ImageMetadataPerFolder;
        string originalDataDir = Program.DataDir;
        var originalDatabases = OutputMetadataTracker.Databases;
        Program.ServerSettings.Metadata.ImageMetadataPerFolder = perFolder;
        Program.DataDir = Path.Combine(temporary, "metadata");
        Directory.CreateDirectory(Program.DataDir);
        OutputMetadataTracker.Databases = new();
        try
        {
            string id = await Capture();
            JObject state = await Run(id);
            string folder = Path.GetDirectoryName(Path.Combine(temporary, ((string)state["summary"]["url"])["Output/".Length..]));
            string valueId = (string)state["gallery"]["Axes"][0]["Values"][0]["Id"];
            JProperty[] cells = ((JObject)state["gallery"]["Completed"]).Properties().ToArray();
            JProperty removedCell = cells.First(cell => cell.Name.StartsWith($"v{valueId}_"));
            JProperty retainedCell = cells.First(cell => !cell.Name.StartsWith($"v{valueId}_"));
            string removed = Path.GetFullPath(Path.Combine(folder, $"{removedCell.Name}.{removedCell.Value}")).Replace('\\', '/');
            string retained = Path.GetFullPath(Path.Combine(folder, $"{retainedCell.Name}.{retainedCell.Value}")).Replace('\\', '/');
            foreach (string file in new[] { removed, retained })
            {
                var cache = OutputMetadataTracker.GetDatabaseForFolder(Path.GetDirectoryName(file));
                string key = perFolder ? Path.GetFileName(file) : file;
                cache.Metadata.Insert(new OutputMetadataTracker.OutputMetadataEntry { FileName = key, Metadata = "cached metadata", LastVerified = DateTimeOffset.UtcNow.ToUnixTimeSeconds() });
                cache.Previews.Insert(new OutputMetadataTracker.OutputPreviewEntry { FileName = key, PreviewData = [1, 2, 3], LastVerified = DateTimeOffset.UtcNow.ToUnixTimeSeconds() });
            }
            if (reopenCache)
            {
                OutputMetadataTracker.Shutdown();
            }

            JObject result = await GridTweaksExtension.RunningGridMembership(session, id, [valueId]);

            Assert.Null(result["error"]);
            Assert.False(File.Exists(removed));
            Assert.True(File.Exists(retained));
            foreach (string file in new[] { removed, retained })
            {
                Assert.True(File.Exists(Path.Combine(perFolder ? Path.GetDirectoryName(file) : Program.DataDir, "swarm_metadata.ldb")));
                var cache = OutputMetadataTracker.GetDatabaseForFolder(Path.GetDirectoryName(file));
                string key = perFolder ? Path.GetFileName(file) : file;
                Assert.Equal(file == retained, cache.Metadata.FindById(key) is not null);
                Assert.Equal(file == retained, cache.Previews.FindById(key) is not null);
            }
        }
        finally
        {
            OutputMetadataTracker.Shutdown();
            OutputMetadataTracker.Databases = originalDatabases;
            Program.DataDir = originalDataDir;
            Program.ServerSettings.Metadata.ImageMetadataPerFolder = originalPerFolder;
        }
    }

    [Fact]
    public async Task DeleteGalleryRemovesAllOwnedFilesAndKeepsOtherGalleriesAndSharedAssets()
    {
        string id = await Capture();
        JObject state = await Run(id);
        string otherId = await Capture();
        JObject other = await Run(otherId);
        string folder = Path.GetDirectoryName(Path.Combine(temporary, ((string)state["summary"]["url"])["Output/".Length..]));
        string otherPage = Path.Combine(temporary, ((string)other["summary"]["url"])["Output/".Length..]);
        File.WriteAllText(Path.Combine(folder, "superseded-revision.webp"), "old image");
        string cacheRoot = Path.Combine(GridTweaksExtension.SimilarityExtensionFolder, ".cache", "similarity");
        string cache = Path.Combine(cacheRoot, RunningGridDocument.Hash(session.User.UserID), id);
        Directory.CreateDirectory(cache);
        File.WriteAllText(Path.Combine(cache, "result.json"), "{}");
        File.WriteAllText(Path.Combine(cacheRoot, "shared-weights.pth"), "shared weights");
        string otherCache = Path.Combine(cacheRoot, RunningGridDocument.Hash(session.User.UserID), otherId);
        Directory.CreateDirectory(otherCache);
        File.WriteAllText(Path.Combine(otherCache, "result.json"), "{}");

        JObject deleted = await GridTweaksExtension.RunningGridDelete(session, id);

        Assert.True((bool)deleted["success"]);
        Assert.False(Directory.Exists(folder));
        Assert.False(Directory.Exists(cache));
        Assert.Null(session.User.GetGenericData("running_grid_v1", id));
        Assert.Equal(otherId, (string)Assert.Single((await GridTweaksExtension.RunningGridList(session))["galleries"])["id"]);
        Assert.True(File.Exists(otherPage));
        Assert.True(File.Exists(Path.Combine(otherCache, "result.json")));
        Assert.True(File.Exists(Path.Combine(cacheRoot, "shared-weights.pth")));
    }

    [Fact]
    public async Task DeleteGalleryWorksBeforeAnyImagesOrPageWereGenerated()
    {
        string id = await Capture();
        Assert.True((bool)(await GridTweaksExtension.RunningGridDelete(session, id))["success"]);
        Assert.Empty((await GridTweaksExtension.RunningGridList(session))["galleries"]);
        Assert.Empty(generated);
    }

    [Fact]
    public void DeleteGalleryRegistersSavePermission()
    {
        var originalHandlers = API.APIHandlers;
        string originalExtensionFolder = GridTweaksExtension.SimilarityExtensionFolder;
        API.APIHandlers = [];
        try
        {
            new GridTweaksExtension { FilePath = originalExtensionFolder }.OnInit();
            Assert.Equal(PermSaveGrids, API.APIHandlers["runninggriddelete"].Permission);
        }
        finally
        {
            API.APIHandlers = originalHandlers;
            GridTweaksExtension.SimilarityExtensionFolder = originalExtensionFolder;
        }
    }

    [Fact]
    public async Task DeleteGalleryRequiresAdditionalImageDeletionPermission()
    {
        string id = await Capture();
        JObject state = await Run(id);
        string page = Path.Combine(temporary, ((string)state["summary"]["url"])["Output/".Length..]);
        session.User.CalculatedRole.Data.PermissionFlags = [PermSaveGrids.ID];

        Assert.Contains("User Delete Image permission", (string)(await GridTweaksExtension.RunningGridDelete(session, id))["error"]);
        Assert.NotNull(session.User.GetGenericData("running_grid_v1", id));
        Assert.True(File.Exists(page));
    }

    [Fact]
    public async Task DeleteGalleryRejectsOtherOwnersAndInvalidPathsWithoutDeletingFiles()
    {
        string id = await Capture();
        JObject state = await Run(id);
        string page = Path.Combine(temporary, ((string)state["summary"]["url"])["Output/".Length..]);
        User other = new(session.User.SessionHandlerSource, new User.DatabaseEntry { ID = "another-user" });
        other.CalculatedRole = session.User.CalculatedRole;

        Assert.NotNull((await GridTweaksExtension.RunningGridDelete(new Session { User = other }, id))["error"]);
        Assert.NotNull((await GridTweaksExtension.RunningGridDelete(session, "../" + id))["error"]);
        Assert.NotNull(session.User.GetGenericData("running_grid_v1", id));
        Assert.True(File.Exists(page));
    }

    [Fact]
    public async Task DeleteGalleryRejectsLinkedParentAndKeepsEntryForRetry()
    {
        if (OperatingSystem.IsWindows())
        {
            return; // Symlinks require privileges that ordinary Windows test users may not have.
        }
        string id = await Capture();
        string root = Path.Combine(temporary, "Grids", "RunningGrid");
        string outside = Path.Combine(temporary, "unrelated");
        Directory.CreateDirectory(root);
        Directory.CreateDirectory(Path.Combine(outside, id));
        string keep = Path.Combine(outside, id, "keep.webp");
        File.WriteAllText(keep, "unrelated image");
        string link = Path.Combine(root, RunningGridDocument.Hash(session.User.UserID));
        Directory.CreateSymbolicLink(link, outside);
        try
        {
            Assert.Contains("linked directory", (string)(await GridTweaksExtension.RunningGridDelete(session, id))["error"]);
            Assert.NotNull(session.User.GetGenericData("running_grid_v1", id));
            Assert.True(File.Exists(keep));
        }
        finally
        {
            Directory.Delete(link);
        }
        Assert.True((bool)(await GridTweaksExtension.RunningGridDelete(session, id))["success"]);
        Assert.True(File.Exists(keep));
    }
}
