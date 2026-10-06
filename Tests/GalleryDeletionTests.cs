using Newtonsoft.Json.Linq;
using SwarmUI.Accounts;
using Xunit;

namespace GridTweaks.Tests;

public partial class RunningGridTests
{
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
        Assert.NotNull((await GridTweaksExtension.RunningGridGet(session, id, includeOutputs: true))["error"]);
        Assert.NotNull((await GridTweaksExtension.RunningGridRun(session, id))["error"]);
        Assert.Equal(otherId, (string)Assert.Single((await GridTweaksExtension.RunningGridList(session))["galleries"])["id"]);
        Assert.True(File.Exists(otherPage));
        Assert.True(File.Exists(Path.Combine(otherCache, "result.json")));
        Assert.True(File.Exists(Path.Combine(cacheRoot, "shared-weights.pth")));
        Assert.All(models.Models.Values, model => Assert.True(File.Exists(model.RawFilePath)));
        Assert.Equal(48, generated.Count);
    }

    [Fact]
    public async Task DeleteGalleryWorksBeforeAnyImagesOrPageWereGenerated()
    {
        string id = await Capture();
        Assert.True((bool)(await GridTweaksExtension.RunningGridDelete(session, id))["success"]);
        Assert.Empty((await GridTweaksExtension.RunningGridList(session))["galleries"]);
        Assert.NotNull((await GridTweaksExtension.RunningGridDelete(session, id))["error"]);
        Assert.Empty(generated);
    }

    [Theory]
    [InlineData("gridgen_save_grids")]
    [InlineData("user_delete_image")]
    public async Task DeleteGalleryRequiresBothSaveAndImageDeletionPermissions(string onlyPermission)
    {
        string id = await Capture();
        JObject state = await Run(id);
        string page = Path.Combine(temporary, ((string)state["summary"]["url"])["Output/".Length..]);
        session.User.CalculatedRole.Data.PermissionFlags = [onlyPermission];

        Assert.Contains("permissions", (string)(await GridTweaksExtension.RunningGridDelete(session, id))["error"]);
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
